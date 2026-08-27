package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const clientOrigin = "https://app.example"

func corsRequest(t *testing.T, h http.Handler, method, origin string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(method, "/healthz", nil)
	req.Host = "api.example"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestNoCORSHeadersWithoutAnOrigin(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithAllowedOrigins([]string{clientOrigin}))

	rec := corsRequest(t, h, http.MethodGet, "")

	// CORS is a browser mechanism. Headers for a caller that will not read
	// them only invite confusion.
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin = %q, want empty for an originless request", got)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestAllowsAConfiguredOrigin(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithAllowedOrigins([]string{clientOrigin}))

	rec := corsRequest(t, h, http.MethodGet, clientOrigin)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != clientOrigin {
		t.Errorf("Allow-Origin = %q, want %q", got, clientOrigin)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("Allow-Credentials = %q, want true", got)
	}
}

func TestRefusesAnUnlistedOrigin(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithAllowedOrigins([]string{clientOrigin}))

	rec := corsRequest(t, h, http.MethodGet, "https://evil.example")

	// Without the header the browser blocks the response, which is the
	// outcome that matters.
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin = %q, want empty for an unlisted origin", got)
	}
}

func TestNeverReflectsAnArbitraryOrigin(t *testing.T) {
	pool := testPool(t)
	// Nothing configured: the allowlist is empty.
	h := NewServer(pool)

	for _, origin := range []string{
		"https://evil.example",
		"null",
		"https://api.example.evil.com",
		"https://api.example.", // trailing dot resolves to the same host
		"https://sub.api.example",
	} {
		rec := corsRequest(t, h, http.MethodGet, origin)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q was reflected as %q; reflecting the request "+
				"unconditionally makes the allowlist decorative", origin, got)
		}
	}
}

func TestSameOriginFallbackIgnoresTheScheme(t *testing.T) {
	// Documented limitation, not an oversight. Host carries no scheme, and
	// behind a TLS-terminating proxy the request arrives as http while the
	// browser reports https; comparing schemes would reject the ordinary
	// deployment. An operator needing scheme-exact matching lists the origin,
	// which is compared in full.
	if !sameOrigin("http://api.example", "api.example") {
		t.Error("http origin should match its host under the fallback")
	}
	if !sameOrigin("https://api.example", "api.example") {
		t.Error("https origin should match its host under the fallback")
	}
	if sameOrigin("https://other.example", "api.example") {
		t.Error("a different host must never match")
	}
	if sameOrigin("api.example", "api.example") {
		t.Error("a schemeless Origin is malformed and must not match")
	}
}

func TestSameOriginKeepsWorkingWithNoAllowlist(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	// The default deployment is one reverse proxy in front of both, so this
	// must not require configuration.
	rec := corsRequest(t, h, http.MethodGet, "https://api.example")

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://api.example" {
		t.Errorf("Allow-Origin = %q, want the same origin echoed", got)
	}
}

func TestVaryOriginIsAlwaysSet(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithAllowedOrigins([]string{clientOrigin}))

	for _, origin := range []string{clientOrigin, "https://evil.example"} {
		rec := corsRequest(t, h, http.MethodGet, origin)
		// Without this a shared cache serves one origin's response to another.
		if !strings.Contains(rec.Header().Get("Vary"), "Origin") {
			t.Errorf("origin %q: Vary = %q, want it to include Origin",
				origin, rec.Header().Get("Vary"))
		}
	}
}

func TestPreflightIsAnsweredForAllowedOrigins(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithAllowedOrigins([]string{clientOrigin}))

	req := httptest.NewRequest(http.MethodOptions, "/v1/envelopes", nil)
	req.Host = "api.example"
	req.Header.Set("Origin", clientOrigin)
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
	// Authorization must be listed, or every authenticated request fails
	// before it is even made.
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Errorf("Allow-Headers = %q, want Authorization",
			rec.Header().Get("Access-Control-Allow-Headers"))
	}
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") {
		t.Errorf("Allow-Methods = %q, want POST",
			rec.Header().Get("Access-Control-Allow-Methods"))
	}
}

func TestPreflightIsRefusedForUnlistedOrigins(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithAllowedOrigins([]string{clientOrigin}))

	req := httptest.NewRequest(http.MethodOptions, "/v1/envelopes", nil)
	req.Host = "api.example"
	req.Header.Set("Origin", "https://evil.example")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("preflight status = %d, want 403", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin = %q, want empty", got)
	}
}

func TestPreflightDoesNotRequireAuthentication(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithAllowedOrigins([]string{clientOrigin}))

	// A browser never attaches credentials to a preflight, so answering 401
	// here would make every authenticated cross-origin request impossible.
	req := httptest.NewRequest(http.MethodOptions, "/v1/envelopes", nil)
	req.Host = "api.example"
	req.Header.Set("Origin", clientOrigin)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}

func TestOriginComparisonIsExact(t *testing.T) {
	origins := allowedOrigins{"https://app.example"}

	cases := map[string]bool{
		"https://app.example":      true,
		"https://app.example:443":  false, // a different origin to a browser
		"http://app.example":       false, // different trust boundary
		"https://app.example.evil": false,
		"https://APP.example":      false,
		"":                         false,
	}

	for origin, want := range cases {
		if got := origins.allows(origin); got != want {
			t.Errorf("allows(%q) = %v, want %v", origin, got, want)
		}
	}
}

func TestWebSocketOriginSharesTheAllowlist(t *testing.T) {
	upgrader := newUpgrader(allowedOrigins{clientOrigin})

	check := func(origin, host string) bool {
		req := httptest.NewRequest(http.MethodGet, "/v1/ws", nil)
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return upgrader.CheckOrigin(req)
	}

	// Two lists would drift, and the socket is the more dangerous of the two.
	if !check(clientOrigin, "api.example") {
		t.Error("a configured origin was rejected by the socket")
	}
	if !check("https://api.example", "api.example") {
		t.Error("same-origin was rejected by the socket")
	}
	if !check("", "api.example") {
		t.Error("an originless native client was rejected")
	}
	if check("https://evil.example", "api.example") {
		t.Error("an unlisted origin was accepted by the socket")
	}
}
