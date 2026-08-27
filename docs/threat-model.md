# Shatters Threat Model (v2)

Status: draft. Extracted from the legacy relay/sdk design and adapted to the Go + WebSocket + PostgreSQL architecture.

## 1. Assets

| Asset | Sensitivity |
|---|---|
| Message plaintext | Highest — never exists outside client memory |
| Private keys (identity, prekeys, ratchet state) | Highest — never leave the client |
| Client-local history DB | High — encrypted at rest with an Argon2id-derived key |
| Session tokens | Medium — grant API access as the identity; stored hashed server-side |
| Public key material | Public by definition; integrity matters, confidentiality does not |
| Envelope ciphertext blobs | Confidentiality guaranteed by AEAD; metadata value analyzed in §5 |

## 2. Trust boundaries

```
┌──────────────┐   TLS    ┌─────────────────────────┐
│   Client     │◄────────►│  Reverse proxy (TLS)     │
│  (trusted,   │   wss    ├─────────────────────────┤
│  holds all   │          │  Go server (untrusted    │
│  secrets)    │          │  for content: auth,      │
└──────────────┘          │  routing, blob storage)  │
                          ├─────────────────────────┤
                          │  PostgreSQL (same trust  │
                          │  level as server)        │
                          └─────────────────────────┘
```

Everything inside the dashed reality of the server+DB is treated as **honest-but-curious and potentially compromised**: the system's guarantees must not depend on it behaving.

## 3. Adversaries

### A1 — Passive network observer
Sees TLS-protected traffic only. Learns connection timing and volume to a self-hosted deployment. Cannot read content (TLS + E2EE).

### A2 — Malicious server operator / full server compromise
The central adversary of a self-hosted messenger. Capabilities assumed:
- Read all stored data (accounts, public keys, envelopes).
- Observe all API/WebSocket activity.
- Delay, reorder, drop, or replay envelopes (DoS is always possible).

What A2 **cannot** do (and which property blocks it):
- Read message content → Double Ratchet + XChaCha20-Poly1305.
- Forge messages → sender-side authentication via MAC keys derived through the ratchet; X3DH binds session keys to both identity keys.
- Learn private keys → they never leave the client.
- Impersonate a user at the API level → auth requires an Ed25519 signature over a fresh nonce; tokens are bearer but short-lived and revocable by expiry.
- Roll back one-time prekey consumption meaningfully → OTKs are deleted atomically on fetch; replaying old bundles can at worst enable re-establishment attempts detectable by the responder (prekey signature covers SPK; OPK reuse visible to client logic).

Residual risks accepted and documented:
- **Metadata exposure**: the server learns who talks to whom (account IDs), when, and envelope sizes/timing. §5 minimizes but does not eliminate this.
- **Key substitution** (server serves attacker's keys to new sessions): partially mitigated. Every key in a bundle is signed by the identity key and verified by the client (protocol §4, §6), so the operator cannot substitute a prekey without also substituting the identity key. Substituting the *identity* key remains possible against a first contact, and is addressed by safety numbers and a key-change warning (§9b). The warning is the effective control: it fires automatically, whereas comparing a fingerprint requires the user to do something. Neither helps someone who ignores both, which is why this is listed as reduced rather than eliminated.
- **Replay of delivery**: envelopes carry client-chosen message counters inside the ratchet; duplicates are dropped by clients.

### A3 — Active MITM without server compromise
Blocked by TLS (self-hosted deployments control their own certs). Certificate pinning existed in legacy SDK; v2 relies on standard Web PKI plus the fact that even a TLS-breaking MITM still cannot read E2EE content — it can only DoS.

### A4 — Endpoint compromise (malware on user device)
Out of scope. No messenger survives this. Local storage encryption narrows the window for *at-rest* theft of a powered-off device: ratchet state and history are sealed under an Argon2id key derived from the user passphrase.

## 4. Security goals (inherited from legacy design)

1. **Confidentiality** against A1–A3.
2. **Forward secrecy**: compromise of long-term keys does not reveal past messages (Double Ratchet chains).
3. **Post-compromise security**: sessions heal after key compromise (DH ratchet reinjection).
4. **Authentication**: messages unforgeable; API actions attributable to key holders.
5. **Zero-knowledge serving**: the server performs no operation that requires user secret material — verified by code review rule "crypto touches need rationale" in every PR.
6. **No credential reuse**: no passwords exist anywhere; nothing to leak or re-use across sites.

## 5. Metadata minimization

Inherited from the legacy relay ("no user tracking"), constrained by v2's added key-directory role:

| Legacy relay | v2 | Rationale for change |
|---|---|---|
| Opaque 32-byte channel IDs, no accounts | Account IDs = SHA-256(public key); directory of public keys | M1 requires offline handshakes and key discovery |
| Prekey bundles in RAM, lost on restart | Prekeys in PostgreSQL | Durability for async X3DH |
| Dead-drop TTL in RAM | TTL column, background sweeper | Same semantics, durable |

Kept verbatim from legacy:
- Per-IP token-bucket rate limiting with **no persistent user tracking** (buckets live in process memory only).
- Ed25519 proof-of-possession for authenticated actions (channel-scoped proofs → per-account challenges).
- Envelopes are opaque; the server parses only outer routing fields.

Explicitly rejected: IP logging, analytics, third-party scripts/CDNs in the web client, telemetry.

## 6. Non-goals

- Anonymity against a global passive adversary (traffic-correlation attacks on self-hosted servers are out of scope).
- Spam resistance without invitation/contact models (identity keys make sybil cheap; addressed later if needed).
- Protection against endpoint compromise (§A4).
- Deniability: X3DH offers partial cryptographic deniability, but v2 does not claim strong deniability properties.

## 7. Verification strategy mapped to threats

| Threat | Mitigation verification |
|---|---|
| Server-side crypto mistakes | gosec + govulncheck in CI; PR review rule for `crypto/` paths; server crypto surface kept minimal (verify-only) |
| Protocol bugs (ratchet misuse) | Interop test vectors between TS client implementation and published Signal spec behavior (M2); fuzzing of envelope parsing (M5) |
| Token/auth weaknesses | Short TTLs, hashed-at-rest tokens, constant-time comparisons (`crypto/subtle`), per-IP limits (M1/M5) |
| Dependency vulnerabilities | govulncheck on every push; Dependabot-equivalent review cadence (M5 audit issue) |

## 6. Notes added after implementation

Recording what the build changed about the analysis, rather than leaving the
document describing an earlier design.

- **Group membership is client-side.** The server has no notion of a group: no
  table, no membership, no way to tell that several envelopes belong to one
  message. The cost is one envelope per member (protocol §9a), which is
  observable to A2 as fan-out timing and volume — a member count, not a
  membership list.
- **Expired data is deleted rather than merely hidden.** Envelopes,
  authentication challenges and session tokens are swept on a schedule.
  Previously they were excluded from reads but retained indefinitely, which
  left recoverable ciphertext on the operator's disk long after it stopped
  being useful.
- **Notifications leave the vault.** An OS notification outlives the
  application's own lock and sits where anyone holding the device can read it.
  The default reveals neither sender nor content; anything more is opt-in.
- **Search builds no index.** Filtering runs over decrypted history in memory.
  An index would have to be stored, and an unencrypted index of message text
  would undo the vault entirely.
- **A1 sees more with a single-user instance.** On a self-hosted deployment
  with few accounts, traffic analysis is far more informative than the
  metadata table suggests: an observer who knows there is one user learns that
  user's activity pattern directly. Nothing in the design fixes this; it is a
  property of running your own server.
