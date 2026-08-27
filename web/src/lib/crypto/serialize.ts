/**
 * Session state serialisation.
 *
 * `SessionState` holds raw key material and a `Map` of skipped message keys,
 * none of which survive `JSON.stringify`. This codec makes the round trip
 * explicit so nothing is dropped silently.
 *
 * The output is secret - it contains live chain keys and every cached message
 * key - and must only ever be written through the encrypted vault.
 */
import type { KeyPair } from "./identity";
import type { SessionState } from "./ratchet";
import type { Session } from "./session";
import type { InitialMessageHeader } from "./x3dh";

/** Bumped if the shape changes, so an old record is refused rather than misread. */
export const SESSION_FORMAT_VERSION = 1;

export class SerializationError extends Error {}

interface SerializedKeyPair {
  publicKey: string;
  privateKey: string;
  keyType: string;
}

interface SerializedSession {
  version: number;
  rootKey: string;
  ourRatchetKey: SerializedKeyPair;
  theirRatchetKey?: string;
  sendingChainKey?: string;
  receivingChainKey?: string;
  sendCount: number;
  receiveCount: number;
  previousChainLength: number;
  /** Tuples rather than an object: a Map does not survive JSON. */
  skippedKeys: [string, string][];
  associatedData: string;
  pendingX3DH?: {
    identityKey: string;
    identityDhKey: string;
    ephemeralKey: string;
    signedPrekeyId: number;
    oneTimePrekeyId?: number;
  };
}

function encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decode(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeKeyPair(pair: KeyPair): SerializedKeyPair {
  return {
    publicKey: encode(pair.publicKey),
    privateKey: encode(pair.privateKey),
    keyType: pair.keyType,
  };
}

function decodeKeyPair(pair: SerializedKeyPair): KeyPair {
  return {
    publicKey: decode(pair.publicKey),
    privateKey: decode(pair.privateKey),
    keyType: pair.keyType,
  };
}

/** Converts a live session into a JSON-safe object. */
export function serializeSession(session: Session): SerializedSession {
  const s = session.state;

  return {
    version: SESSION_FORMAT_VERSION,
    rootKey: encode(s.rootKey),
    ourRatchetKey: encodeKeyPair(s.ourRatchetKey),
    theirRatchetKey: s.theirRatchetKey && encode(s.theirRatchetKey),
    sendingChainKey: s.sendingChainKey && encode(s.sendingChainKey),
    receivingChainKey: s.receivingChainKey && encode(s.receivingChainKey),
    sendCount: s.sendCount,
    receiveCount: s.receiveCount,
    previousChainLength: s.previousChainLength,
    // Preserved exactly: losing the window would silently break out-of-order
    // delivery after a reload, a failure that only appears on bad networks.
    skippedKeys: [...s.skippedKeys.entries()].map(([id, key]) => [
      id,
      encode(key),
    ]),
    associatedData: encode(s.associatedData),
    pendingX3DH: session.pendingX3DH && {
      identityKey: encode(session.pendingX3DH.identityKey),
      identityDhKey: encode(session.pendingX3DH.identityDhKey),
      ephemeralKey: encode(session.pendingX3DH.ephemeralKey),
      signedPrekeyId: session.pendingX3DH.signedPrekeyId,
      oneTimePrekeyId: session.pendingX3DH.oneTimePrekeyId,
    },
  };
}

/** Rebuilds a live session from serialised form. */
export function deserializeSession(raw: unknown): Session {
  const data = raw as SerializedSession;

  if (!data || typeof data !== "object") {
    throw new SerializationError("session record is not an object");
  }
  if (data.version !== SESSION_FORMAT_VERSION) {
    // Guessing at an unknown layout risks reviving a session with a corrupt
    // ratchet, which would fail later and far from the cause.
    throw new SerializationError(
      `unsupported session format ${String(data.version)}`,
    );
  }

  const state: SessionState = {
    rootKey: decode(data.rootKey),
    ourRatchetKey: decodeKeyPair(data.ourRatchetKey),
    theirRatchetKey: data.theirRatchetKey
      ? decode(data.theirRatchetKey)
      : undefined,
    sendingChainKey: data.sendingChainKey
      ? decode(data.sendingChainKey)
      : undefined,
    receivingChainKey: data.receivingChainKey
      ? decode(data.receivingChainKey)
      : undefined,
    sendCount: data.sendCount,
    receiveCount: data.receiveCount,
    previousChainLength: data.previousChainLength,
    skippedKeys: new Map(
      (data.skippedKeys ?? []).map(([id, key]) => [id, decode(key)]),
    ),
    associatedData: decode(data.associatedData),
  };

  let pendingX3DH: InitialMessageHeader | undefined;
  if (data.pendingX3DH) {
    pendingX3DH = {
      identityKey: decode(data.pendingX3DH.identityKey),
      identityDhKey: decode(data.pendingX3DH.identityDhKey),
      ephemeralKey: decode(data.pendingX3DH.ephemeralKey),
      signedPrekeyId: data.pendingX3DH.signedPrekeyId,
      oneTimePrekeyId: data.pendingX3DH.oneTimePrekeyId,
    };
  }

  return { state, pendingX3DH };
}
