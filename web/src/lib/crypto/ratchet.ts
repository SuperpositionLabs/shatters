/**
 * Double Ratchet (docs/protocol.md §8).
 *
 * Follows the Signal Double Ratchet specification: a root chain driven by DH
 * ratchet steps, two symmetric chains for sending and receiving, and a bounded
 * cache of skipped message keys so out-of-order delivery still decrypts.
 *
 * Runs entirely on the user's device. The server only ever sees the opaque
 * ciphertext and the header bytes the client chooses to put in the envelope.
 *
 * Consumes the 32-byte shared secret produced by X3DH (`./x3dh`) as the
 * initial root key.
 */
import { type KeyPair, sodium } from "./identity";
import { HASH_LENGTH, hkdfSha256 } from "./kdf";

/** Domain separators. Must not collide with any other signed or derived value. */
export const ROOT_DOMAIN = "shatters-ratchet-root-v1";
export const MESSAGE_DOMAIN = "shatters-msg-v1";

const KEY_LENGTH = 32;
const NONCE_LENGTH = 24;

/**
 * Bounded skipped-key window (protocol §8). Without a bound, a peer could
 * claim an enormous message number and force unbounded key derivation and
 * storage - a trivial denial of service.
 */
export const MAX_SKIPPED_KEYS = 2000;
export const MAX_SKIP_CHAINS = 64;

/** Serialized size of a header: dh_pub(32) || pn(4) || n(4). */
const HEADER_LENGTH = KEY_LENGTH + 8;

export class RatchetError extends Error {}

/** The plaintext header that travels with every message. */
export interface MessageHeader {
  /** Sender's current ratchet public key. */
  dhPublicKey: Uint8Array;
  /** Number of messages in the sender's previous sending chain. */
  previousChainLength: number;
  /** Message number within the current sending chain. */
  messageNumber: number;
}

export interface RatchetMessage {
  header: MessageHeader;
  ciphertext: Uint8Array;
}

/**
 * Live session state. Mutable and secret: it holds chain keys and cached
 * message keys, so it must never leave the device unencrypted.
 */
export interface SessionState {
  rootKey: Uint8Array;
  /** Our current ratchet keypair. */
  ourRatchetKey: KeyPair;
  /** Peer's current ratchet public key, once known. */
  theirRatchetKey?: Uint8Array;
  /** Sending chain key; absent until we have a peer ratchet key. */
  sendingChainKey?: Uint8Array;
  /** Receiving chain key; absent until the peer has ratcheted to us. */
  receivingChainKey?: Uint8Array;
  sendCount: number;
  receiveCount: number;
  previousChainLength: number;
  /** Skipped message keys, keyed by `base64(dh_pub):n`, insertion-ordered. */
  skippedKeys: Map<string, Uint8Array>;
  /** `AD` from X3DH, bound into every message. */
  associatedData: Uint8Array;
}

// --- primitives -----------------------------------------------------------

/**
 * Root KDF: advances the root key and starts a new chain.
 * `(RK', CK) = HKDF-SHA256(salt=RK, ikm=DH_out)`.
 */
async function advanceRootKey(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
): Promise<{ rootKey: Uint8Array; chainKey: Uint8Array }> {
  const derived = await hkdfSha256(
    dhOutput,
    rootKey, // the current root key is the HKDF salt
    ROOT_DOMAIN,
    KEY_LENGTH * 2,
  );
  const s = await sodium();
  const next = {
    rootKey: derived.slice(0, KEY_LENGTH),
    chainKey: derived.slice(KEY_LENGTH),
  };
  s.memzero(derived);
  return next;
}

/**
 * Symmetric chain KDF: `mk = HMAC(CK, 0x01)`, `CK' = HMAC(CK, 0x02)`.
 *
 * The distinct constants are what keep the message key and the next chain key
 * independent. Were they equal, a single compromised message key would hand an
 * attacker the whole remaining chain and forward secrecy would be gone - a
 * flaw invisible in any round-trip test, since both peers would still agree.
 * Exported so `ratchet.test.ts` can assert the separation directly.
 */
export async function advanceChainKey(
  chainKey: Uint8Array,
): Promise<{ chainKey: Uint8Array; messageKey: Uint8Array }> {
  const s = await sodium();
  return {
    messageKey: s.crypto_auth_hmacsha256(new Uint8Array([0x01]), chainKey),
    chainKey: s.crypto_auth_hmacsha256(new Uint8Array([0x02]), chainKey),
  };
}

