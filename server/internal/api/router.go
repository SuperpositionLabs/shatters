// Package api wires the HTTP routes served by the shatters server.
package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/ratelimit"
)

// Server holds dependencies shared by all HTTP handlers.
type Server struct {
	pool    *pgxpool.Pool
	limiter *ratelimit.Limiter
}

// Option customizes the server for tests and future deployments.
type Option func(*Server)

// WithRateLimiter overrides the default per-IP limiter.
func WithRateLimiter(l *ratelimit.Limiter) Option {
	return func(s *Server) { s.limiter = l }
}

// NewServer builds the top-level HTTP handler of the shatters server.
//
// Route groups:
//   - /healthz: unauthenticated, unthrottled (load balancer probes)
//   - /v1/accounts + /v1/auth/*: rate limited per IP (abuse surface)
//   - authenticated routes: bearer session required
func NewServer(pool *pgxpool.Pool, opts ...Option) http.Handler {
	s := &Server{pool: pool, limiter: ratelimit.NewLimiter(60, 20)}
	for _, opt := range opts {
		opt(s)
	}

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/healthz", s.handleHealth)

	r.Group(func(r chi.Router) {
		r.Use(s.rateLimit)
		r.Post("/v1/accounts", s.handleRegister)
		r.Post("/v1/auth/challenge", s.handleChallenge)
		r.Post("/v1/auth/verify", s.handleVerify)
	})

	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Get("/v1/me", func(w http.ResponseWriter, r *http.Request) {
			account, ok := authenticatedAccount(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "unauthenticated")
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"account_id": account.PublicID})
		})
	})

	return r
}
