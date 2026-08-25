/**
 * Local identity management for the shatters client.
 *
 * Everything in this module runs on the user's device. Private keys are
 * generated here and are NEVER transmitted; the server only ever sees the
 * public halves and opaque identifiers derived from them.
 *
 * The derivations below MUST stay byte-compatible with the Go server's
 * `server/internal/crypto` package (see docs/protocol.md).
 */
import _sodium from "libsodium-wrappers-sumo";

export const ACCOUNT_DOMAIN = "shatters-account-v1";
export const SIGNED_PREKEY_DOMAIN = "shatters-spk-v1";

type Sodium = typeof _sodium;

let readyPromise: Promise<Sodium> | null = null;

/** Loads and warms up the libsodium WASM module exactly once. */
export async function sodium(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await _sodium.ready;
      return _sodium;
    })();
  }
  return readyPromise;
}

/** A libsodium keypair (`publicKey`/`privateKey` as Uint8Array). */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  keyType: string;
}

/** The two long-lived keypairs every device owns. */
export interface Identity {
  /** Ed25519 - signs prekeys and authentication challenges. */
  signing: KeyPair;
  /** X25519 - participates in X3DH session initiation. */
  dh: KeyPair;
}

/** Generates a fresh device identity entirely in local memory/WASM. */
export async function generateIdentity(): Promise<Identity> {
  const s = await sodium();
  return {
    signing: s.crypto_sign_keypair(),
    dh: s.crypto_kx_keypair(),
  };
}

/** base64url without padding - the account ID alphabet. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derives the public, opaque account identifier:
 *   base64url(SHA-256("shatters-account-v1" || ed25519_public_key))
 * Must match the Go implementation `crypto.AccountID`.
 */
export async function accountId(
  identityPublicKey: Uint8Array,
): Promise<string> {
  const s = await sodium();
  const domain = new TextEncoder().encode(ACCOUNT_DOMAIN);
  const input = new Uint8Array(domain.length + identityPublicKey.length);
  input.set(domain);
  input.set(identityPublicKey, domain.length);
  const digest = s.crypto_hash_sha256(input);
  return toBase64Url(digest);
}

/** Detached Ed25519 signature over an arbitrary message. */
export async function signDetached(
  privateKey: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const s = await sodium();
  return s.crypto_sign_detached(message, privateKey);
}

export interface SignedPrekey {
  id: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

/**
 * Creates an X25519 signed prekey bound to this identity:
 *   signature = Ed25519("shatters-spk-v1" || x25519_public || id_be32)
 * Must match the Go verification in `crypto.VerifySignedPrekey`.
 */
export async function createSignedPrekey(
  signingPrivateKey: Uint8Array,
  id: number,
): Promise<SignedPrekey> {
  const s = await sodium();
  const spk = s.crypto_kx_keypair();

  const domain = new TextEncoder().encode(SIGNED_PREKEY_DOMAIN);
  const idBytes = new Uint8Array(4);
  new DataView(idBytes.buffer).setUint32(0, id, false); // big-endian
  const message = new Uint8Array(
    domain.length + spk.publicKey.length + idBytes.length,
  );
  message.set(domain);
  message.set(spk.publicKey, domain.length);
  message.set(idBytes, domain.length + spk.publicKey.length);

  const signature = await signDetached(signingPrivateKey, message);
  return { id, publicKey: spk.publicKey, signature };
}
