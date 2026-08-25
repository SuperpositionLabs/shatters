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

// rateLimit applies the per-IP token bucket. The IP is taken from the request
// peer address only; no forwarding headers are trusted so callers cannot
// rotate identities cheaply behind the proxy.
func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		if !s.limiter.Allow(host) {
			writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r)
	})
}
