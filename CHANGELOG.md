# Changelog

All notable changes to shatters v2 are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-25

First milestone release of the Go rewrite (M0 - Foundation).

### Added

- Monorepo layout: `server/` (Go), `web/` (Next.js client, M1+), `deploy/`, `docs/`
- Go server scaffold: chi router, env-based config, graceful shutdown,
  `GET /healthz` liveness endpoint (#3)
- Multi-stage Dockerfile (distroless, non-root) and Docker Compose stack with
  PostgreSQL 16 and health-gated startup (#5)
- CI pipeline: golangci-lint, gosec, govulncheck, `go test -race ./...` against
  a Postgres service container; required checks on `main`/`develop` (#7)
- Migration framework: embedded versioned SQL files, per-migration transactions,
  strict validation, idempotent application (#9)
- Initial schema: accounts, signed_prekeys, one_time_prekeys, auth_challenges,
  session_tokens, envelopes (opaque blobs, TTL, size cap) (#9)
- Documentation: protocol specification, threat model, README, contribution
  guide (#1, #11)

### Security

- chi upgraded to v5.2.2 clearing a govulncheck finding (#7)
- golang.org/x/text upgraded to v0.41.0 clearing a govulncheck finding (#9)

## [0.2.0] - 2026-08-25

Milestone M1 - Identities.

### Added

- Account registration API (`POST /v1/accounts`): public keys only, signed-prekey
  verification, opaque key-derived account IDs, idempotent re-registration (#16)
- Ed25519 challenge-response authentication: single-use nonces, hashed session
  tokens, bearer middleware (#18)
- Per-IP token-bucket rate limiting on unauthenticated endpoints - in-memory
  only, no user tracking (#18)
- Key directory: authenticated prekey upload and bundle fetch with atomic
  one-time prekey consumption (`FOR UPDATE SKIP LOCKED`) (#20)
- Next.js client workspace with local identity module (Ed25519 + X25519 via
  libsodium), cross-language golden vector pinning client/server agreement (#22)
- CI `web` job (vitest, typecheck, next build) (#22)

### Security

- gosec G115 findings cleared by removing narrow integer conversions (#16, #20)
- golangci-lint upgraded to v2 (action v7); gosec to v2.28.0 for Go 1.25 (#9)

[0.1.0]: https://github.com/SuperpositionLabs/shatters/releases/tag/v0.1.0
