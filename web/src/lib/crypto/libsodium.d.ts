/**
 * Type augmentation for `libsodium-wrappers-sumo`.
 *
 * `@types/libsodium-wrappers-sumo@0.7.8` ships no declarations for
 * `crypto_scalarmult` or `memzero`, although both are present in the sumo
 * build at runtime. Declaring them here keeps the X25519 code fully typed
 * instead of casting through `any` at every call site.
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
}
