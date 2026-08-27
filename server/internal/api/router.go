// Package api wires the HTTP routes served by the shatters server.
package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/config"
	"github.com/SuperpositionLabs/shatters/server/internal/ratelimit"
)

// Server holds dependencies shared by all HTTP handlers.
type Server struct {
	pool    *pgxpool.Pool
	limiter *ratelimit.Limiter
	hub     *hub
	origins allowedOrigins
	// How many proxies sit between a client and this process. Zero means the
	// peer address is the client address.
	trustedProxies int
}

// Option customizes the server for tests and future deployments.
type Option func(*Server)

// WithRateLimiter overrides the default per-IP limiter.
func WithRateLimiter(l *ratelimit.Limiter) Option {
	return func(s *Server) { s.limiter = l }
}

// WithAllowedOrigins permits these browser origins to call from elsewhere.
// Empty keeps the default of same-origin only.
func WithAllowedOrigins(origins []string) Option {
	return func(s *Server) { s.origins = allowedOrigins(origins) }
}

// WithTrustedProxies declares how many reverse proxies sit in front.
//
// Only meaningful when they are actually there: a hop count larger than
// reality lets a caller prepend addresses of their choosing.
func WithTrustedProxies(count int) Option {
	return func(s *Server) { s.trustedProxies = count }
}

// WithRateLimits sets the per-IP allowance from configuration.
func WithRateLimits(perMinute, burst int) Option {
	return func(s *Server) { s.limiter = ratelimit.NewLimiter(perMinute, burst) }
}

// Service is the top-level HTTP handler plus the resources that outlive a
// single request, notably the WebSocket hub.
type Service struct {
	handler http.Handler
	hub     *hub
}

func (svc *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	svc.handler.ServeHTTP(w, r)
}

// Close tears down long-lived connections.
//
// http.Server.Shutdown cannot do this itself: an upgraded WebSocket is a
// hijacked connection, which Shutdown neither tracks nor waits for. Without
// this, sockets would be severed by process exit rather than closed.
func (svc *Service) Close() {
	svc.hub.closeAll()
}

// NewServer builds the top-level handler of the shatters server.
//
// Route groups:
//   - /healthz: unauthenticated, unthrottled (load balancer probes)
//   - /v1/ws: authenticates with its first frame, not a header
//   - /v1/accounts + /v1/auth/*: rate limited per IP (abuse surface)
//   - authenticated routes: bearer session required
func NewServer(pool *pgxpool.Pool, opts ...Option) *Service {
	s := &Server{
		pool: pool,
		limiter: ratelimit.NewLimiter(
			config.DefaultRateLimitPerMinute, config.DefaultRateLimitBurst),
		hub: newHub(),
	}
	for _, opt := range opts {
		opt(s)
	}

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	// Ahead of everything, so preflight is answered before rate limiting or
	// authentication can reject it.
	r.Use(s.cors)

	r.Get("/healthz", s.handleHealth)

	// The socket authenticates with its first frame rather than a header, so
	// it sits outside the bearer middleware. See handleWebSocket for why.
	r.Get("/v1/ws", s.handleWebSocket)

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
		r.Post("/v1/accounts/me/prekeys", s.handleUploadPrekeys)
		r.Get("/v1/accounts/{accountID}/bundle", s.handleGetBundle)

		// Offline delivery (protocol §9). Recipient scoping always comes from
		// the bearer token, never from a request field.
		r.Post("/v1/envelopes", s.handleSendEnvelope)
		r.Get("/v1/envelopes", s.handleFetchEnvelopes)
		r.Post("/v1/envelopes/ack", s.handleAckEnvelopes)
	})

	return &Service{handler: r, hub: s.hub}
}
