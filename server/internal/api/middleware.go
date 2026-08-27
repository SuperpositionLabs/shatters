package api

import (
	"context"
	"crypto/sha256"
	"net"
	"net/http"
	"strings"

	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

type contextKey int

const accountKey contextKey = 0

// requireAuth is middleware enforcing a valid bearer session token. On
// success the authenticated account is attached to the request context.
// Tokens are validated by hash lookup; expired rows never match.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}

		sum := sha256.Sum256([]byte(token))
		account, err := db.AccountIDByTokenHash(r.Context(), s.pool, sum[:])
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}

		next.ServeHTTP(w, r.WithContext(
			context.WithValue(r.Context(), accountKey, account)))
	})
}

// authenticatedAccount extracts the account attached by requireAuth.
func authenticatedAccount(r *http.Request) (db.AccountLookup, bool) {
	a, ok := r.Context().Value(accountKey).(db.AccountLookup)
	return a, ok
}

// rateLimit applies the per-IP token bucket.
func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.limiter.Allow(s.clientIP(r)) {
			writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP resolves the address to rate limit against.
//
// With no trusted proxies configured, this is the peer address and nothing
// else: X-Forwarded-For is attacker-controlled when the server is reachable
// directly, so honouring it would let anyone rotate identity per request and
// make the limiter decorative.
//
// Behind a proxy the opposite is true. Every request arrives from the proxy,
// so limiting on the peer address puts every user of the instance in one
// bucket - they throttle each other, and an abuser is indistinguishable from
// the crowd. The header is the only source of the real address there.
//
// Which of those applies is a deployment fact the process cannot discover, so
// it is configuration, and it defaults to the safer of the two.
func (s *Server) clientIP(r *http.Request) string {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	if s.trustedProxies <= 0 {
		return peer
	}

	// "client, proxy1, proxy2": each hop appends the address it saw, so the
	// rightmost entries are the ones added by proxies nearest this server.
	var chain []string
	for _, header := range r.Header.Values("X-Forwarded-For") {
		for _, part := range strings.Split(header, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				chain = append(chain, trimmed)
			}
		}
	}

	// Count back past the hops that are actually trusted. A chain shorter than
	// claimed means a misconfiguration or a forged header, and in either case
	// the peer address is the only thing here that was not supplied by the
	// caller.
	index := len(chain) - s.trustedProxies
	if index < 0 || index >= len(chain) {
		return peer
	}

	candidate := chain[index]
	// A header entry can be anything at all; an unparseable one is not an
	// address and must not become a bucket key.
	if net.ParseIP(candidate) == nil {
		if host, _, err := net.SplitHostPort(candidate); err == nil &&
			net.ParseIP(host) != nil {
			return host
		}
		return peer
	}
	return candidate
}
