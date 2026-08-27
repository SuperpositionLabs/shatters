<p align="center">
  <img src="assets/branding.svg" alt="shatters" />
</p>

# shatters

**Secure, self-hosted messaging with end-to-end encryption. Own your conversations.**

A private, encrypted chat system for people who want complete control over their
communication: no third parties, no data collection, no plaintext on the server —
just clean, reliable message relay.

> This is the v2 rewrite of shatters. The legacy stack
> ([shatters-sdk](https://github.com/SuperpositionLabs/shatters-sdk) (C++23),
> [shatters-relay](https://github.com/SuperpositionLabs/shatters-relay) (Rust),
> [shatters-client](https://github.com/SuperpositionLabs/shatters-client) (Tauri))
> remains available as historical reference; v2 replaces all three.

## How it works

- **The server is dumb.** It authenticates clients, relays opaque ciphertext, and
  stores public keys plus encrypted blobs. Plaintext and private keys never reach it.
- **All cryptography lives on your device.** Identity keys (Ed25519/X25519), X3DH
  key agreement, and the Double Ratchet run client-side using libsodium.
- **Zero-knowledge by architecture**: the operator cannot read messages, only
  observe that encrypted envelopes move between anonymous key-derived IDs.

Read more in [`docs/protocol.md`](docs/protocol.md) and
[`docs/threat-model.md`](docs/threat-model.md).

## Repository layout

```
├── server/     Go backend (chi + gorilla/websocket + PostgreSQL)
├── web/        Next.js client — all E2EE happens here
├── deploy/     Docker Compose for local development
└── docs/       Protocol specification and threat model
```

## Quick start

Prerequisites: Docker (or Go 1.25+ / Node 22+ for manual runs).

```sh
cd deploy
docker compose up --build
```

Then:

- API: http://localhost:8080/healthz
- PostgreSQL: localhost:5432 (`shatters` / `shatters-dev`, dev-only credentials)

### Server configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on |
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `RATE_LIMIT_PER_MINUTE` | `60` | Sustained per-IP rate on unauthenticated endpoints |
| `RATE_LIMIT_BURST` | `20` | Per-IP burst allowance |
| `CORS_ALLOWED_ORIGINS` | *(none)* | Comma-separated browser origins allowed to call from elsewhere |
| `SWEEP_INTERVAL` | `1h` | How often expired rows are deleted; `0` disables the sweeper |

Rate limiting is per-IP and in-memory only — no user is tracked. An invalid or
non-positive limit refuses to start rather than falling back to a default, so a
typo cannot silently leave the endpoints unprotected.

`CORS_ALLOWED_ORIGINS` is empty by default, meaning **same-origin only** — the
normal deployment puts client and server behind one reverse proxy. Set it only
when the client is served from somewhere else (a CDN, or `next dev` on port
3000). Origins are matched exactly, scheme and port included; `*` is rejected
at startup rather than honoured. The WebSocket handshake reads the same list.

The sweeper deletes expired envelopes, unanswered authentication challenges
and lapsed session tokens. Expired rows are already invisible to readers, so
this is not about correctness — it is about not keeping data the design
promised to discard. Set `SWEEP_INTERVAL=0` if you would rather run the
deletes from your own cron.

For local development against `next dev`, point the client at the API and
allow its origin:

```sh
# web/.env.local
NEXT_PUBLIC_SHATTERS_API=http://localhost:8080
```

```sh
# already set in deploy/docker-compose.yml
CORS_ALLOWED_ORIGINS=http://localhost:3000
```

Run the test suites:

```sh
cd server && go test ./...
```

```sh
cd web && npm test
```

## Features

| | |
|---|---|
| **Messaging** | Direct and group conversations, replies, edits, deletions, emoji reactions |
| **Delivery** | Live WebSocket push, offline queue with a 30-day TTL, delivery and read receipts, typing indicators |
| **Files** | Attachments of any size, chunked to fit the envelope cap |
| **History** | Encrypted on-device storage, survives reload, searchable without an index |
| **Identity** | No usernames, e-mails or passwords — an account *is* a keypair |
| **Verification** | Safety numbers and an automatic warning when a contact's key changes |
| **Notifications** | Desktop notifications that reveal nothing by default |

## Status

All milestones complete. v2 development followed milestone-based git-flow:

| Milestone | Scope | State |
|---|---|---|
| M0 – Foundation | Monorepo, CI, migrations | ✅ done |
| M1 – Identities | Registration, prekeys, key directory | ✅ done |
| M2 – E2EE Sessions | X3DH + Double Ratchet | ✅ done |
| M3 – Transport | Authenticated WebSocket, offline queue | ✅ done |
| M4 – Encrypted Persistence | Client-side history | ✅ done |
| M5 – Hardening | Rate limiting, fuzzing, audits | ✅ done |
| M6 – Deploy & Docs | Release image, documentation | ✅ done |

### What this is not

Being explicit is more useful than a feature list that quietly omits things.

- **No voice or video.** Calls need WebRTC signalling and a TURN server, which
  is a different product with a different metadata profile.
- **No multi-device.** One account is one device. Linking a second would need
  the identity key to leave the device it was generated on, which is the one
  thing this design refuses.
- **No account recovery.** Forgetting the passphrase loses the history, and
  losing the device loses the account. That is what "no third parties" costs.
- **Not independently audited.** The cryptography follows the Signal
  specifications and uses only libsodium and the Go standard library, but no
  external review has been done.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: everything starts from an
issue, lands on a feature branch, and reaches `develop` through a PR gated by
CI (lint, gosec, govulncheck, race-enabled tests).

## License

GNU GPLv3 — see [LICENSE](LICENSE).
