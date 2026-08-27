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
export const AUTH_DOMAIN = "shatters-auth-v1";
export const IDENTITY_DH_DOMAIN = "shatters-idk-v1";

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

/**
 * Builds the exact byte string the server verifies an auth proof over:
 *   "shatters-auth-v1" || nonce
 *
 * Exported so tests can pin the construction; callers should prefer
 * `createAuthProof`.
 */
export function authProofMessage(nonce: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(AUTH_DOMAIN);
  const message = new Uint8Array(domain.length + nonce.length);
  message.set(domain);
  message.set(nonce, domain.length);
  return message;
}

/**
 * Answers a `POST /v1/auth/challenge` nonce with a detached Ed25519 proof.
 *
 * The domain separator is what keeps an auth proof from being replayable as
 * a signed prekey (or vice versa): every signature this identity produces is
 * bound to the purpose it was made for. Must match the Go verification in
 * `crypto.VerifyAuthProof`.
 */
export async function createAuthProof(
  signingPrivateKey: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  return signDetached(signingPrivateKey, authProofMessage(nonce));
}

/**
 * Builds the byte string that binds an X25519 identity key to the Ed25519 one:
 *   "shatters-idk-v1" || x25519_public
 */
export function identityDhMessage(dhPublicKey: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(IDENTITY_DH_DOMAIN);
  const message = new Uint8Array(domain.length + dhPublicKey.length);
  message.set(domain);
  message.set(dhPublicKey, domain.length);
  return message;
}

/** Signs this device's X25519 identity key with its Ed25519 identity key. */
export async function signIdentityDhKey(
  identity: Identity,
): Promise<Uint8Array> {
  return signDetached(
    identity.signing.privateKey,
    identityDhMessage(identity.dh.publicKey),
  );
}

/**
 * Verifies that an X25519 identity key really belongs to the identity that
 * published it.
 *
 * The signed prekey has always been verified; this key was not, so an operator
 * could substitute its own and control the DH2 input to X3DH.
 */
export async function verifyIdentityDhKey(
  identityKey: Uint8Array,
  dhKey: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const s = await sodium();
  return s.crypto_sign_verify_detached(
    signature,
    identityDhMessage(dhKey),
    identityKey,
  );
}

export interface SignedPrekey {
  id: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

/**
 * Builds the byte string a signed prekey signature covers:
 *   "shatters-spk-v1" || x25519_public || id_be32
 *
 * Shared by the signing and verification paths so the two can never drift.
 * Must match the Go construction in `crypto.VerifySignedPrekey`.
 */
export function signedPrekeyMessage(
  publicKey: Uint8Array,
  id: number,
): Uint8Array {
  const domain = new TextEncoder().encode(SIGNED_PREKEY_DOMAIN);
  const idBytes = new Uint8Array(4);
  new DataView(idBytes.buffer).setUint32(0, id, false); // big-endian

  const message = new Uint8Array(
    domain.length + publicKey.length + idBytes.length,
  );
  message.set(domain);
  message.set(publicKey, domain.length);
  message.set(idBytes, domain.length + publicKey.length);
  return message;
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

  const signature = await signDetached(
    signingPrivateKey,
    signedPrekeyMessage(spk.publicKey, id),
  );
  return { id, publicKey: spk.publicKey, signature };
}

/**
 * Verifies a signed prekey against the identity key that published it.
 *
 * This is what makes a fetched bundle trustworthy: the server hands out the
 * prekeys, so without this check an operator could substitute its own and sit
 * in the middle of the handshake.
 */
export async function verifySignedPrekey(
  identityKey: Uint8Array,
  prekey: SignedPrekey,
): Promise<boolean> {
  const s = await sodium();
  return s.crypto_sign_verify_detached(
    prekey.signature,
    signedPrekeyMessage(prekey.publicKey, prekey.id),
    identityKey,
  );
}
