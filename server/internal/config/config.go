// Package config loads server runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Default rate limits for the unauthenticated endpoints. Unchanged from the
// values that were previously compiled in, so existing deployments behave
// exactly as before.
const (
	DefaultRateLimitPerMinute = 60
	DefaultRateLimitBurst     = 20
)

// DefaultSweepInterval is how often expired rows are deleted when unset.
const DefaultSweepInterval = time.Hour

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
	// AllowedOrigins are the browser origins permitted to call the API from
	// another origin. Empty means same-origin only.
	AllowedOrigins []string
	// SweepInterval is how often expired rows are deleted. Zero disables the
	// sweeper, for operators who prefer their own cron.
	SweepInterval time.Duration
	// TrustedProxies is how many reverse proxies sit in front of this process.
	// Zero means none, and the peer address is used directly.
	TrustedProxies int
}

// Load reads configuration from the environment and validates it.
//
// Supported variables:
//
//	PORT                  - TCP port to listen on (default "8080")
//	DATABASE_URL          - PostgreSQL connection string (required)
//	RATE_LIMIT_PER_MINUTE - per-IP sustained rate (default 60)
//	RATE_LIMIT_BURST      - per-IP burst allowance (default 20)
//	CORS_ALLOWED_ORIGINS  - comma-separated browser origins (default: none)
//	SWEEP_INTERVAL        - housekeeping period, e.g. "1h"; "0" disables it
//	TRUSTED_PROXIES       - reverse proxy hops in front (default 0)
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

	origins, err := originList("CORS_ALLOWED_ORIGINS")
	if err != nil {
		return Config{}, err
	}

	sweepInterval, err := durationOr("SWEEP_INTERVAL", DefaultSweepInterval)
	if err != nil {
		return Config{}, err
	}

	trustedProxies, err := nonNegativeInt("TRUSTED_PROXIES", 0)
	if err != nil {
		return Config{}, err
	}

	return Config{
		TrustedProxies:     trustedProxies,
		SweepInterval:      sweepInterval,
		AllowedOrigins:     origins,
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

// originList parses a comma-separated allowlist of browser origins.
//
// Each entry must be a bare scheme://host[:port]. A wildcard is rejected
// rather than honoured: with credentials in play browsers ignore "*" anyway,
// so accepting it would only mislead an operator into thinking it worked.
func originList(key string) ([]string, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil, nil
	}

	var origins []string
	for _, part := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(part)
		if origin == "" {
			continue
		}
		if origin == "*" {
			return nil, fmt.Errorf("config: %s does not accept \"*\"; list origins explicitly", key)
		}
		if !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
			return nil, fmt.Errorf("config: %s entry %q must start with http:// or https://", key, origin)
		}
		if strings.HasSuffix(origin, "/") {
			// An Origin header never carries a trailing slash, so this would
			// silently never match.
			return nil, fmt.Errorf("config: %s entry %q must not end with /", key, origin)
		}
		origins = append(origins, origin)
	}
	return origins, nil
}

// durationOr parses an optional Go duration setting.
//
// "0" is meaningful here rather than invalid: it turns the sweeper off for an
// operator running the deletes themselves. A negative value is refused, since
// it can only be a mistake and would silently disable housekeeping.
func durationOr(key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}

	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("config: invalid %s %q: %v", key, raw, err)
	}
	if value < 0 {
		return 0, fmt.Errorf("config: %s must not be negative, got %s", key, value)
	}
	return value, nil
}

// nonNegativeInt parses an optional count that may legitimately be zero.
func nonNegativeInt(key string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("config: invalid %s %q: not an integer", key, raw)
	}
	if value < 0 {
		return 0, fmt.Errorf("config: %s must not be negative, got %d", key, value)
	}
	return value, nil
}
