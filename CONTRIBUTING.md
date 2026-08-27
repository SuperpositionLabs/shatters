# Contributing to shatters

Thanks for helping build self-hosted, end-to-end encrypted messaging. This
project follows a strict, auditable workflow — every line of code must be
traceable back to an issue.

## Ground rules

1. **Everything starts from an issue.** No commit without an associated issue.
   Issues carry a title in the imperative, a label (`feature`, `bug`,
   `security`, `infra`, `docs`), a milestone, and verifiable acceptance criteria.
2. **No direct pushes to `main` or `develop`.** Branch protection enforces this;
   all code arrives via pull request.
3. **No custom cryptography.** Only audited primitives (`crypto/*` stdlib,
   `golang.org/x/crypto` on the server; libsodium-wrappers on the client).

## Git flow

```
main      ← production; only release/* and hotfix/* merge here (each merge tags vX.Y.Z)
develop   ← integration branch; base for all features
feature/<issue>-<slug>   → PR back into develop
release/x.y.z            ← cut from develop when a milestone closes;
                           merges to main (+tag) AND back into develop
hotfix/x.y.z             ← cut from main; merges to both main and develop
```

Example branch name: `feature/7-handshake-x3dh`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), one cohesive
change per commit, always referencing the issue:

```
<type>(<scope>): <description> (#<issue>)
```

- **Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `security`
- **Scopes:** `crypto`, `transport`, `api`, `db`, `auth`, `client`, `infra`

Examples:

```
feat(crypto): implement key derivation with HKDF-SHA256 (#12)
fix(transport): handle websocket reconnect with exponential backoff (#23)
security(auth): limit login attempts per IP (#31)
```

Never mix a feature with an unrelated refactor in one commit.

## Pull requests

- Title mirrors the primary commit; body contains `Closes #<issue>`.
- CI must be green: golangci-lint, gosec, govulncheck, and `go test -race ./...`.
- Definition of Done:
  - [ ] Unit tests cover the new paths (`go test -race`)
  - [ ] Lint and gosec report zero findings
  - [ ] Acceptance criteria of the issue are checked off
  - [ ] If `server/internal/crypto` or client crypto was touched: the PR body
        explains the rationale behind each cryptographic choice

## Local development

```sh
cd deploy && docker compose up --build   # postgres + server
cd server && go test ./...               # backend tests (set DATABASE_URL for db tests)
cd web && npm test                       # client unit tests (no server needed)
```

Integration tests skip automatically when `DATABASE_URL` is unset.

### End-to-end suite

`web/e2e/` runs the real client against a running server — registration,
X3DH, the ratchet, WebSocket push and the offline queue — which is the only
place a client/server contract drift shows up. It needs a live stack:

```sh
cd web && SHATTERS_E2E_URL=http://localhost:8080 npm run test:e2e
```

Unlike the integration tests, this one **fails** rather than skips when the
variable is unset: a green run that quietly tested nothing is worse than no
suite at all. `npm test` never includes it, so the unit suite stays runnable
without a server.

Note that the default rate limit (60/min, burst 20) will throttle the suite,
since enrolling one account costs three limited requests. CI raises
`RATE_LIMIT_BURST`; locally, either do the same or expect the later tests to
fail with `rate limit exceeded`.
