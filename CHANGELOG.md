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

[0.1.0]: https://github.com/SuperpositionLabs/shatters/releases/tag/v0.1.0
