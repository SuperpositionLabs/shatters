package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// ip builds a request with a peer address and an optional forwarding chain.
func ip(t *testing.T, trustedProxies int, peer string, forwarded ...string) string {
	t.Helper()

	s := &Server{trustedProxies: trustedProxies}
	req := httptest.NewRequest(http.MethodGet, "/v1/accounts", nil)
	req.RemoteAddr = peer
	for _, header := range forwarded {
		req.Header.Add("X-Forwarded-For", header)
	}
	return s.clientIP(req)
}

func TestClientIPIgnoresForwardingHeadersByDefault(t *testing.T) {
	// Reachable directly, X-Forwarded-For is attacker-controlled: honouring it
	// would let anyone rotate identity per request and make the limiter
	// decorative.
	got := ip(t, 0, "203.0.113.9:5555", "198.51.100.1")
	if got != "203.0.113.9" {
		t.Errorf("clientIP = %q, want the peer address", got)
	}
}

func TestClientIPUsesTheChainBehindOneProxy(t *testing.T) {
	// Behind a proxy the peer is always the proxy, so limiting on it puts every
	// user of the instance in one bucket.
	got := ip(t, 1, "10.0.0.2:40000", "198.51.100.1")
	if got != "198.51.100.1" {
		t.Errorf("clientIP = %q, want the client from the chain", got)
	}
}

func TestClientIPCountsHopsFromTheRight(t *testing.T) {
	// "client, cdn" with two trusted hops: the entry the outermost proxy saw
	// is the client.
	got := ip(t, 2, "10.0.0.2:40000", "198.51.100.1, 203.0.113.7")
	if got != "198.51.100.1" {
		t.Errorf("clientIP = %q, want 198.51.100.1", got)
	}

	// With only one trusted hop, the same chain means the CDN is the caller as
	// far as this server can honestly tell.
	got = ip(t, 1, "10.0.0.2:40000", "198.51.100.1, 203.0.113.7")
	if got != "203.0.113.7" {
		t.Errorf("clientIP = %q, want 203.0.113.7", got)
	}
}

func TestClientIPRejectsAForgedChain(t *testing.T) {
	// A caller prepending addresses cannot reach past the trusted hop count:
	// the extra entries are simply to the left of where counting starts.
	got := ip(t, 1, "10.0.0.2:40000", "1.1.1.1, 2.2.2.2, 198.51.100.1")
	if got != "198.51.100.1" {
		t.Errorf("clientIP = %q, want the entry the real proxy added", got)
	}
}

func TestClientIPFallsBackWhenTheChainIsTooShort(t *testing.T) {
	// Claiming more hops than exist is a misconfiguration or a forgery. Either
	// way the peer address is the only value here the caller did not supply.
	if got := ip(t, 2, "10.0.0.2:40000", "198.51.100.1"); got != "10.0.0.2" {
		t.Errorf("clientIP = %q, want the peer address", got)
	}
	if got := ip(t, 1, "10.0.0.2:40000"); got != "10.0.0.2" {
		t.Errorf("clientIP with no header = %q, want the peer address", got)
	}
}

func TestClientIPRejectsAnUnparseableEntry(t *testing.T) {
	// A header entry can be anything at all, and anything is not an address.
	// Using it as a bucket key would let one caller occupy unbounded keys.
	if got := ip(t, 1, "10.0.0.2:40000", "not-an-address"); got != "10.0.0.2" {
		t.Errorf("clientIP = %q, want the peer address", got)
	}
	if got := ip(t, 1, "10.0.0.2:40000", ""); got != "10.0.0.2" {
		t.Errorf("clientIP with an empty header = %q, want the peer address", got)
	}
}

func TestClientIPAcceptsAnEntryWithAPort(t *testing.T) {
	// Some proxies append host:port rather than a bare address.
	if got := ip(t, 1, "10.0.0.2:40000", "198.51.100.1:1234"); got != "198.51.100.1" {
		t.Errorf("clientIP = %q, want the address without the port", got)
	}
}

func TestClientIPHandlesRepeatedHeaders(t *testing.T) {
	// A chain can arrive split across several header lines rather than one
	// comma-separated value; both spellings mean the same thing.
	got := ip(t, 1, "10.0.0.2:40000", "198.51.100.1", "203.0.113.7")
	if got != "203.0.113.7" {
		t.Errorf("clientIP = %q, want the last entry across both headers", got)
	}
}

func TestClientIPHandlesIPv6(t *testing.T) {
	if got := ip(t, 0, "[2001:db8::1]:443"); got != "2001:db8::1" {
		t.Errorf("clientIP = %q, want the IPv6 peer", got)
	}
	if got := ip(t, 1, "10.0.0.2:40000", "2001:db8::2"); got != "2001:db8::2" {
		t.Errorf("clientIP = %q, want the IPv6 client", got)
	}
}

func TestRateLimitBucketsSeparateClientsBehindAProxy(t *testing.T) {
	pool := testPool(t)
	// One request per minute with a burst of one, so the second request from
	// the same bucket is refused.
	h := NewServer(pool, WithRateLimits(1, 1), WithTrustedProxies(1))

	send := func(forwarded string) int {
		req := mustJSONRequest(t, http.MethodPost, "/v1/auth/challenge",
			map[string]string{"account_id": "nobody"})
		req.RemoteAddr = "10.0.0.2:40000"
		req.Header.Set("X-Forwarded-For", forwarded)

		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := send("198.51.100.1"); code == http.StatusTooManyRequests {
		t.Fatal("the first request from a client was rate limited")
	}
	if code := send("198.51.100.1"); code != http.StatusTooManyRequests {
		t.Errorf("second request from the same client = %d, want 429", code)
	}
	// The whole point: one heavy user must not throttle everybody else, which
	// is what happens when every request is attributed to the proxy.
	if code := send("198.51.100.2"); code == http.StatusTooManyRequests {
		t.Error("a different client was throttled by someone else's usage")
	}
}
