package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxPrekeysPerRequest caps one-time prekey uploads (registration included).
const MaxPrekeysPerRequest = 100

// Prekey is one uploaded X25519 public half-key.
type Prekey struct {
	ID        uint32
	PublicKey []byte
}

// SignedPrekey is an account's long-lived signed prekey material (public side).
type SignedPrekey struct {
	ID        uint32
	PublicKey []byte
	Signature []byte
}

// CreateAccountParams carries everything needed to open an account.
type CreateAccountParams struct {
	PublicID      string // opaque account identifier derived in application code
	IdentityKey   []byte // Ed25519 public
	IdentityDHKey []byte // X25519 public
	// Ed25519 signature over "shatters-idk-v1" || IdentityDHKey, binding the
	// DH key to the identity that published it.
	IdentityDHSignature []byte
	SignedPrekey        SignedPrekey
	OneTimePrekeys      []Prekey
}

// CreateAccount inserts an account with its initial prekeys atomically.
// It is idempotent on IdentityKey: when the account already exists the stored
// identifier is returned with created=false and no prekey rows are touched.
func CreateAccount(ctx context.Context, pool *pgxpool.Pool, p CreateAccountParams) (publicID string, created bool, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", false, fmt.Errorf("db: begin create account: %w", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	var id [16]byte
	err = tx.QueryRow(ctx,
		`INSERT INTO accounts (identity_key, identity_dh_key, identity_dh_signature, public_id)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (identity_key) DO NOTHING
		 RETURNING id`,
		p.IdentityKey, p.IdentityDHKey, p.IdentityDHSignature, p.PublicID).Scan(&id)
	if err != nil {
		if !errIsNoRows(err) {
			return "", false, fmt.Errorf("db: insert account: %w", err)
		}
		// Existing account: report its stable public ID, change nothing.
		if err := tx.QueryRow(ctx,
			`SELECT public_id FROM accounts WHERE identity_key = $1`,
			p.IdentityKey).Scan(&publicID); err != nil {
			return "", false, fmt.Errorf("db: select existing account: %w", err)
		}
		return publicID, false, tx.Commit(ctx)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO signed_prekeys (account_id, id, public_key, signature)
		 VALUES ($1, $2, $3, $4)`,
		id, int(p.SignedPrekey.ID), p.SignedPrekey.PublicKey, p.SignedPrekey.Signature)
	if err != nil {
		return "", false, fmt.Errorf("db: insert signed prekey: %w", err)
	}

	for _, k := range p.OneTimePrekeys {
		if _, err := tx.Exec(ctx,
			`INSERT INTO one_time_prekeys (account_id, id, public_key)
			 VALUES ($1, $2, $3)
			 ON CONFLICT DO NOTHING`,
			id, int(k.ID), k.PublicKey); err != nil {
			return "", false, fmt.Errorf("db: insert one-time prekey: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return "", false, fmt.Errorf("db: commit create account: %w", err)
	}
	return p.PublicID, true, nil
}

func errIsNoRows(err error) bool { return err == pgx.ErrNoRows }
