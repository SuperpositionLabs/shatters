package api

import (
	"net/http"
	"strings"
)

// allowedOrigins decides which cross-origin callers may reach the API.
//
// Empty means same-origin only, which is how shatters deploys: one reverse
// proxy in front of both client and server. A permissive default would let any
// website open an authenticated socket in a visitor's browser, and the
// operator who most needs that protection is the least likely to configure it.
type allowedOrigins []string

// allows reports whether an Origin header is on the list. The comparison is
// exact: scheme, host and port all matter, since https://app and http://app
// are different trust boundaries.
func (a allowedOrigins) allows(origin string) bool {
	for _, candidate := range a {
		if candidate == origin {
			return true
		}
	}
	return false
}

// cors applies the allowlist to a request.
//
// Requests with no Origin - native clients, curl, server-to-server - are
// untouched: CORS is a browser mechanism, and adding headers for a caller that
// will not read them only invites confusion.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}

		// Set whether or not the origin is allowed: a cache keyed without it
		// would happily serve one origin's response to another.
		w.Header().Add("Vary", "Origin")

		if !s.origins.allows(origin) && !sameOrigin(origin, r.Host) {
			// No CORS headers. The browser blocks the response, which is the
			// correct outcome; answering 403 here would leak that the endpoint
			// exists to a page that is not allowed to see it.
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		// Echoed from the request only after matching the list. Reflecting it
		// unconditionally is the classic way to make an allowlist decorative.
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")

		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// sameOrigin reports whether an Origin header refers to the host the request
// was addressed to.
//
// Host carries no scheme, and behind a TLS-terminating proxy - the documented
// deployment - the request reaches this process as plain http while the
// browser reports https. Comparing schemes would therefore reject the ordinary
// case, so only the host is matched here.
//
// The consequence is that an http page on the same hostname counts as
// same-origin. An operator who needs scheme-exact matching should list the
// origin explicitly: allowedOrigins.allows compares the whole string, scheme
// included. Trusting X-Forwarded-Proto instead was rejected deliberately, for
// the same reason the rate limiter ignores forwarding headers: it is
// attacker-controlled whenever the server is reachable directly.
func sameOrigin(origin, host string) bool {
	for _, prefix := range []string{"http://", "https://"} {
		if rest, ok := strings.CutPrefix(origin, prefix); ok {
			return rest == host
		}
	}
	return false
}
