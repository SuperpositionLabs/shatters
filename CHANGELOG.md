# Changelog

All notable changes to shatters v2 are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-08-27

Makes shatters deployable. v1.0.0 was complete as an application but could not
be hosted: `deploy/docker-compose.yml` was a development stack and said so.

### Added

- Production deployment stack: client Dockerfile (Next standalone, non-root),
  `docker-compose.prod.yml`, and a Caddy front end with automatic certificates.
  One domain, one proxy, client and API same-origin — so the CORS allowlist
  stays empty and the WebSocket passes its origin check unconfigured. Only the
  proxy publishes ports; PostgreSQL is reachable solely over the internal
  network (#81)
- `docs/deployment.md`: a VPS from nothing to working, plus backups, updating,
  and what an operator can still see (#81)
- `TRUSTED_PROXIES`, declaring how many reverse proxy hops sit in front (#81)

### Fixed

- **Rate limiting was per-instance, not per-user, behind a proxy.** Every
  request arrives from the proxy, so all users shared one bucket and throttled
  each other while an abuser stayed indistinguishable from the crowd. The
  limiter now counts back through `X-Forwarded-For` by the configured hop
  count, defaulting to `0` because the opposite mistake is worse: trusting the
  header on a directly reachable server lets anyone pick their own address.
  Entries a caller prepends sit to the left of where counting starts, so the
  chain cannot be forged past the trusted hops (#81)

### Security

- No default database password anywhere. The stack refuses to start rather
  than falling back to a guessable one (#81)
- The reverse proxy sets HSTS, a content security policy restricting scripts
  and connections to the instance's own origin, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` (#81)

## [1.0.0] - 2026-08-27

First complete release. Milestones M2 through M6.

### Added

**Sessions (M2)**

- X3DH key agreement, client-side, both the four-DH and three-DH variants (#33)
- Double Ratchet with a bounded skipped-key window and XChaCha20-Poly1305
  message AEAD (#36)
- Inner message wire format and the session facade tying them together (#38)

**Transport (M3)**

- Offline envelope queue: submit, fetch, acknowledge, with per-recipient
  quotas and a 30-day TTL (#40)
- Authenticated WebSocket push, first-frame auth, bounded per-connection send
  buffers, ping/pong keepalive (#43)
- Client transport: typed REST client and a socket with backlog catch-up and
  jittered reconnection (#46)
- Cross-origin support behind one allowlist shared by CORS and the WebSocket
  handshake (#63)

**Persistence and features (M4)**

- Encrypted vault: Argon2id-derived key, XChaCha20-Poly1305 records, IndexedDB
  and in-memory adapters (#52)
- Session and message history persistence, with an explicit session codec (#54)
- End-to-end content protocol: text, receipts, typing, edits, deletions,
  reactions and chunked attachments (#56)
- Chat engine joining identity, sessions, transport and storage (#58)
- User interface: onboarding, conversation list, chat view, account panel (#60)
- Group conversations by pairwise fan-out, converging without a server (#67)
- Persisted reactions, in-memory search, and desktop notifications (#75)

**Hardening (M5)**

- Configurable per-IP rate limits (#49)
- Periodic sweep of expired envelopes, challenges and session tokens (#69)
- Fuzz targets for every wire-format decoder, run in CI (#71)
- JavaScript dependency audit gate; vitest 2 to 4 and Next 15 to 16 (#61)

**Verification (M6)**

- Safety numbers and an automatic warning when a contact's identity key
  changes (#77)

### Security

- Identity DH keys are now signed by the identity key and verified by clients.
  Previously the one key in a prekey bundle that nothing vouched for, letting
  an operator control the DH2 input to X3DH. Session confidentiality held
  regardless, but a substituted key contributed no entropy an attacker lacked
  (#35)
- `ed25519.Verify` panics on a wrong-sized public key; both verification
  routines now check lengths first. Not reachable through any current caller,
  but a crash in a verification routine is one refactor from a denial of
  service. Found by fuzzing (#71)
- `sameOrigin("http://", "")` matched, so a request arriving without a Host
  could be treated as same-origin. Found by fuzzing (#71)
- End-to-end CI job runs the real client against the real server, closing the
  gap that hid two earlier defects (#48)

### Fixed

- The production image could not be built: `go.mod` required Go 1.25 while the
  Dockerfile pinned 1.22, and no CI job built the image (#27)
- The client had no auth-proof helper, so no client could authenticate. Both
  sides' unit tests passed throughout (#29)
- Account ID derivation order in the protocol specification contradicted both
  implementations (#31)
- The vault canary key was double-prefixed and leaked into every listing; a
  failed registration stranded users with an unusable vault and no way out
  (#65)
- Opening a conversation tore down the page: the search filter was memoised
  below an early return, changing the hook count (#75)

### Known limitations

No voice or video, no multi-device, no account recovery, and no independent
security audit. Stated in the README rather than left to be discovered.

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

[1.1.0]: https://github.com/SuperpositionLabs/shatters/releases/tag/v1.1.0
[1.0.0]: https://github.com/SuperpositionLabs/shatters/releases/tag/v1.0.0
[0.2.0]: https://github.com/SuperpositionLabs/shatters/releases/tag/v0.2.0
[0.1.0]: https://github.com/SuperpositionLabs/shatters/releases/tag/v0.1.0