/**
 * Derives the AEAD key and nonce from a message key.
 *
 * Deriving the nonce rather than transmitting it means it costs no bytes on
 * the wire and cannot be manipulated by an attacker. Reuse is impossible
 * because each message key is produced once by the chain and destroyed on use.
 */
async function messageKeyMaterial(
  messageKey: Uint8Array,
): Promise<{ key: Uint8Array; nonce: Uint8Array }> {
  const material = await hkdfSha256(
    messageKey,
    new Uint8Array(HASH_LENGTH),
    MESSAGE_DOMAIN,
    KEY_LENGTH + NONCE_LENGTH,
  );
  const s = await sodium();
  const out = {
    key: material.slice(0, KEY_LENGTH),
    nonce: material.slice(KEY_LENGTH),
  };
  s.memzero(material);
  return out;
}

/** `dh_pub || pn_be32 || n_be32` - the bytes bound into the AEAD. */
export function serializeHeader(header: MessageHeader): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH);
  out.set(header.dhPublicKey);
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(KEY_LENGTH, header.previousChainLength, false);
  view.setUint32(KEY_LENGTH + 4, header.messageNumber, false);
  return out;
}

/**
 * Associated data for one message: the X3DH `AD` followed by the header.
 *
 * Binding the header is what stops an attacker replaying a valid ciphertext
 * under a different message number or ratchet key: the AEAD tag covers both,
 * so any edit turns into an authentication failure instead of a plaintext.
 */
function messageAssociatedData(
  state: SessionState,
  header: MessageHeader,
): Uint8Array {
  const headerBytes = serializeHeader(header);
  const ad = new Uint8Array(state.associatedData.length + headerBytes.length);
  ad.set(state.associatedData);
  ad.set(headerBytes, state.associatedData.length);
  return ad;
}

function skippedKeyId(dhPublicKey: Uint8Array, messageNumber: number): string {
  let bin = "";
  for (const b of dhPublicKey) bin += String.fromCharCode(b);
  return `${btoa(bin)}:${messageNumber}`;
}

// --- initialisation -------------------------------------------------------

/**
 * Initiator side (the party that ran `initiateX3DH`).
 *
 * The peer's signed prekey doubles as its first ratchet public key, so the
 * initiator can ratchet immediately and its first message already carries a
 * fresh ratchet key.
 */
export async function initializeInitiator(
  sharedSecret: Uint8Array,
  associatedData: Uint8Array,
  theirSignedPrekey: Uint8Array,
): Promise<SessionState> {
  const s = await sodium();

  if (sharedSecret.length !== KEY_LENGTH) {
    throw new RatchetError(`sharedSecret must be ${KEY_LENGTH} bytes`);
  }
  if (theirSignedPrekey.length !== KEY_LENGTH) {
    throw new RatchetError(`theirSignedPrekey must be ${KEY_LENGTH} bytes`);
  }

  const ourRatchetKey = s.crypto_kx_keypair();
  const dhOutput = s.crypto_scalarmult(
    ourRatchetKey.privateKey,
    theirSignedPrekey,
  );
  const { rootKey, chainKey } = await advanceRootKey(sharedSecret, dhOutput);
  s.memzero(dhOutput);

  return {
    rootKey,
    ourRatchetKey,
    theirRatchetKey: theirSignedPrekey,
    sendingChainKey: chainKey,
    sendCount: 0,
    receiveCount: 0,
    previousChainLength: 0,
    skippedKeys: new Map(),
    associatedData,
  };
}

/**
 * Responder side (the party that ran `respondX3DH`).
 *
 * Its signed prekey pair *is* its first ratchet keypair. It has no sending
 * chain until the initiator's first message arrives and triggers a DH ratchet.
 */
export async function initializeResponder(
  sharedSecret: Uint8Array,
  associatedData: Uint8Array,
  ourSignedPrekey: KeyPair,
): Promise<SessionState> {
  if (sharedSecret.length !== KEY_LENGTH) {
    throw new RatchetError(`sharedSecret must be ${KEY_LENGTH} bytes`);
  }

  return {
    rootKey: sharedSecret.slice(),
    // Copied, not referenced: one signed prekey serves many sessions, and the
    // first DH ratchet destroys this session's copy of the private half.
    ourRatchetKey: {
      publicKey: ourSignedPrekey.publicKey.slice(),
      privateKey: ourSignedPrekey.privateKey.slice(),
      keyType: ourSignedPrekey.keyType,
    },
    sendCount: 0,
    receiveCount: 0,
    previousChainLength: 0,
    skippedKeys: new Map(),
    associatedData,
  };
}

