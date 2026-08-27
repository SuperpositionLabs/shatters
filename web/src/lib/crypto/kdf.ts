/**
 * HKDF-SHA256 (RFC 5869) for the shatters client.
 *
 * `libsodium-wrappers-sumo` exposes the `crypto_kdf_hkdf_sha256_*` constants
 * but not the extract/expand functions in this build, so HKDF is composed here
 * from `crypto_auth_hmacsha256`. This is not custom cryptography: the keyed
 * hash is still libsodium's audited HMAC-SHA256, and the composition follows
 * RFC 5869 verbatim. `kdf.test.ts` pins the output against Go's
 * `golang.org/x/crypto/hkdf`, which is what the two implementations must agree
 * on (see docs/protocol.md §7).
 */
import { sodium } from "./identity";

/** Output size of SHA-256, and therefore of one HKDF expansion block. */
export const HASH_LENGTH = 32;

/**
 * RFC 5869 extract-then-expand.
 *
 * @param ikm     input keying material (the concatenated DH outputs for X3DH)
 * @param salt    must be `HASH_LENGTH` bytes; X3DH uses all zeroes
 * @param info    domain separator, e.g. `"shatters-x3dh-v1"`
 * @param length  desired output length in bytes
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Promise<Uint8Array> {
  const s = await sodium();

  if (salt.length !== HASH_LENGTH) {
    // libsodium's one-shot HMAC takes a fixed 32-byte key, so a salt of any
    // other length would be silently mishandled rather than rejected.
    throw new Error(`hkdfSha256: salt must be ${HASH_LENGTH} bytes`);
  }
  // RFC 5869 §2.3 caps the output at 255 blocks.
  if (length < 1 || length > 255 * HASH_LENGTH) {
    throw new Error(`hkdfSha256: length must be 1..${255 * HASH_LENGTH}`);
  }

  // Extract: PRK = HMAC(salt, IKM)
  const prk = s.crypto_auth_hmacsha256(ikm, salt);

  // Expand: T(i) = HMAC(PRK, T(i-1) || info || i)
  const infoBytes = new TextEncoder().encode(info);
  const blocks = Math.ceil(length / HASH_LENGTH);
  const okm = new Uint8Array(blocks * HASH_LENGTH);

  let previous: Uint8Array = new Uint8Array(0);
  for (let i = 1; i <= blocks; i++) {
    const input = new Uint8Array(previous.length + infoBytes.length + 1);
    input.set(previous);
    input.set(infoBytes, previous.length);
    input[input.length - 1] = i;

    const block = s.crypto_auth_hmacsha256(input, prk);
    okm.set(block, (i - 1) * HASH_LENGTH);
    if (previous.length > 0) s.memzero(previous);
    previous = block;
  }

  const out = okm.slice(0, length);
  s.memzero(okm);
  s.memzero(prk);
  if (previous.length > 0) s.memzero(previous);
  return out;
}
