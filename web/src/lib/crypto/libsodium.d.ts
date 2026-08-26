/**
 * Type augmentation for `libsodium-wrappers-sumo`.
 *
 * `@types/libsodium-wrappers-sumo@0.7.8` declares only ~135 of the sumo
 * build's exports: `crypto_scalarmult`, `memzero` and the whole
 * XChaCha20-Poly1305 AEAD family are missing, although all are present at
 * runtime. Declaring them here keeps the crypto code fully typed instead of
 * casting through `any` at every call site.
 */
import "libsodium-wrappers-sumo";

declare module "libsodium-wrappers-sumo" {
  /** X25519 scalar multiplication: DH(privateKey, publicKey) -> 32 bytes. */
  export function crypto_scalarmult(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
  ): Uint8Array;

  /** Overwrites the buffer with zeroes in place. */
  export function memzero(bytes: Uint8Array): void;

  export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;

  /**
   * XChaCha20-Poly1305 (IETF) AEAD. `secretNonce` is unused by this
   * construction and must be `null`. Throws when authentication fails.
   */
  export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;

  export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
}
