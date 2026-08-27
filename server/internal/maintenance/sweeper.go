// Package maintenance runs the periodic housekeeping the server needs to stay
// bounded: deleting rows whose time has passed.
package maintenance

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

// DefaultInterval is how often the sweep runs when not configured.
//
// Hourly is far more often than the 30-day envelope TTL requires, but
// challenges expire in five minutes and tokens in a day, so the shorter
// lifetimes set the pace.
const DefaultInterval = time.Hour

// sweepTimeout bounds one pass. A sweep that cannot finish in this long is
// stuck; the next tick will try again rather than piling up.
const sweepTimeout = 5 * time.Minute

// Sweeper periodically deletes expired rows.
type Sweeper struct {
	pool     *pgxpool.Pool
	interval time.Duration
	// Injected in tests so a pass can be observed without waiting.
	sweep func(context.Context, *pgxpool.Pool) (db.SweepResult, error)
}

// New builds a sweeper. An interval of zero or less disables it, which lets an
// operator run the deletes from their own cron instead.
func New(pool *pgxpool.Pool, interval time.Duration) *Sweeper {
	return &Sweeper{pool: pool, interval: interval, sweep: db.Sweep}
}

// Enabled reports whether this sweeper will do anything when run.
func (s *Sweeper) Enabled() bool {
	return s.interval > 0
}

// Run sweeps until the context is cancelled, then returns.
//
// Blocking, so the caller decides where it lives. Errors are logged and
// retried on the next tick: a database that is briefly unavailable must not
// take the process down over housekeeping.
func (s *Sweeper) Run(ctx context.Context) {
	if !s.Enabled() {
		slog.Info("maintenance sweep disabled")
		return
	}

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	// An immediate pass, so a restart after downtime clears the backlog rather
	// than waiting a full interval first.
	s.once(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.once(ctx)
		}
	}
}

// once performs a single sweep.
func (s *Sweeper) once(ctx context.Context) {
	// Detached from the shutdown context only in its deadline, not its
	// cancellation: shutdown must still interrupt a pass in progress.
	passCtx, cancel := context.WithTimeout(ctx, sweepTimeout)
	defer cancel()

	result, err := s.sweep(passCtx, s.pool)
	if err != nil {
		if ctx.Err() != nil {
			return // shutting down, not a failure
		}
		slog.Warn("maintenance sweep failed", "err", err)
		return
	}

	if result.Total() > 0 {
		slog.Info("maintenance sweep",
			"envelopes", result.Envelopes,
			"challenges", result.Challenges,
			"session_tokens", result.Tokens)
	}
}
