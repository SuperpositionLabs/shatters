package db

import (
	"context"
	"fmt"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/migrations"
)

func TestLoadMigrationsSortsByVersion(t *testing.T) {
	fsys := fstest.MapFS{
		"000002_second.up.sql": &fstest.MapFile{Data: []byte("SELECT 2;")},
		"000001_first.up.sql":  &fstest.MapFile{Data: []byte("SELECT 1;")},
	}

	got, err := loadMigrations(fsys)
	if err != nil {
		t.Fatalf("loadMigrations() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2", len(got))
	}
	if got[0].version != 1 || got[1].version != 2 {
		t.Errorf("order = [%d, %d], want [1, 2]", got[0].version, got[1].version)
	}
	if got[0].name != "first" || got[1].name != "second" {
		t.Errorf("names = [%q, %q], want [first, second]", got[0].name, got[1].name)
	}
}

func TestMigrateRejectsInvalidVersionFilename(t *testing.T) {
	fsys := fstest.MapFS{
		"nope.up.sql": &fstest.MapFile{Data: []byte("SELECT 1;")},
	}
	if _, err := loadMigrations(fsys); err == nil {
		t.Error("loadMigrations() error = nil, want error for missing version prefix")
	}
}

// TestMigrateAppliesCleanAndIdempotent runs against a real PostgreSQL when
// DATABASE_URL points at a server with permission to create databases
// (CI service container or local docker). It is skipped otherwise.
func TestMigrateAppliesCleanAndIdempotent(t *testing.T) {
	baseURL := os.Getenv("DATABASE_URL")
	if baseURL == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	testName := fmt.Sprintf("shatters_mig_%d", time.Now().UnixNano())

	adminCfg, err := pgxpool.ParseConfig(baseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	adminCfg.ConnConfig.Database = "postgres"
	adminPool, err := pgxpool.NewWithConfig(ctx, adminCfg)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	defer adminPool.Close()

	if _, err := adminPool.Exec(ctx, "CREATE DATABASE "+testName); err != nil {
		t.Fatalf("create test database: %v", err)
	}
	defer func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer dropCancel()
		_, _ = adminPool.Exec(dropCtx, "DROP DATABASE IF EXISTS "+testName+" WITH (FORCE)")
	}()

	cfg, err := pgxpool.ParseConfig(baseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	cfg.ConnConfig.Database = testName
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	defer pool.Close()

	if err := Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatalf("Migrate() on clean database: %v", err)
	}

	wantTables := map[string]bool{
		"accounts":         false,
		"signed_prekeys":   false,
		"one_time_prekeys": false,
		"auth_challenges":  false,
		"session_tokens":   false,
		"envelopes":        false,
	}
	rows, err := pool.Query(ctx, `
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public'`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		if _, ok := wantTables[name]; ok {
			wantTables[name] = true
		}
	}
	rows.Close()
	for tbl, found := range wantTables {
		if !found {
			t.Errorf("table %q missing after migration", tbl)
		}
	}

	if err := Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatalf("second Migrate() error = %v, want nil", err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&n); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if n != 1 {
		t.Errorf("schema_migrations rows = %d, want 1", n)
	}
}

func TestMigrateDownSqlDropsSchema(t *testing.T) {
	baseURL := os.Getenv("DATABASE_URL")
	if baseURL == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	testName := fmt.Sprintf("shatters_migdown_%d", time.Now().UnixNano())

	adminCfg, err := pgxpool.ParseConfig(baseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	adminCfg.ConnConfig.Database = "postgres"
	adminPool, err := pgxpool.NewWithConfig(ctx, adminCfg)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	defer adminPool.Close()
	if _, err := adminPool.Exec(ctx, "CREATE DATABASE "+testName); err != nil {
		t.Fatalf("create test database: %v", err)
	}
	defer func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer dropCancel()
		_, _ = adminPool.Exec(dropCtx, "DROP DATABASE IF EXISTS "+testName+" WITH (FORCE)")
	}()

	cfg, err := pgxpool.ParseConfig(baseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	cfg.ConnConfig.Database = testName
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	defer pool.Close()

	if err := Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatalf("Migrate() up: %v", err)
	}

	downSQL, err := migrations.FS.ReadFile("000001_init.down.sql")
	if err != nil {
		t.Fatalf("read down migration: %v", err)
	}
	if _, err := pool.Exec(ctx, string(downSQL)); err != nil {
		t.Fatalf("apply down migration: %v", err)
	}

	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name IN
		('accounts','signed_prekeys','one_time_prekeys',
		 'auth_challenges','session_tokens','envelopes')`).Scan(&n); err != nil {
		t.Fatalf("count remaining tables: %v", err)
	}
	if n != 0 {
		t.Errorf("%d application tables remain after down migration, want 0", n)
	}
}
