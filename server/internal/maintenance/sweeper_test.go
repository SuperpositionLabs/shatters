package maintenance

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

// newTestSweeper builds a sweeper whose pass is observable and needs no
// database.
func newTestSweeper(
	interval time.Duration,
	pass func(context.Context, *pgxpool.Pool) (db.SweepResult, error),
) *Sweeper {
	s := New(nil, interval)
	s.sweep = pass
	return s
}

func TestRunSweepsImmediately(t *testing.T) {
	passes := make(chan struct{}, 4)
	sweeper := newTestSweeper(time.Hour, func(context.Context, *pgxpool.Pool) (db.SweepResult, error) {
		passes <- struct{}{}
		return db.SweepResult{}, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sweeper.Run(ctx)

	// A restart after downtime must clear the backlog rather than waiting a
	// full interval first.
	select {
	case <-passes:
	case <-time.After(2 * time.Second):
		t.Fatal("no sweep ran before the first tick")
	}
}

func TestRunRepeatsOnTheInterval(t *testing.T) {
	var count atomic.Int32
	sweeper := newTestSweeper(20*time.Millisecond, func(context.Context, *pgxpool.Pool) (db.SweepResult, error) {
		count.Add(1)
		return db.SweepResult{}, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	go sweeper.Run(ctx)
	time.Sleep(150 * time.Millisecond)
	cancel()

	if count.Load() < 3 {
		t.Errorf("ran %d times in 150ms at a 20ms interval, want at least 3", count.Load())
	}
}

func TestRunStopsOnCancel(t *testing.T) {
	var count atomic.Int32
	sweeper := newTestSweeper(10*time.Millisecond, func(context.Context, *pgxpool.Pool) (db.SweepResult, error) {
		count.Add(1)
		return db.SweepResult{}, nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		sweeper.Run(ctx)
		close(done)
	}()

	time.Sleep(40 * time.Millisecond)
	cancel()

	// Shutdown must not be left waiting on housekeeping.
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}

	settled := count.Load()
	time.Sleep(50 * time.Millisecond)
	if count.Load() != settled {
		t.Error("sweeps continued after cancellation")
	}
}

func TestRunSurvivesAFailingSweep(t *testing.T) {
	var count atomic.Int32
	sweeper := newTestSweeper(10*time.Millisecond, func(context.Context, *pgxpool.Pool) (db.SweepResult, error) {
		count.Add(1)
		return db.SweepResult{}, errors.New("database unavailable")
	})

	ctx, cancel := context.WithCancel(context.Background())
	go sweeper.Run(ctx)
	time.Sleep(80 * time.Millisecond)
	cancel()

	// A database that is briefly unavailable must not take the process down
	// over housekeeping.
	if count.Load() < 3 {
		t.Errorf("ran %d times, want it to keep retrying after failures", count.Load())
	}
}

func TestDisabledSweeperDoesNothing(t *testing.T) {
	var count atomic.Int32
	sweeper := newTestSweeper(0, func(context.Context, *pgxpool.Pool) (db.SweepResult, error) {
		count.Add(1)
		return db.SweepResult{}, nil
	})

	if sweeper.Enabled() {
		t.Error("a zero interval should disable the sweeper")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		sweeper.Run(ctx)
		close(done)
	}()

	// Returns immediately, so an operator running their own cron is not left
	// with a goroutine that never does anything.
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a disabled sweeper did not return")
	}
	if count.Load() != 0 {
		t.Errorf("a disabled sweeper ran %d times", count.Load())
	}
}

func TestSweepResultTotal(t *testing.T) {
	result := db.SweepResult{Envelopes: 3, Challenges: 4, Tokens: 5}
	if result.Total() != 12 {
		t.Errorf("Total() = %d, want 12", result.Total())
	}
}