// --- sending --------------------------------------------------------------

/** Encrypts one message and advances the sending chain. */
export async function encryptMessage(
  state: SessionState,
  plaintext: Uint8Array,
): Promise<RatchetMessage> {
  const s = await sodium();

  if (!state.sendingChainKey) {
    // The responder cannot speak first: it has no peer ratchet key yet, so
    // there is nothing to derive a sending chain from.
    throw new RatchetError("no sending chain: awaiting the peer's first message");
  }

  const { chainKey, messageKey } = await advanceChainKey(state.sendingChainKey);
  s.memzero(state.sendingChainKey);
  state.sendingChainKey = chainKey;

  const header: MessageHeader = {
    // Copied so the returned message stays valid across later ratchet steps.
    dhPublicKey: state.ourRatchetKey.publicKey.slice(),
    previousChainLength: state.previousChainLength,
    messageNumber: state.sendCount,
  };
  state.sendCount += 1;

  const { key, nonce } = await messageKeyMaterial(messageKey);
  s.memzero(messageKey);
  try {
    const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      messageAssociatedData(state, header),
      null,
      nonce,
      key,
    );
    return { header, ciphertext };
  } finally {
    s.memzero(key);
    s.memzero(nonce);
  }
}

// --- receiving ------------------------------------------------------------

async function decryptWithMessageKey(
  state: SessionState,
  messageKey: Uint8Array,
  header: MessageHeader,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const s = await sodium();
  const { key, nonce } = await messageKeyMaterial(messageKey);
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      messageAssociatedData(state, header),
      nonce,
      key,
    );
  } catch {
    throw new RatchetError("message authentication failed");
  } finally {
    s.memzero(key);
    s.memzero(nonce);
  }
}

/** Caches message keys for the gap between the current count and `until`. */
async function skipMessageKeys(
  state: SessionState,
  until: number,
): Promise<void> {
  if (!state.receivingChainKey) return;

  if (until - state.receiveCount > MAX_SKIPPED_KEYS) {
    throw new RatchetError("too many skipped messages");
  }

  const s = await sodium();
  while (state.receiveCount < until) {
    const { chainKey, messageKey } = await advanceChainKey(
      state.receivingChainKey,
    );
    s.memzero(state.receivingChainKey);
    state.receivingChainKey = chainKey;

    state.skippedKeys.set(
      skippedKeyId(state.theirRatchetKey as Uint8Array, state.receiveCount),
      messageKey,
    );
    state.receiveCount += 1;
    evictSkippedKeys(state, s);
  }
}

/**
 * Enforces the §8 bounds: at most `MAX_SKIPPED_KEYS` cached keys across at
 * most `MAX_SKIP_CHAINS` distinct ratchet keys. Oldest entries go first, since
 * `Map` preserves insertion order.
 */
function evictSkippedKeys(
  state: SessionState,
  s: Awaited<ReturnType<typeof sodium>>,
): void {
  while (state.skippedKeys.size > MAX_SKIPPED_KEYS) {
    const oldest = state.skippedKeys.keys().next();
    if (oldest.done) break;
    const key = state.skippedKeys.get(oldest.value);
    if (key) s.memzero(key);
    state.skippedKeys.delete(oldest.value);
  }

  const chains = new Set<string>();
  for (const id of state.skippedKeys.keys()) {
    chains.add(id.slice(0, id.lastIndexOf(":")));
  }
  if (chains.size <= MAX_SKIP_CHAINS) return;

  // Drop whole chains, oldest first, until we are back within the bound.
  const excess = chains.size - MAX_SKIP_CHAINS;
  const doomed = [...chains].slice(0, excess);
  for (const id of [...state.skippedKeys.keys()]) {
    if (doomed.some((chain) => id.startsWith(`${chain}:`))) {
      const key = state.skippedKeys.get(id);
      if (key) s.memzero(key);
      state.skippedKeys.delete(id);
    }
  }
}

