// Package api wires the HTTP routes served by the shatters server.
package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Server holds dependencies shared by all HTTP handlers.
type Server struct {
	pool *pgxpool.Pool
}

// NewServer builds the top-level HTTP handler of the shatters server.
func NewServer(pool *pgxpool.Pool) http.Handler {
	s := &Server{pool: pool}

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/healthz", s.handleHealth)
	r.Post("/v1/accounts", s.handleRegister)

	return r
}
