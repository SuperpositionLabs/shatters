package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxEnvelopeBytes mirrors the CHECK constraint on envelopes.payload. Enforcing
// it in application code too turns an oversized submission into a 4xx instead
// of a constraint violation surfacing as a 500.
const MaxEnvelopeBytes = 65536

// EnvelopeTTL is how long an undelivered envelope survives (protocol §9).
const EnvelopeTTL = 30 * 24 * time.Hour

// MaxEnvelopesPerFetch bounds one fetch so a client with a large backlog
// drains it across several requests instead of one unbounded response.
const MaxEnvelopesPerFetch = 100

// MaxQueuedPerRecipient bounds how many undelivered envelopes one account may
// accumulate. Without a cap, anyone could exhaust the server's disk by sending
// to an account that never comes online.
const MaxQueuedPerRecipient = 10000

// ErrRecipientQueueFull reports that the recipient is at MaxQueuedPerRecipient.
var ErrRecipientQueueFull = errors.New("db: recipient envelope queue is full")

// ErrEnvelopeTooLarge reports a payload above MaxEnvelopeBytes.
var ErrEnvelopeTooLarge = errors.New("db: envelope payload exceeds the size cap")

// Envelope is one stored opaque blob awaiting delivery.
//
// The server never interprets Payload; it is ciphertext produced and consumed
// entirely by clients (docs/protocol.md §9).
type Envelope struct {
	ID             [16]byte
	SenderPublicID string
	Payload        []byte
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

// StoreEnvelope queues a blob for a recipient identified by its opaque public
// ID, returning the new envelope ID.
//
// senderID comes from the authenticated session rather than the request body,
// so a client cannot attribute a message to someone else.
func StoreEnvelope(ctx context.Context, pool *pgxpool.Pool, senderID [16]byte, recipientPublicID string, payload []byte) ([16]byte, error) {
	var id [16]byte

	if len(payload) == 0 {
		return id, fmt.Errorf("db: empty envelope payload")
	}
	if len(payload) > MaxEnvelopeBytes {
		return id, ErrEnvelopeTooLarge
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return id, fmt.Errorf("db: begin store envelope: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var recipient [16]byte
	err = tx.QueryRow(ctx,
		`SELECT id FROM accounts WHERE public_id = $1`,
		recipientPublicID).Scan(&recipient)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return id, ErrNotFound
		}
		return id, fmt.Errorf("db: resolve recipient: %w", err)
	}

	// Only live envelopes count towards the cap: expired rows are already
	// invisible to the recipient and will be swept.
	var queued int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM envelopes
		 WHERE recipient_id = $1 AND expires_at > now()`,
		recipient[:]).Scan(&queued); err != nil {
		return id, fmt.Errorf("db: count queued envelopes: %w", err)
	}
	if queued >= MaxQueuedPerRecipient {
		return id, ErrRecipientQueueFull
	}

	err = tx.QueryRow(ctx,
		`INSERT INTO envelopes (sender_id, recipient_id, payload, expires_at)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id`,
		senderID[:], recipient[:], payload, time.Now().Add(EnvelopeTTL)).Scan(&id)
	if err != nil {
		return id, fmt.Errorf("db: insert envelope: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return id, fmt.Errorf("db: commit store envelope: %w", err)
	}
	return id, nil
}

// FetchEnvelopes returns up to MaxEnvelopesPerFetch undelivered envelopes for
// the recipient, oldest first.
//
// Fetching does not delete: the rows stay until acknowledged, so a client that
// dies mid-transfer sees them again rather than losing them. It is therefore
// idempotent, and repeated calls return the same set.
func FetchEnvelopes(ctx context.Context, pool *pgxpool.Pool, recipientID [16]byte) ([]Envelope, error) {
	rows, err := pool.Query(ctx,
		`SELECT e.id, a.public_id, e.payload, e.created_at, e.expires_at
		 FROM envelopes e JOIN accounts a ON a.id = e.sender_id
		 WHERE e.recipient_id = $1 AND e.expires_at > now()
		 ORDER BY e.created_at, e.id
		 LIMIT $2`,
		recipientID[:], MaxEnvelopesPerFetch)
	if err != nil {
		return nil, fmt.Errorf("db: fetch envelopes: %w", err)
	}
	defer rows.Close()

	envelopes := make([]Envelope, 0, MaxEnvelopesPerFetch)
	for rows.Next() {
		var e Envelope
		if err := rows.Scan(&e.ID, &e.SenderPublicID, &e.Payload, &e.CreatedAt, &e.ExpiresAt); err != nil {
			return nil, fmt.Errorf("db: scan envelope: %w", err)
		}
		envelopes = append(envelopes, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("db: iterate envelopes: %w", err)
	}

	// Record that the recipient has seen them; purely informational, and never
	// used to hide an envelope from a later fetch.
	if len(envelopes) > 0 {
		ids := make([][]byte, 0, len(envelopes))
		for i := range envelopes {
			ids = append(ids, envelopes[i].ID[:])
		}
		if _, err := pool.Exec(ctx,
			`UPDATE envelopes SET fetched_at = now()
			 WHERE id = ANY($1) AND fetched_at IS NULL`, ids); err != nil {
			return nil, fmt.Errorf("db: mark envelopes fetched: %w", err)
		}
	}

	return envelopes, nil
}

// AcknowledgeEnvelopes deletes the named envelopes and reports how many were
// removed.
//
// The recipient predicate is what enforces ownership: an id belonging to
// another account simply matches nothing, so a caller learns nothing about
// envelopes that are not theirs.
func AcknowledgeEnvelopes(ctx context.Context, pool *pgxpool.Pool, recipientID [16]byte, ids [][16]byte) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}

	raw := make([][]byte, 0, len(ids))
	for i := range ids {
		raw = append(raw, ids[i][:])
	}

	tag, err := pool.Exec(ctx,
		`DELETE FROM envelopes WHERE recipient_id = $1 AND id = ANY($2)`,
		recipientID[:], raw)
	if err != nil {
		return 0, fmt.Errorf("db: acknowledge envelopes: %w", err)
	}
	return tag.RowsAffected(), nil
}

// DeleteExpiredEnvelopes removes envelopes past their TTL and returns the
// number swept. Expired rows are already invisible to readers; this only
// reclaims storage.
func DeleteExpiredEnvelopes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, `DELETE FROM envelopes WHERE expires_at <= now()`)
	if err != nil {
		return 0, fmt.Errorf("db: delete expired envelopes: %w", err)
	}
	return tag.RowsAffected(), nil
}
