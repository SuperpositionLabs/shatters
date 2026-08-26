import { describe, expect, it } from "vitest";

import {
  accountId,
  authProofMessage,
  createAuthProof,
  createSignedPrekey,
  generateIdentity,
  toBase64Url,
} from "./identity";

// Reference values computed against the Go server implementation semantics
// (base64url unpadded of SHA-256("shatters-account-v1" || ik)).
const ZERO_KEY = new Uint8Array(32);

describe("identity", () => {
  it("generates both keypairs locally", async () => {
    const identity = await generateIdentity();
    expect(identity.signing.publicKey).toHaveLength(32);
    expect(identity.signing.privateKey).toHaveLength(64);
    expect(identity.dh.publicKey).toHaveLength(32);
    expect(identity.dh.privateKey).toHaveLength(32);
  });

  it("derives deterministic 43-char account ids", async () => {
    const id1 = await accountId(ZERO_KEY);
    const id2 = await accountId(ZERO_KEY);
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(43);
    expect(id1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("matches the Go reference vector", async () => {
    // Golden vector from server/internal/crypto/keys_test.go:
    // base64url(SHA-256("shatters-account-v1" || 32 zero bytes)).
    const expected =
      "Wz9jOwRx1yVVyJB2l-fPxYeZ52FFZYKFKYOCLrFzKLo";
    expect(await accountId(ZERO_KEY)).toBe(expected);
  });

  it("separates different identities", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(await accountId(a.signing.publicKey)).not.toBe(
      await accountId(b.signing.publicKey),
    );
  });

  it("creates verifiable signed prekeys", async () => {
    const { sodium } = await import("./identity");
    const s = await sodium();
    const identity = await generateIdentity();
    const spk = await createSignedPrekey(identity.signing.privateKey, 42);

    const domain = new TextEncoder().encode("shatters-spk-v1");
    const idBytes = new Uint8Array(4);
    new DataView(idBytes.buffer).setUint32(0, 42, false);
    const msg = new Uint8Array(domain.length + spk.publicKey.length + 4);
    msg.set(domain);
    msg.set(spk.publicKey, domain.length);
    msg.set(idBytes, domain.length + spk.publicKey.length);

    expect(
      s.crypto_sign_verify_detached(spk.signature, msg, identity.signing.publicKey),
    ).toBe(true);

    idBytes[3] ^= 1; // tamper the id
    msg.set(idBytes, domain.length + spk.publicKey.length);
    // crypto_sign_verify_detached reports invalidity as `false`, not an exception.
    expect(
      s.crypto_sign_verify_detached(spk.signature, msg, identity.signing.publicKey),
    ).toBe(false);
  });

  it("creates auth proofs the server accepts", async () => {
    const { sodium } = await import("./identity");
    const s = await sodium();
    const identity = await generateIdentity();
    const nonce = s.randombytes_buf(32);

    const proof = await createAuthProof(identity.signing.privateKey, nonce);

    // Valid over the domained message...
    expect(
      s.crypto_sign_verify_detached(
        proof,
        authProofMessage(nonce),
        identity.signing.publicKey,
      ),
    ).toBe(true);

    // ...and specifically NOT a signature over the bare nonce, which is what
    // the server rejects with 401.
    expect(
      s.crypto_sign_verify_detached(proof, nonce, identity.signing.publicKey),
    ).toBe(false);
  });

  it("matches the Go auth-proof reference vector", async () => {
    // Golden vector from server/internal/crypto/auth_test.go:
    // Ed25519(seed=0x00*32, "shatters-auth-v1" || 0x00*32).
    const { sodium } = await import("./identity");
    const s = await sodium();
    const { privateKey } = s.crypto_sign_seed_keypair(new Uint8Array(32));

    const proof = await createAuthProof(privateKey, new Uint8Array(32));

    const expected =
      "hW2gkIMjzOoTKetCo5bnVDbOqUYwjzyypFyq5orI8I1DyJqN2M4+EsG8dF/W4dDqqF8FCSqnzTSLo8kFpxoyDw==";
    expect(s.to_base64(proof, s.base64_variants.ORIGINAL)).toBe(expected);
  });

  it("encodes base64url without padding", () => {
    expect(toBase64Url(new Uint8Array([251, 255, 190]))).toBe("-_--");
  });
});
