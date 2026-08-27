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

**Account ID** = `base64url(SHA-256(domain || ik_pub))`, with `domain = "shatters-account-v1"`. The domain separator is a *prefix*, matching the `shatters-spk-v1` and `shatters-auth-v1` constructions below: it binds the digest to its purpose before any attacker-influenced bytes are absorbed. The raw public key is uploaded once at registration but all API addressing uses the account ID, keeping identifiers opaque.

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
3. `POST /v1/auth/verify { "account_id", "nonce", "signature" }` → on success the server issues a session token (256-bit random). The token is returned in the response body and stored **hashed** in the database with an expiry.

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

`F` is 32 bytes of `0xFF` (FIPS 186 curve bound, as in Signal). `IKa`/`IKb` in the DH steps are the **X25519** identity keys (§3); `SK` is 32 bytes, HKDF salt is `0x00 * 32`.

Associated data `AD = IKa_pub || IKb_pub` is fed into the first ratchet message, using the **Ed25519** identity keys, initiator first. Signal has a single identity key so the spec need not distinguish; shatters has two, and the Ed25519 key is the one account IDs derive from — binding it ties the session to the two addressable identities rather than to key material the server hands out.

The initial message carries: initiator identity key, ephemeral key, used prekey IDs, and the first ratchet payload — everything inside the envelope ciphertext except the fields the responder needs *before* possessing session state, which ride in a plaintext header block of the inner message (still invisible to the server because the outer envelope is opaque... the server only sees the outer blob).

## 8. Sessions — Double Ratchet

Follows the [Signal Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/): symmetric-chain and DH ratchets, header `{dh_pub, pn, n}`, skipped-message keys cached with a bounded window (max 2000 keys, max 64 skip chains), deleted immediately on use or replacement.

Concrete constructions:

```
(RK', CK) = HKDF-SHA256(salt=RK, ikm=DH_out, info="shatters-ratchet-root-v1", 64)
mk        = HMAC-SHA256(CK, 0x01)
CK'       = HMAC-SHA256(CK, 0x02)
key||nonce = HKDF-SHA256(salt=0, ikm=mk, info="shatters-msg-v1", 32+24)
ciphertext = XChaCha20-Poly1305(key, nonce, plaintext, ad = AD || header)
header     = dh_pub || pn_be32 || n_be32      (40 bytes)
```

The per-message nonce is derived from `mk` rather than transmitted: it costs no bytes on the wire and cannot be influenced by an attacker. Reuse is impossible because a message key is produced once by the chain and destroyed on use.

The header is authenticated as part of the AEAD associated data, so a reordered or retargeted header fails the tag instead of decrypting to the wrong plaintext.

A message that fails to authenticate must leave the session state untouched. Acting on an unverified header would let a single forged packet advance the root key and rebuild both chains around a ratchet key the peer never used, permanently desynchronising a live conversation.

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

The `ciphertext` field carries the **inner message**, a binary structure whose leading fields are unencrypted *within* the envelope. The responder needs the X3DH header before it holds any session state (§7), so it cannot be sealed; the server still learns nothing, because it only ever sees the outer blob.

```
version : u8 = 1
type    : u8 = 1 (initial) | 2 (normal)

if type == 1:
  identity_key       : 32
  identity_dh_key    : 32
  ephemeral_key      : 32
  signed_prekey_id   : u32be
  has_otk            : u8
  one_time_prekey_id : u32be     (only when has_otk = 1)

dh_pub     : 32                  ratchet header (§8)
pn         : u32be
n          : u32be
ciphertext : remainder           XChaCha20-Poly1305, tag included
```

A `type` byte rather than a length-prefixed union keeps parsing total: unknown versions, unknown types and truncated fields are decode errors, never a silently different message. A clipped *ciphertext* is not detectable here by design — the AEAD tag rejects it.

An initiator repeats the type 1 header on every message until it successfully decrypts one from the responder, since until then it cannot know the handshake arrived.

### Offline queue endpoints (all authenticated)

- `POST /v1/envelopes` — `{recipient_id, payload}`; the payload is base64 and opaque. The server decodes it only to enforce the 64 KiB cap and never inspects the bytes. The sender is taken from the session, never from the request, so a message cannot be attributed to someone else.
- `GET /v1/envelopes` — returns up to 100 queued envelopes for the **caller**, oldest first. There is no parameter naming a recipient; scoping comes from the bearer token alone.
- `POST /v1/envelopes/ack` — `{envelope_ids}`; deletes them and reports how many were removed.

Fetching deliberately does **not** delete. A client that dies mid-transfer must see its envelopes again rather than lose them, so fetch is idempotent until acknowledged, and acknowledging is idempotent in turn. Acknowledgement is scoped to the caller's own account: an id belonging to someone else matches nothing, so a caller cannot delete another account's mail or learn that the id exists.

