// Package ratelimit provides an in-memory token bucket keyed by arbitrary
// strings (client IP addresses). Buckets live only for the lifetime of the
// process: no client state is persisted, matching the relay's no-tracking
// philosophy.
package ratelimit

import (
	"sync"
	"time"
)

// Bucket is a single token bucket.
type Bucket struct {
	tokens  float64
	lastRef time.Time
}

// Limiter tracks one bucket per key.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*Bucket
	rate    float64 // tokens per second
	burst   float64 // maximum tokens
	now     func() time.Time
}

// NewLimiter returns a limiter allowing burst events instantly, refilling at
// rate tokens per second afterwards.
func NewLimiter(ratePerMinute int, burst int) *Limiter {
	return &Limiter{
		buckets: make(map[string]*Bucket),
		rate:    float64(ratePerMinute) / 60,
		burst:   float64(burst),
		now:     time.Now,
	}
}

// Allow reports whether key may proceed now, consuming one token if so.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		b = &Bucket{tokens: l.burst, lastRef: now}
		l.buckets[key] = b
	} else {
		elapsed := now.Sub(b.lastRef).Seconds()
		b.tokens += elapsed * l.rate
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.lastRef = now
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Len reports how many distinct buckets are currently tracked. Exposed for
// tests and operational introspection.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
