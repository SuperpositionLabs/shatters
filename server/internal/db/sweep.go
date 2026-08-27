package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SweepBatchSize bounds one DELETE.
//
// A first run against a long-neglected instance could otherwise be a single
// enormous transaction, holding locks and bloating WAL while ordinary requests
// wait behind it. Several small deletes take longer in total and interfere far
// less.
const SweepBatchSize = 1000

// SweepResult reports what one pass removed.
type SweepResult struct {
	Envelopes  int64
	Challenges int64
	Tokens     int64
}

// Total is the number of rows removed across all tables.
func (r SweepResult) Total() int64 {
	return r.Envelopes + r.Challenges + r.Tokens
}

// Sweep deletes expired rows from every table that accumulates them.
//
// Expired rows are already invisible to readers, so this is not about
// correctness. It is about not keeping data the design promised to discard:
// an undelivered envelope from two months ago is still ciphertext sitting on
// the operator's disk.
func Sweep(ctx context.Context, pool *pgxpool.Pool) (SweepResult, error) {
	var result SweepResult
	var err error

	if result.Envelopes, err = sweepTable(ctx, pool,
		`DELETE FROM envelopes WHERE ctid IN (
		     SELECT ctid FROM envelopes WHERE expires_at <= now() LIMIT $1
		 )`); err != nil {
		return result, fmt.Errorf("db: sweep envelopes: %w", err)
	}

	// An issued challenge that is never answered is never consumed, so every
	// abandoned login leaves a row behind.
	if result.Challenges, err = sweepTable(ctx, pool,
		`DELETE FROM auth_challenges WHERE nonce IN (
		     SELECT nonce FROM auth_challenges WHERE expires_at <= now() LIMIT $1
		 )`); err != nil {
		return result, fmt.Errorf("db: sweep challenges: %w", err)
	}

	if result.Tokens, err = sweepTable(ctx, pool,
		`DELETE FROM session_tokens WHERE token_hash IN (
		     SELECT token_hash FROM session_tokens WHERE expires_at <= now() LIMIT $1
		 )`); err != nil {
		return result, fmt.Errorf("db: sweep session tokens: %w", err)
	}

	return result, nil
}

// sweepTable deletes in batches until a pass removes nothing.
func sweepTable(ctx context.Context, pool *pgxpool.Pool, query string) (int64, error) {
	var total int64

	for {
		tag, err := pool.Exec(ctx, query, SweepBatchSize)
		if err != nil {
			return total, err
		}

		removed := tag.RowsAffected()
		total += removed
		if removed < SweepBatchSize {
			return total, nil
		}

		// Yield between batches so a large backlog cannot monopolise a
		// connection for the whole sweep.
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		default:
		}
	}
}