Expired envelopes are never served regardless of whether a sweep has run, and each recipient's queue is capped at 10 000 live envelopes so an unreachable account cannot be used to exhaust storage.

> **Deviation from the original draft.** Earlier revisions described ACKs as *client-signed receipts*. As implemented they are authenticated but unsigned: the bearer token already proves who is deleting, and the server is the only party that reads an ACK. A signature would add value only for **delivery receipts relayed back to the sender**, which nothing implements yet — and a receipt the server can show to a sender is a non-repudiable record of who received what, which is metadata this design otherwise avoids creating. If delivery receipts are wanted, they belong end-to-end inside an envelope, not as a server-visible signature.

### Live delivery — `GET /v1/ws`

Connected recipients are pushed to instead of polling. The socket is a **push and acknowledge** channel; sending always goes through `POST /v1/envelopes`, so there is one code path that stores, caps and attributes an envelope.

**Authentication is by first frame, not by header.** Browsers cannot set `Authorization` on a WebSocket handshake, and the two usual workarounds are both worse: a token in the query string lands in proxy access logs, browser history and `Referer` headers, and `Sec-WebSocket-Protocol` is still a handshake header that proxies commonly log. Instead the socket opens unauthenticated and must send `{"type":"auth","token":"..."}` within 10 seconds; anything else closes it. The token then only ever appears in a frame body.

Client frames: `auth`, `ack` (`{envelope_ids}`), `ping`. Server frames: `ready`, `envelope`, `acked`, `pong`, `error`. Unknown client types are ignored rather than fatal, so new frame types do not break older servers.

Operational properties:

- The connection joins the hub **before** `ready` is sent. A client that has seen `ready` may expect pushes, so registering second would silently drop anything sent in that window.
- An account may hold several connections (devices, tabs); every one receives each push, since the server cannot know which the user is looking at.
- **A push never deletes.** The row survives until acknowledged, so a push lost in flight is redelivered on the next fetch. Sending therefore never depends on the recipient's connectivity — an offline recipient is not an error.
- Per-connection send buffers are bounded. A wedged consumer has its socket dropped rather than being allowed to grow server memory: losing a socket is cheap, losing a message is not.
- Ping/pong keepalive with read and write deadlines; cross-origin handshakes are rejected, since the same-origin policy does not apply to WebSockets and any site could otherwise open an authenticated socket in a visitor's browser.
- Sockets are hijacked connections, which `http.Server.Shutdown` neither tracks nor waits for, so they are closed explicitly on shutdown.

Recipients who are not connected fall back to the queue above: envelopes persist with a TTL (default 30 days) and are pulled on reconnect.
- The server cannot read `ciphertext`, learn recipients' contacts beyond routing metadata, or correlate beyond what §10 admits.

## 9a. Groups

Groups are a client-side construction. The server learns nothing about them: no
group exists in the schema, membership is never uploaded, and the envelopes
belonging to one message are indistinguishable from unrelated direct messages.

**Delivery is pairwise fan-out.** A group message is encrypted separately for
each member over the ratchet session that already exists with them, costing
*one envelope per member*. A shared sender key would be cheaper, but it trades
away exactly what the Double Ratchet provides: a key shared by the group has no
per-recipient forward secrecy, and removing a member requires rotating and
redistributing it. For the group sizes a self-hosted instance realistically
serves, the envelope cost is the better side of that trade. It is stated here
rather than left to be discovered from a bandwidth graph.

**The group id is random**, never derived from its membership. An id computed
from who is in the group would leak precisely that to anyone who saw one.

### Convergence without a server

There is no authority to order membership changes, and a member who was offline
for several of them must converge on rejoining without replaying them in order.
Membership is therefore a **last-writer-wins element set**: each account carries
the time it was last added and last removed, and is a member when the add is
more recent. Both operations commute and are idempotent, so any order of any
subset reaches the same result. The group name is last-writer-wins on the same
basis.

Two devices can stamp the same millisecond, and "whichever arrived first" is not
a rule everyone can agree on, so exact ties are broken by comparing the author
id. Arbitrary, but identical everywhere, which is the only property required.

Wall clocks are not comparable across devices, so a change is stamped **one past
the newest change its author has already seen** whenever that exceeds the local
clock. Without this, a member whose clock lagged would lose every edit they
made — permanently, and with no feedback explaining why.

### Authorisation

A group message or membership change is accepted only from an account that is a
current member **in the recipient's own view**. Anyone who learns a group id
could otherwise inject messages into it, or add themselves to it. Removed
members are told they were removed, so they stop delivering locally rather than
waiting to notice the silence.

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
