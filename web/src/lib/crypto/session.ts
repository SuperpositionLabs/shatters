/**
 * Session facade: X3DH (`./x3dh`) plus the Double Ratchet (`./ratchet`) behind
 * a four-call surface, producing and consuming the wire bytes defined in
 * `./envelope`.
 *
 * This is the layer a UI or transport talks to. Everything below it is
 * cryptographic detail; everything above it deals only in plaintext and opaque
 * blobs.
 */
import type { Identity, KeyPair } from "./identity";
import {
  EnvelopeError,
  type InnerMessage,
  MessageType,
  decodeMessage,
  encodeInitialMessage,
  encodeNormalMessage,
} from "./envelope";
import {
  type SessionState,
  decryptMessage,
  encryptMessage,
  initializeInitiator,
  initializeResponder,
} from "./ratchet";
import {
  type InitialMessageHeader,
  type PrekeyBundle,
  initiateX3DH,
  respondX3DH,
} from "./x3dh";

export class SessionError extends Error {}

/**
 * A live session. `pendingX3DH` is set on the initiator until the peer has
 * answered; while it is set, every outgoing message repeats the X3DH header.
 */
export interface Session {
  state: SessionState;
  pendingX3DH?: InitialMessageHeader;
}

/**
 * The responder's local prekey store.
 *
 * `takeOneTimePrekey` must *remove* the key it returns: a one-time prekey used
 * twice would let two sessions derive the same X3DH secret, which is the whole
 * thing the one-time prekey exists to prevent.
 */
export interface PrekeyStore {
  signedPrekey(id: number): Promise<KeyPair | undefined>;
  takeOneTimePrekey(id: number): Promise<KeyPair | undefined>;
}

/**
 * Initiator: runs X3DH against a fetched bundle and opens a ratchet session.
 *
 * The bundle's signed prekey is verified inside `initiateX3DH`; a bundle that
 * fails verification throws before any session exists.
 */
export async function startSession(
  ourIdentity: Identity,
  bundle: PrekeyBundle,
): Promise<Session> {
  const agreement = await initiateX3DH(ourIdentity, bundle);

  return {
    state: await initializeInitiator(
      agreement.sharedSecret,
      agreement.associatedData,
      bundle.signedPrekey.publicKey,
    ),
    pendingX3DH: agreement.header,
  };
}

/**
 * Responder: accepts an initial message, establishes the session, and returns
 * the first plaintext.
 *
 * The session is only returned once the message authenticates, so a forged
 * initial message cannot leave a half-built session behind.
 */
export async function acceptSession(
  ourIdentity: Identity,
  prekeys: PrekeyStore,
  raw: Uint8Array,
): Promise<{ session: Session; plaintext: Uint8Array }> {
  const message = decodeMessage(raw);
  if (message.type !== MessageType.Initial || !message.x3dh) {
    throw new SessionError("not an initial message");
  }

  const signedPrekey = await prekeys.signedPrekey(message.x3dh.signedPrekeyId);
  if (!signedPrekey) {
    throw new SessionError(
      `unknown signed prekey ${message.x3dh.signedPrekeyId}`,
    );
  }

  const oneTimePrekey =
    message.x3dh.oneTimePrekeyId === undefined
      ? undefined
      : await prekeys.takeOneTimePrekey(message.x3dh.oneTimePrekeyId);
  if (message.x3dh.oneTimePrekeyId !== undefined && !oneTimePrekey) {
    // Most likely a replay of an initial message whose one-time prekey was
    // already consumed. Refusing is correct: reusing it would rebuild a
    // session an attacker has a recording of.
    throw new SessionError(
      `one-time prekey ${message.x3dh.oneTimePrekeyId} is not available`,
    );
  }

  const agreement = await respondX3DH(
    ourIdentity,
    {
      signedPrekeyPrivate: signedPrekey.privateKey,
      oneTimePrekeyPrivate: oneTimePrekey?.privateKey,
    },
    message.x3dh,
  );

  const state = await initializeResponder(
    agreement.sharedSecret,
    agreement.associatedData,
    signedPrekey,
  );

  // Throws if the message does not authenticate, so no session escapes.
  const plaintext = await decryptMessage(state, message.ratchet);
  return { session: { state }, plaintext };
}

/** Encrypts a plaintext and returns the bytes to put in an envelope. */
export async function encrypt(
  session: Session,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ratchet = await encryptMessage(session.state, plaintext);

  // Until the peer answers we cannot know it received the handshake, so the
  // X3DH header rides along on every message.
  return session.pendingX3DH
    ? encodeInitialMessage(session.pendingX3DH, ratchet)
    : encodeNormalMessage(ratchet);
}

/**
 * Decrypts inbound bytes on an established session.
 *
 * A successfully decrypted message proves the peer holds the session, so the
 * initiator can stop repeating its X3DH header from here on.
 */
export async function decrypt(
  session: Session,
  raw: Uint8Array,
): Promise<Uint8Array> {
  const message: InnerMessage = decodeMessage(raw);
  const plaintext = await decryptMessage(session.state, message.ratchet);
  session.pendingX3DH = undefined;
  return plaintext;
}

export { EnvelopeError };
