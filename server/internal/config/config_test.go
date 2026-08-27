package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("DATABASE_URL", "postgres://localhost/test")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	if cfg.Addr != ":8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, ":8080")
	}
	// Unset rate limits must keep the values that were previously compiled in,
	// so upgrading does not silently change an operator's exposure.
	if cfg.RateLimitPerMinute != DefaultRateLimitPerMinute {
		t.Errorf("RateLimitPerMinute = %d, want %d",
			cfg.RateLimitPerMinute, DefaultRateLimitPerMinute)
	}
	if cfg.RateLimitBurst != DefaultRateLimitBurst {
		t.Errorf("RateLimitBurst = %d, want %d",
			cfg.RateLimitBurst, DefaultRateLimitBurst)
	}
}

func TestLoadCustomRateLimits(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/test")
	t.Setenv("RATE_LIMIT_PER_MINUTE", "600")
	t.Setenv("RATE_LIMIT_BURST", "200")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	if cfg.RateLimitPerMinute != 600 || cfg.RateLimitBurst != 200 {
		t.Errorf("rate limits = (%d, %d), want (600, 200)",
			cfg.RateLimitPerMinute, cfg.RateLimitBurst)
	}
}

func TestLoadRejectsInvalidRateLimits(t *testing.T) {
	// A typo that silently disabled rate limiting would leave an operator
	// believing the unauthenticated endpoints are protected when they are not,
	// so anything unparseable or non-positive must refuse to boot.
	cases := []struct{ key, value string }{
		{"RATE_LIMIT_PER_MINUTE", "abc"},
		{"RATE_LIMIT_PER_MINUTE", "0"},
		{"RATE_LIMIT_PER_MINUTE", "-1"},
		{"RATE_LIMIT_PER_MINUTE", "1.5"},
		{"RATE_LIMIT_BURST", "abc"},
		{"RATE_LIMIT_BURST", "0"},
		{"RATE_LIMIT_BURST", "-5"},
	}

	for _, c := range cases {
		t.Run(c.key+"="+c.value, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://localhost/test")
			t.Setenv(c.key, c.value)

			if _, err := Load(); err == nil {
				t.Errorf("Load(%s=%q) error = nil, want error", c.key, c.value)
			}
		})
	}
}

func TestLoadCustomPort(t *testing.T) {
	t.Setenv("PORT", "9000")
	t.Setenv("DATABASE_URL", "postgres://localhost/test")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	if cfg.Addr != ":9000" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, ":9000")
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	for _, port := range []string{"abc", "0", "70000"} {
		t.Setenv("PORT", port)
		t.Setenv("DATABASE_URL", "postgres://localhost/test")
		if _, err := Load(); err == nil {
			t.Errorf("Load(PORT=%q) error = nil, want error", port)
		}
	}
}

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if _, err := Load(); err == nil {
		t.Error("Load() with empty DATABASE_URL error = nil, want error")
	}
}
