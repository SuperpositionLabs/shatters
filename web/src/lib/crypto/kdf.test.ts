import { describe, expect, it } from "vitest";

import { sodium } from "./identity";
import { HASH_LENGTH, hkdfSha256 } from "./kdf";

const ZERO_SALT = new Uint8Array(HASH_LENGTH);

describe("hkdfSha256", () => {
  it("matches the Go x/crypto/hkdf reference vector", async () => {
    // Golden vector for the RFC 5869 composition in kdf.ts, computed with
    // golang.org/x/crypto/hkdf so the HMAC-based expansion here is pinned to a
    // reference implementation rather than to itself. Regenerate with:
    //
    //   ikm := make([]byte, 32)
    //   for i := range ikm { ikm[i] = byte(i) }
    //   r := hkdf.New(sha256.New, ikm, make([]byte, 32), []byte("shatters-x3dh-v1"))
    //   out := make([]byte, 32); io.ReadFull(r, out)
    //
    // The server never derives X3DH keys (protocol §1), so this is pinned
    // client-side only - there is no Go counterpart that could drift.
    const ikm = new Uint8Array(32);
    for (let i = 0; i < ikm.length; i++) ikm[i] = i;

    const s = await sodium();
    const out = await hkdfSha256(ikm, ZERO_SALT, "shatters-x3dh-v1", 32);

    expect(s.to_base64(out, s.base64_variants.ORIGINAL)).toBe(
      "UzVQEQ71F+8FdvviumXHXspRnNdnMlU/C3LlU69xD9k=",
    );
  });

  it("is deterministic and separates by info", async () => {
    const ikm = new Uint8Array(32).fill(7);

    const a = await hkdfSha256(ikm, ZERO_SALT, "info-a", 32);
    const again = await hkdfSha256(ikm, ZERO_SALT, "info-a", 32);
    const b = await hkdfSha256(ikm, ZERO_SALT, "info-b", 32);

    expect(a).toEqual(again);
    expect(a).not.toEqual(b);
  });

  it("expands across multiple blocks", async () => {
    const ikm = new Uint8Array(32).fill(3);

    const long = await hkdfSha256(ikm, ZERO_SALT, "x", 96);
    const short = await hkdfSha256(ikm, ZERO_SALT, "x", 32);

    expect(long).toHaveLength(96);
    // The first block of a longer expansion is the same as a short one.
    expect(long.slice(0, 32)).toEqual(short);
    // Later blocks are not a repeat of the first.
    expect(long.slice(32, 64)).not.toEqual(short);
  });

  it("rejects a salt of the wrong length", async () => {
    const ikm = new Uint8Array(32);
    await expect(hkdfSha256(ikm, new Uint8Array(16), "x", 32)).rejects.toThrow(
      /salt must be 32 bytes/,
    );
  });

  it("rejects out-of-range output lengths", async () => {
    const ikm = new Uint8Array(32);
    await expect(hkdfSha256(ikm, ZERO_SALT, "x", 0)).rejects.toThrow(/length/);
    await expect(
      hkdfSha256(ikm, ZERO_SALT, "x", 255 * HASH_LENGTH + 1),
    ).rejects.toThrow(/length/);
  });
});
