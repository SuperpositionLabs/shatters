// Package config loads server runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds the runtime settings for the server process.
type Config struct {
	// Addr is the TCP listen address in host:port form.
	Addr string
	// DatabaseURL is the PostgreSQL connection string (required).
	DatabaseURL string
}

// Load reads configuration from the environment and validates it.
//
// Supported variables:
//
//	PORT         - TCP port to listen on (default "8080")
//	DATABASE_URL - PostgreSQL connection string (required)
func Load() (Config, error) {
	port := envOr("PORT", "8080")
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return Config{}, fmt.Errorf("config: invalid PORT %q", port)
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return Config{}, fmt.Errorf("config: DATABASE_URL is required")
	}

	return Config{Addr: fmt.Sprintf(":%d", n), DatabaseURL: dbURL}, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
