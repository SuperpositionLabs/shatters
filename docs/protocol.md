# Shatters Protocol (v2)

Status: draft, extracted from the legacy repositories ([shatters-sdk](https://github.com/SuperpositionLabs/shatters-sdk), [shatters-relay](https://github.com/SuperpositionLabs/shatters-relay)) and adapted to the Go/WebSocket architecture. This document is normative for server and client implementations.

## 1. Design principles

1. **The server is dumb.** It authenticates clients, relays ciphertexts, and stores opaque blobs plus public key material only. Plaintext and private keys never reach it.
2. **No custom cryptography.** Only audited primitives are allowed:
   - Server (Go): `crypto/ed25519`, `crypto/rand`, `golang.org/x/crypto/*` (HKDF-SHA256 where needed).
   - Client (TypeScript): `libsodium-wrappers` exclusively.
3. **Every change starts from an issue**, flows through a feature branch and a PR.
4. **Privacy by architecture, not by policy** — inherited verbatim from the legacy relay.

## 2. Cryptographic primitives

| Purpose | Primitive | Where |
|---|---|---|
| Identity signing / auth proofs | Ed25519 | Client generates; server verifies only |
| ECDH (identity) | X25519 | Client only |
| Prekey DH | X25519 | Client only |
| Session establishment | X3DH (Signal spec) | Client only |
| Session ratchet | Double Ratchet (forward + future secrecy) | Client only |
| Message AEAD | XChaCha20-Poly1305 (libsodium) | Client only |
| Local storage KDF | Argon2id | Client only |
| Account ID derivation | SHA-256 of identity key | Both (server stores hash only as identifier) |
| Session tokens | 256-bit random, stored hashed (SHA-256) server-side | Server issues/validates |

The server never performs symmetric decryption or any operation requiring secret user material.

## 3. Identity model

A client device owns two keypairs generated locally at signup:

- **Identity signing key**: Ed25519 `(ik_priv, ik_pub)`. Long-lived. Signs prekeys and authentication challenges.
- **Identity DH key**: X25519 `(dh_priv, dh_pub)`. Long-lived. Used in X3DH.

**Account ID** = `base64url(SHA-256(ik_pub || domain))`, with `domain = "shatters-account-v1"`. The raw public key is uploaded once at registration but all API addressing uses the account ID, keeping identifiers opaque.

There are no usernames, e-mails, or passwords anywhere in the system.

## 4. Registration

`POST /v1/accounts`

```json
{
  "identity_key":   "<base64 ed25519 public, 32 bytes>",
  "identity_dh_key": "<base64 x25519 public, 32 bytes>",
  "signed_prekey": {
    "id":        0,
    "public_key": "<base64 x25519 public>",
    "signature":  "<base64 ed25519 signature over \"shatters-spk-v1\" || public_key || id>"
  },
  "one_time_prekeys": [ { "id": 1, "public_key": "<base64>" } ]
}
```

Server-side validation (all public data):

- Key lengths exactly 32 bytes after base64 decode.
- Signed-prekey signature verifies against the identity key.
- At most `MAX_PREKEYS` (default 100) one-time prekeys per upload.

On success the server returns the derived account ID. Duplicate registrations with the same identity key return the existing account (idempotent).

## 5. Authentication (no passwords)

Inherited from the legacy relay's Ed25519 per-connection proofs, extended into an API-level flow:

1. `POST /v1/auth/challenge { "account_id": "..." }` → server returns a fresh 32-byte nonce, stored with a 5-minute TTL, single use.
2. Client signs `"shatters-auth-v1" || nonce` with `ik_priv`.
3. `POST /v1/auth/verify { "account_id", "signature" }` → on success the server issues a session token (256-bit random). The token is returned in the response body and stored **hashed** in the database with an expiry.

All authenticated endpoints accept `Authorization: Bearer <token>`.

Challenge issuance and verify endpoints are rate limited per IP (token bucket, no user tracking — same philosophy as the legacy relay).

## 6. Key directory

- `GET /v1/accounts/{account_id}/bundle` *(authenticated)* → returns `{ identity_key, identity_dh_key, signed_prekey, one_time_prekey }`.
- The one-time prekey is consumed atomically: `DELETE ... WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`. If none remain the response omits the field and the initiator falls back to the signed prekey (X3DH variant without OTK).
- `POST /v1/accounts/me/prekeys` *(authenticated)* tops up one-time prekeys.

## 7. Session establishment — X3DH

Follows the [Signal X3DH specification](https://signal.org/docs/specifications/x3dh/) with the identity-DH-key variant (both parties have X25519 identity keys):

```
DH1 = DH(IKa, SPKb)
DH2 = DH(EKa, IKb)
DH3 = DH(EKa, SPKb)
DH4 = DH(EKa, OPKb)      // when an OPK was fetched
SK  = HKDF(F || DH1..4, salt=0, info="shatters-x3dh-v1")
```

`F` is 32 bytes of `0xFF` (FIPS 186 curve bound, as in Signal). Associated data `AD = IKa_pub || IKb_pub` is fed into the first ratchet message.

The initial message carries: initiator identity key, ephemeral key, used prekey IDs, and the first ratchet payload — everything inside the envelope ciphertext except the fields the responder needs *before* possessing session state, which ride in a plaintext header block of the inner message (still invisible to the server because the outer envelope is opaque... the server only sees the outer blob).

## 8. Sessions — Double Ratchet

Follows the [Signal Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/): symmetric-chain and DH ratchets, header `{dh_pub, pn, n}`, skipped-message keys cached with a bounded window (max 2000 keys, max 64 skip chains), deleted immediately on use or replacement.

Guarantees: forward secrecy, post-compromise security (future secrecy), per-message keys never reused.

Session state serialization (client-local): encrypted with Argon2id-derived key before hitting IndexedDB/localStorage (M2/M4 work).

## 9. Envelopes and dead drops

Messages travel as **envelopes** — versioned, opaque blobs. The legacy relay's dead drop concept is kept:

```json
{
  "v": 1,
  "sender_account_id": "...",
  "ciphertext": "<base64, includes XChaCha20-Poly1305 tag>"
}
```

- Delivery path (M3): WebSocket push to online recipients; otherwise persisted in the `envelopes` table with a TTL (default 30 days) and pulled on reconnect.
- ACKs are client-signed receipts confirming retrieval; the server deletes envelopes upon confirmed delivery.
- The server cannot read `ciphertext`, learn recipients' contacts beyond routing metadata, or correlate beyond what §10 admits.

## 10. Metadata policy

Stored by the server (exhaustive list):

| Data | Why |
|---|---|
| Account ID (hash of public key) | Addressing |
| Public keys + prekeys | Key directory function |
| Envelope bytes, sender/receiver IDs, created/expires timestamps | Offline delivery |
| Hashed session tokens | Authentication |
| Per-IP rate-limit buckets (in-memory only) | Abuse resistance |

Never stored: plaintext, private keys, passwords (none exist), IP addresses persisted long-term, contact graphs beyond observed deliveries.

See [threat-model.md](threat-model.md) for the adversary analysis this table supports.

## 11. Transport note (legacy deviation)

The legacy stack used QUIC (MsQuic/quinn) + TLS 1.3. v2 standardizes on **WebSocket over TLS** (wss) behind a reverse proxy for operability. The zero-knowledge property does not depend on transport: it follows from client-side crypto and opaque payloads. TLS terminates at the reverse proxy; the Go service itself sees already-decrypted-at-TLS-layer but still fully opaque envelope bytes.

## 12. Compatibility

No wire compatibility with v1 is attempted: the C++ SDK is retired and clients are rewritten. Protocol versioning starts at `shatters-*-v1` domain strings and envelope `"v": 1`.
