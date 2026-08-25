package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxStoredPrekeysPerAccount bounds how many unconsumed one-time prekeys an
// account may hold at once.
const MaxStoredPrekeysPerAccount = 200

// Bundle is the public material a peer needs to start a session (X3DH).
type Bundle struct {
	IdentityKey   []byte
	IdentityDHKey []byte
	SignedPrekey  SignedPrekey
	OneTimePrekey *Prekey // nil when the account is out of one-time prekeys
}

// AddOneTimePrekeys inserts new one-time prekeys, enforcing the per-account
// storage cap. Duplicate keys (already stored) are ignored silently.
func AddOneTimePrekeys(ctx context.Context, pool *pgxpool.Pool, accountID [16]byte, keys []Prekey) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("db: begin add prekeys: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	// Lock every existing row for the account so concurrent uploads serialize
	// on the cap check. Aggregates cannot take FOR UPDATE directly, so rows
	// are selected individually and counted here.
	rows, err := tx.Query(ctx,
		`SELECT ctid FROM one_time_prekeys WHERE account_id = $1 FOR UPDATE`,
		accountID[:])
	if err != nil {
		return fmt.Errorf("db: lock prekeys: %w", err)
	}
	n := 0
	for rows.Next() {
		n++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("db: scan prekey locks: %w", err)
	}
	if n+len(keys) > MaxStoredPrekeysPerAccount {
		return fmt.Errorf("db: prekey cap exceeded (%d stored + %d new > %d)",
			n, len(keys), MaxStoredPrekeysPerAccount)
	}

	for _, k := range keys {
		if _, err := tx.Exec(ctx,
			`INSERT INTO one_time_prekeys (account_id, id, public_key)
			 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			accountID[:], int(k.ID), k.PublicKey); err != nil {
			return fmt.Errorf("db: insert prekey: %w", err)
		}
	}

	return tx.Commit(ctx)
}

// FetchBundle returns the account bundle and atomically consumes one
// one-time prekey. Under concurrency each key is delivered to exactly one
// caller; when none remain the field stays nil and the caller falls back to
// the signed prekey.
func FetchBundle(ctx context.Context, pool *pgxpool.Pool, publicID string) (Bundle, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Bundle{}, fmt.Errorf("db: begin fetch bundle: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var (
		b       Bundle
		account [16]byte
		spkID   uint32
		otkID   uint32
		otkPub  []byte
	)
	err = tx.QueryRow(ctx,
		`SELECT a.id, a.identity_key, a.identity_dh_key,
		        sp.id, sp.public_key, sp.signature
		 FROM accounts a
		 JOIN signed_prekeys sp ON sp.account_id = a.id
		 WHERE a.public_id = $1
		 ORDER BY sp.created_at DESC
		 LIMIT 1`,
		publicID).Scan(
		&account, &b.IdentityKey, &b.IdentityDHKey,
		&spkID, &b.SignedPrekey.PublicKey, &b.SignedPrekey.Signature)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Bundle{}, ErrNotFound
		}
		return Bundle{}, fmt.Errorf("db: fetch bundle: %w", err)
	}
	b.SignedPrekey.ID = spkID

	err = tx.QueryRow(ctx,
		`DELETE FROM one_time_prekeys
		 WHERE ctid IN (
		     SELECT ctid FROM one_time_prekeys
		     WHERE account_id = $1
		     ORDER BY ctid
		     FOR UPDATE SKIP LOCKED
		     LIMIT 1
		 )
		 RETURNING id, public_key`,
		account[:]).Scan(&otkID, &otkPub)
	switch {
	case err == nil:
		b.OneTimePrekey = &Prekey{ID: otkID, PublicKey: otkPub}
	case errors.Is(err, pgx.ErrNoRows):
		b.OneTimePrekey = nil
	default:
		return Bundle{}, fmt.Errorf("db: consume prekey: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return Bundle{}, fmt.Errorf("db: commit fetch bundle: %w", err)
	}
	return b, nil
}