/** Performs a DH ratchet step towards the peer's new ratchet key. */
async function dhRatchet(
  state: SessionState,
  theirRatchetKey: Uint8Array,
): Promise<void> {
  const s = await sodium();

  state.previousChainLength = state.sendCount;
  state.sendCount = 0;
  state.receiveCount = 0;
  state.theirRatchetKey = theirRatchetKey;

  // Receiving chain from our current key and their new one...
  const receiveDh = s.crypto_scalarmult(
    state.ourRatchetKey.privateKey,
    theirRatchetKey,
  );
  const receiving = await advanceRootKey(state.rootKey, receiveDh);
  s.memzero(receiveDh);
  s.memzero(state.rootKey);
  if (state.receivingChainKey) s.memzero(state.receivingChainKey);
  state.rootKey = receiving.rootKey;
  state.receivingChainKey = receiving.chainKey;

  // ...then a fresh keypair, giving post-compromise security: an attacker who
  // stole the old private key cannot follow the chain past this point.
  s.memzero(state.ourRatchetKey.privateKey);
  state.ourRatchetKey = s.crypto_kx_keypair();

  const sendDh = s.crypto_scalarmult(
    state.ourRatchetKey.privateKey,
    theirRatchetKey,
  );
  const sending = await advanceRootKey(state.rootKey, sendDh);
  s.memzero(sendDh);
  s.memzero(state.rootKey);
  if (state.sendingChainKey) s.memzero(state.sendingChainKey);
  state.rootKey = sending.rootKey;
  state.sendingChainKey = sending.chainKey;
}

/**
 * Decrypts one message, advancing or ratcheting the session as needed.
 *
 * All state changes are staged on a working copy and committed only once the
 * AEAD verifies. A forged or corrupted message therefore costs nothing: the
 * live session is left exactly as it was and the next genuine message still
 * decrypts. Doing this in place would let one bad packet desynchronise a
 * conversation permanently.
 */
export async function decryptMessage(
  state: SessionState,
  message: RatchetMessage,
): Promise<Uint8Array> {
  const s = await sodium();
  const { header, ciphertext } = message;

  if (header.dhPublicKey.length !== KEY_LENGTH) {
    throw new RatchetError("malformed header ratchet key");
  }

  // A message key cached earlier is used directly and never regenerated.
  const cachedId = skippedKeyId(header.dhPublicKey, header.messageNumber);
  const cached = state.skippedKeys.get(cachedId);
  if (cached) {
    const plaintext = await decryptWithMessageKey(
      state,
      cached,
      header,
      ciphertext,
    );
    // Only destroy the key once the message proved genuine, so a forgery
    // cannot burn a key a real message still needs.
    s.memzero(cached);
    state.skippedKeys.delete(cachedId);
    return plaintext;
  }

  const working = cloneState(state);

  const isNewRatchetKey =
    !working.theirRatchetKey ||
    !bytesEqual(working.theirRatchetKey, header.dhPublicKey);

  if (isNewRatchetKey) {
    await skipMessageKeys(working, header.previousChainLength);
    await dhRatchet(working, header.dhPublicKey);
  }
  await skipMessageKeys(working, header.messageNumber);

  if (!working.receivingChainKey) {
    throw new RatchetError("no receiving chain for this message");
  }

  const { chainKey, messageKey } = await advanceChainKey(
    working.receivingChainKey,
  );
  working.receivingChainKey = chainKey;
  working.receiveCount += 1;

  try {
    const plaintext = await decryptWithMessageKey(
      working,
      messageKey,
      header,
      ciphertext,
    );
    commitState(state, working);
    return plaintext;
  } finally {
    s.memzero(messageKey);
  }
}

// --- state plumbing -------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function cloneState(state: SessionState): SessionState {
  const skipped = new Map<string, Uint8Array>();
  for (const [id, key] of state.skippedKeys) skipped.set(id, key.slice());

  return {
    rootKey: state.rootKey.slice(),
    ourRatchetKey: {
      publicKey: state.ourRatchetKey.publicKey.slice(),
      privateKey: state.ourRatchetKey.privateKey.slice(),
      keyType: state.ourRatchetKey.keyType,
    },
    theirRatchetKey: state.theirRatchetKey?.slice(),
    sendingChainKey: state.sendingChainKey?.slice(),
    receivingChainKey: state.receivingChainKey?.slice(),
    sendCount: state.sendCount,
    receiveCount: state.receiveCount,
    previousChainLength: state.previousChainLength,
    skippedKeys: skipped,
    associatedData: state.associatedData,
  };
}

/** Moves a verified working copy into the live session object in place. */
function commitState(target: SessionState, source: SessionState): void {
  target.rootKey = source.rootKey;
  target.ourRatchetKey = source.ourRatchetKey;
  target.theirRatchetKey = source.theirRatchetKey;
  target.sendingChainKey = source.sendingChainKey;
  target.receivingChainKey = source.receivingChainKey;
  target.sendCount = source.sendCount;
  target.receiveCount = source.receiveCount;
  target.previousChainLength = source.previousChainLength;
  target.skippedKeys = source.skippedKeys;
}
