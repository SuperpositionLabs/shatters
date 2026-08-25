package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a lookup yields no row. It deliberately hides
// whether the identifier was malformed or unknown.
var ErrNotFound = errors.New("db: not found")

// ChallengeTTL is how long an authentication nonce stays valid.
const ChallengeTTL = 5 * time.Minute

// SessionTTL is the lifetime of a session token.
const SessionTTL = 24 * time.Hour

// AccountLookup is the minimal identity material needed to verify proofs.
type AccountLookup struct {
	ID          [16]byte
	PublicID    string
	IdentityKey []byte
}

// AccountByPublicID resolves an opaque account ID to its verification key.
func AccountByPublicID(ctx context.Context, pool *pgxpool.Pool, publicID string) (AccountLookup, error) {
	var a AccountLookup
	err := pool.QueryRow(ctx,
		`SELECT id, public_id, identity_key FROM accounts WHERE public_id = $1`,
		publicID).Scan(&a.ID, &a.PublicID, &a.IdentityKey)
	if err != nil {
		if err == pgx.ErrNoRows {
			return AccountLookup{}, ErrNotFound
		}
		return AccountLookup{}, fmt.Errorf("db: account by public id: %w", err)
	}
	return a, nil
}

// CreateChallenge stores a single-use authentication nonce for an account.
func CreateChallenge(ctx context.Context, pool *pgxpool.Pool, accountID [16]byte, nonce []byte) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO auth_challenges (nonce, account_id, expires_at)
		 VALUES ($1, $2, $3)`,
		nonce, accountID[:], time.Now().Add(ChallengeTTL))
	if err != nil {
		return fmt.Errorf("db: create challenge: %w", err)
	}
	return nil
}

// ConsumeChallenge deletes the nonce row and reports whether it existed and
// was unexpired. Deletion makes replay impossible regardless of outcome.
func ConsumeChallenge(ctx context.Context, pool *pgxpool.Pool, accountID [16]byte, nonce []byte) (bool, error) {
	tag, err := pool.Exec(ctx,
		`DELETE FROM auth_challenges
		 WHERE nonce = $1 AND account_id = $2 AND expires_at > now()`,
		nonce, accountID[:])
	if err != nil {
		return false, fmt.Errorf("db: consume challenge: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// CreateSessionToken persists only the SHA-256 hash of a session token.
func CreateSessionToken(ctx context.Context, pool *pgxpool.Pool, accountID [16]byte, tokenHash []byte) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO session_tokens (token_hash, account_id, expires_at)
		 VALUES ($1, $2, $3)`,
		tokenHash, accountID[:], time.Now().Add(SessionTTL))
	if err != nil {
		return fmt.Errorf("db: create session token: %w", err)
	}
	return nil
}

// AccountIDByTokenHash resolves a hashed bearer token to its account.
// Expired tokens never match.
func AccountIDByTokenHash(ctx context.Context, pool *pgxpool.Pool, tokenHash []byte) (AccountLookup, error) {
	var a AccountLookup
	err := pool.QueryRow(ctx,
		`SELECT a.id, a.public_id, a.identity_key
		 FROM session_tokens t JOIN accounts a ON a.id = t.account_id
		 WHERE t.token_hash = $1 AND t.expires_at > now()`,
		tokenHash).Scan(&a.ID, &a.PublicID, &a.IdentityKey)
	if err != nil {
		if err == pgx.ErrNoRows {
			return AccountLookup{}, ErrNotFound
		}
		return AccountLookup{}, fmt.Errorf("db: account by token: %w", err)
	}
	return a, nil
}
