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

Run the server test suite:

```sh
cd server
go test ./...
```

## Status

v2 development follows milestone-based git-flow. Current state:

| Milestone | Scope | State |
|---|---|---|
| M0 – Foundation | Monorepo, CI, migrations | ✅ done |
| M1 – Identities | Registration, prekeys, key directory | ✅ done |
| M2 – E2EE Sessions | X3DH + Double Ratchet | 🚧 crypto done; session persistence open |
| M3 – Transport | Authenticated WebSocket, offline queue | 🚧 server done; client transport open |
| M4 – Encrypted Persistence | Client-side history | ⬜ |
| M5 – Hardening | Rate limiting, fuzzing, audits | ⬜ |
| M6 – Deploy & Docs | Release image, diagrams | ⬜ |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: everything starts from an
issue, lands on a feature branch, and reaches `develop` through a PR gated by
CI (lint, gosec, govulncheck, race-enabled tests).

## License

GNU GPLv3 — see [LICENSE](LICENSE).
