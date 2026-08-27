// Package config loads server runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
)

// Default rate limits for the unauthenticated endpoints. Unchanged from the
// values that were previously compiled in, so existing deployments behave
// exactly as before.
const (
	DefaultRateLimitPerMinute = 60
	DefaultRateLimitBurst     = 20
)

// Config holds the runtime settings for the server process.
type Config struct {
	// Addr is the TCP listen address in host:port form.
	Addr string
	// DatabaseURL is the PostgreSQL connection string (required).
	DatabaseURL string
	// RateLimitPerMinute is the sustained per-IP request allowance on the
	// unauthenticated endpoints.
	RateLimitPerMinute int
	// RateLimitBurst is how many requests a single IP may make back to back.
	RateLimitBurst int
}

// Load reads configuration from the environment and validates it.
//
// Supported variables:
//
//	PORT                  - TCP port to listen on (default "8080")
//	DATABASE_URL          - PostgreSQL connection string (required)
//	RATE_LIMIT_PER_MINUTE - per-IP sustained rate (default 60)
//	RATE_LIMIT_BURST      - per-IP burst allowance (default 20)
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

	perMinute, err := positiveInt("RATE_LIMIT_PER_MINUTE", DefaultRateLimitPerMinute)
	if err != nil {
		return Config{}, err
	}
	burst, err := positiveInt("RATE_LIMIT_BURST", DefaultRateLimitBurst)
	if err != nil {
		return Config{}, err
	}

	return Config{
		Addr:               fmt.Sprintf(":%d", n),
		DatabaseURL:        dbURL,
		RateLimitPerMinute: perMinute,
		RateLimitBurst:     burst,
	}, nil
}

// positiveInt parses an optional positive integer setting.
//
// Rate limiting is the only thing standing between the unauthenticated
// endpoints and abuse, so a malformed or non-positive value refuses to boot
// rather than falling back to a default. Silently ignoring a typo would leave
// an operator believing a limit is in force when it is not.
func positiveInt(key string, fallback int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, nil
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("config: invalid %s %q: not an integer", key, raw)
	}
	if value < 1 {
		return 0, fmt.Errorf("config: %s must be at least 1, got %d", key, value)
	}
	return value, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
