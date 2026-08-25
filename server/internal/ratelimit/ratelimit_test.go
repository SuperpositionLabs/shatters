package ratelimit

import (
	"testing"
	"time"
)

func TestAllowWithinBurst(t *testing.T) {
	l := NewLimiter(60, 3)

	for range 3 {
		if !l.Allow("1.2.3.4") {
			t.Fatal("request denied inside burst window")
		}
	}
	if l.Allow("1.2.3.4") {
		t.Error("burst exceeded without denial")
	}
}

func TestKeysAreIndependent(t *testing.T) {
	l := NewLimiter(60, 1)
	if !l.Allow("a") {
		t.Fatal("first key denied")
	}
	if !l.Allow("b") {
		t.Fatal("second key denied by first key's bucket")
	}
	if l.Allow("a") {
		t.Error("key a not limited")
	}
}

func TestRefillOverTime(t *testing.T) {
	l := NewLimiter(60, 1) // 1 token/second refill

	now := time.Now()
	l.now = func() time.Time { return now }

	if !l.Allow("k") {
		t.Fatal("initial request denied")
	}
	if l.Allow("k") {
		t.Fatal("bucket refilled instantly")
	}

	now = now.Add(1100 * time.Millisecond)
	if !l.Allow("k") {
		t.Error("token did not refill after one second")
	}
}
