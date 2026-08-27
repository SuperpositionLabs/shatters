package db

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func sweepPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Skipf("cannot reach database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// makeAccount registers a throwaway account for rows to hang off.
func makeAccount(t *testing.T, pool *pgxpool.Pool) [16]byte {
	t.Helper()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	dh := make([]byte, 32)
	if _, err := rand.Read(dh); err != nil {
		t.Fatalf("rand: %v", err)
	}

	var id [16]byte
	err = pool.QueryRow(t.Context(),
		`INSERT INTO accounts (identity_key, identity_dh_key, identity_dh_signature, public_id)
		 VALUES ($1, $2, $3, encode(sha256($1), 'hex'))
		 RETURNING id`, []byte(pub), dh, make([]byte, 64)).Scan(&id)
	if err != nil {
		t.Fatalf("insert account: %v", err)
	}
	return id
}

func countWhere(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(t.Context(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestSweepRemovesExpiredEnvelopes(t *testing.T) {
	pool := sweepPool(t)
	sender := makeAccount(t, pool)
	recipient := makeAccount(t, pool)

	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	for _, expiry := range []time.Time{past, future} {
		if _, err := pool.Exec(t.Context(),
			`INSERT INTO envelopes (sender_id, recipient_id, payload, expires_at)
			 VALUES ($1, $2, $3, $4)`,
			sender[:], recipient[:], []byte("blob"), expiry); err != nil {
			t.Fatalf("insert envelope: %v", err)
		}
	}

	if _, err := Sweep(t.Context(), pool); err != nil {
		t.Fatalf("Sweep: %v", err)
	}

	// An undelivered envelope from two months ago is still ciphertext on the
	// operator's disk; a design that promises to hold as little as possible
	// has to actually discard it.
	if n := countWhere(t, pool,
		`SELECT count(*) FROM envelopes WHERE recipient_id = $1 AND expires_at <= now()`,
		recipient[:]); n != 0 {
		t.Errorf("expired envelopes remaining = %d, want 0", n)
	}
	if n := countWhere(t, pool,
		`SELECT count(*) FROM envelopes WHERE recipient_id = $1`, recipient[:]); n != 1 {
		t.Errorf("live envelopes = %d, want the unexpired one to survive", n)
	}
}

func TestSweepRemovesAbandonedChallenges(t *testing.T) {
	pool := sweepPool(t)
	account := makeAccount(t, pool)

	// A challenge that is issued and never answered is never consumed, so
	// every abandoned login leaves a row behind.
	stale := make([]byte, 32)
	fresh := make([]byte, 32)
	if _, err := rand.Read(stale); err != nil {
		t.Fatalf("rand: %v", err)
	}
	if _, err := rand.Read(fresh); err != nil {
		t.Fatalf("rand: %v", err)
	}

	for nonce, expiry := range map[string]time.Time{
		string(stale): time.Now().Add(-time.Minute),
		string(fresh): time.Now().Add(time.Minute),
	} {
		if _, err := pool.Exec(t.Context(),
			`INSERT INTO auth_challenges (nonce, account_id, expires_at)
			 VALUES ($1, $2, $3)`, []byte(nonce), account[:], expiry); err != nil {
			t.Fatalf("insert challenge: %v", err)
		}
	}

	if _, err := Sweep(t.Context(), pool); err != nil {
		t.Fatalf("Sweep: %v", err)
	}

	if n := countWhere(t, pool,
		`SELECT count(*) FROM auth_challenges WHERE nonce = $1`, stale); n != 0 {
		t.Error("expired challenge survived the sweep")
	}
	if n := countWhere(t, pool,
		`SELECT count(*) FROM auth_challenges WHERE nonce = $1`, fresh); n != 1 {
		t.Error("an unexpired challenge was swept")
	}
}

func TestSweepRemovesExpiredSessionTokens(t *testing.T) {
	pool := sweepPool(t)
	account := makeAccount(t, pool)

	stale := make([]byte, 32)
	fresh := make([]byte, 32)
	if _, err := rand.Read(stale); err != nil {
		t.Fatalf("rand: %v", err)
	}
	if _, err := rand.Read(fresh); err != nil {
		t.Fatalf("rand: %v", err)
	}

	for hash, expiry := range map[string]time.Time{
		string(stale): time.Now().Add(-time.Hour),
		string(fresh): time.Now().Add(time.Hour),
	} {
		if _, err := pool.Exec(t.Context(),
			`INSERT INTO session_tokens (token_hash, account_id, expires_at)
			 VALUES ($1, $2, $3)`, []byte(hash), account[:], expiry); err != nil {
			t.Fatalf("insert token: %v", err)
		}
	}

	if _, err := Sweep(t.Context(), pool); err != nil {
		t.Fatalf("Sweep: %v", err)
	}

	if n := countWhere(t, pool,
		`SELECT count(*) FROM session_tokens WHERE token_hash = $1`, stale); n != 0 {
		t.Error("expired session token survived the sweep")
	}
	if n := countWhere(t, pool,
		`SELECT count(*) FROM session_tokens WHERE token_hash = $1`, fresh); n != 1 {
		t.Error("an unexpired session token was swept")
	}
}

func TestSweepDeletesInBatches(t *testing.T) {
	pool := sweepPool(t)
	sender := makeAccount(t, pool)
	recipient := makeAccount(t, pool)

	// More than one batch, so the loop has to run twice.
	const total = SweepBatchSize + 25
	expiry := time.Now().Add(-time.Hour)
	for i := 0; i < total; i++ {
		if _, err := pool.Exec(t.Context(),
			`INSERT INTO envelopes (sender_id, recipient_id, payload, expires_at)
			 VALUES ($1, $2, $3, $4)`,
			sender[:], recipient[:], []byte{byte(i)}, expiry); err != nil {
			t.Fatalf("insert envelope %d: %v", i, err)
		}
	}

	if _, err := Sweep(t.Context(), pool); err != nil {
		t.Fatalf("Sweep: %v", err)
	}

	// A first run against a neglected instance must not become one enormous
	// transaction, but it must still finish the job. Asserted by what remains
	// rather than by the reported total: `go test ./...` runs packages in
	// parallel against one database, and the api suite sweeps it too, so the
	// count is not this test's to predict. A sweep that stopped after a single
	// batch would leave the remainder behind, which this still catches.
	if n := countWhere(t, pool,
		`SELECT count(*) FROM envelopes WHERE recipient_id = $1`, recipient[:]); n != 0 {
		t.Errorf("%d of %d expired envelopes left after a batched sweep", n, total)
	}
}

func TestSweepIsSafeToRunOnAnEmptyDatabase(t *testing.T) {
	pool := sweepPool(t)

	// Runs hourly forever; the overwhelmingly common case is nothing to do.
	result, err := Sweep(t.Context(), pool)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	_ = result
}

func TestSweepStopsWhenCancelled(t *testing.T) {
	pool := sweepPool(t)

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	// Shutdown must interrupt a pass rather than being made to wait for it.
	if _, err := Sweep(ctx, pool); err == nil {
		t.Error("Sweep with a cancelled context returned nil error")
	}
}
