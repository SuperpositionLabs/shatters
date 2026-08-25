package api

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/db"
	"github.com/SuperpositionLabs/shatters/server/migrations"
)

// TestMain applies pending migrations once before the suite so handler
// integration tests run against a real, current schema when DATABASE_URL
// points at a disposable PostgreSQL instance.
func TestMain(m *testing.M) {
	url := os.Getenv("DATABASE_URL")
	if url != "" {
		ctx := context.Background()
		pool, err := pgxpool.New(ctx, url)
		if err != nil {
			slog.Error("test setup: cannot reach database", "err", err)
			os.Exit(1)
		}
		if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
			slog.Error("test setup: migration failed", "err", err)
			pool.Close()
			os.Exit(1)
		}
		pool.Close()
	}
	os.Exit(m.Run())
}
