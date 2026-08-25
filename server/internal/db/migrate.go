// Package db provides PostgreSQL connectivity and schema migrations for the
// shatters server.
package db

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect creates a connection pool using url and validates connectivity.
func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("db: parse config: %w", err)
	}
	cfg.MaxConns = 10

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("db: create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	return pool, nil
}

type migration struct {
	version int
	name    string
	sql     string
}

// Migrate applies all pending up-migrations from dir (a filesystem rooted at
// a directory of NNNNNN_name.up.sql / .down.sql files) exactly once each.
// It is safe to call concurrently at startup only if externally serialized;
// the server calls it once before serving traffic.
func Migrate(ctx context.Context, pool *pgxpool.Pool, dir fs.FS) error {
	migrations, err := loadMigrations(dir)
	if err != nil {
		return err
	}

	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    bigint      PRIMARY KEY,
			name       text        NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("db: ensure schema_migrations: %w", err)
	}

	for _, m := range migrations {
		applied, err := isApplied(ctx, pool, m.version)
		if err != nil {
			return err
		}
		if applied {
			continue
		}
		if err := applyOne(ctx, pool, m); err != nil {
			return err
		}
	}
	return nil
}

func loadMigrations(dir fs.FS) ([]migration, error) {
	ups := map[int]migration{}
	err := fs.WalkDir(dir, ".", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() || !strings.HasSuffix(path, ".up.sql") {
			return walkErr
		}
		base := d.Name()
		versionPart := base[:6]
		version, convErr := strconv.Atoi(versionPart)
		if convErr != nil {
			return fmt.Errorf("db: migration %q must start with 6-digit version", base)
		}
		body, readErr := fs.ReadFile(dir, path)
		if readErr != nil {
			return fmt.Errorf("db: read %q: %w", path, readErr)
		}
		ups[version] = migration{
			version: version,
			name:    strings.TrimSuffix(strings.TrimPrefix(base, versionPart+"_"), ".up.sql"),
			sql:     string(body),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := make([]migration, 0, len(ups))
	for _, m := range ups {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

func isApplied(ctx context.Context, pool *pgxpool.Pool, version int) (bool, error) {
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM schema_migrations WHERE version = $1`, version).Scan(&n); err != nil {
		return false, fmt.Errorf("db: check applied %d: %w", version, err)
	}
	return n > 0, nil
}

func applyOne(ctx context.Context, pool *pgxpool.Pool, m migration) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("db: begin %d: %w", m.version, err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	if _, err := tx.Exec(ctx, m.sql); err != nil {
		return fmt.Errorf("db: apply %06d_%s: %w", m.version, m.name, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
		m.version, m.name); err != nil {
		return fmt.Errorf("db: record %d: %w", m.version, err)
	}
	return tx.Commit(ctx)
}
