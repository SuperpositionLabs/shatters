/**
 * Inner message wire format (docs/protocol.md §9).
 *
 * The server relays an opaque outer envelope; these are the bytes inside it.
 * The X3DH and ratchet headers travel in the clear *within* that blob because
 * the responder needs them before it holds any session state - the server
 * still learns nothing, since it only ever sees the outer envelope.
 *
 * ```
 * version : u8 = 1
 * type    : u8 = 1 (initial) | 2 (normal)
 * if type == 1:
 *   identity_key      : 32
 *   identity_dh_key   : 32
 *   ephemeral_key     : 32
 *   signed_prekey_id  : u32be
 *   has_otk           : u8
 *   one_time_prekey_id: u32be   (only when has_otk)
 * dh_pub  : 32
 * pn      : u32be
 * n       : u32be
 * ciphertext : remainder
 * ```
 */
import type { MessageHeader, RatchetMessage } from "./ratchet";
import type { InitialMessageHeader } from "./x3dh";

export const ENVELOPE_VERSION = 1;

export const MessageType = {
  /** Carries the X3DH header; sent until the peer has replied. */
  Initial: 1,
  /** Ratchet header only; the session is established. */
  Normal: 2,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

const KEY_LENGTH = 32;

export class EnvelopeError extends Error {}

/** A decoded inner message. `x3dh` is present exactly for initial messages. */
export interface InnerMessage {
  type: MessageType;
  /** Present when `type === MessageType.Initial`. */
  x3dh?: InitialMessageHeader;
  ratchet: RatchetMessage;
}

/** Sequential writer - keeps the offset arithmetic in one place. */
class Writer {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): this {
    this.parts.push(new Uint8Array([value]));
    return this;
  }

  u32(value: number): this {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value, false);
    this.parts.push(buf);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }

  finish(): Uint8Array {
    const total = this.parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** Sequential reader that refuses to read past the end of the buffer. */
class Reader {
  private offset = 0;

  constructor(private readonly buf: Uint8Array) {}

  private require(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new EnvelopeError("truncated message");
    }
  }

  u8(): number {
    this.require(1);
    return this.buf[this.offset++];
  }

  u32(): number {
    this.require(4);
    const view = new DataView(this.buf.buffer, this.buf.byteOffset);
    const value = view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  bytes(n: number): Uint8Array {
    this.require(n);
    // Copied, so the decoded message does not alias the input buffer.
    const value = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }

  rest(): Uint8Array {
    const value = this.buf.slice(this.offset);
    this.offset = this.buf.length;
    return value;
  }
}

function assertKey(name: string, key: Uint8Array): void {
  if (key.length !== KEY_LENGTH) {
    throw new EnvelopeError(`${name}: expected ${KEY_LENGTH} bytes`);
  }
}

function writeRatchetHeader(w: Writer, header: MessageHeader): void {
  assertKey("ratchet header dhPublicKey", header.dhPublicKey);
  w.bytes(header.dhPublicKey)
    .u32(header.previousChainLength)
    .u32(header.messageNumber);
}

/** Encodes the first message of a session, carrying the X3DH header. */
export function encodeInitialMessage(
  x3dh: InitialMessageHeader,
  ratchet: RatchetMessage,
): Uint8Array {
  assertKey("identityKey", x3dh.identityKey);
  assertKey("identityDhKey", x3dh.identityDhKey);
  assertKey("ephemeralKey", x3dh.ephemeralKey);

  const w = new Writer()
    .u8(ENVELOPE_VERSION)
    .u8(MessageType.Initial)
    .bytes(x3dh.identityKey)
    .bytes(x3dh.identityDhKey)
    .bytes(x3dh.ephemeralKey)
    .u32(x3dh.signedPrekeyId)
    .u8(x3dh.oneTimePrekeyId === undefined ? 0 : 1);

  if (x3dh.oneTimePrekeyId !== undefined) w.u32(x3dh.oneTimePrekeyId);

  writeRatchetHeader(w, ratchet.header);
  return w.bytes(ratchet.ciphertext).finish();
}

/** Encodes a message on an established session. */
export function encodeNormalMessage(ratchet: RatchetMessage): Uint8Array {
  const w = new Writer().u8(ENVELOPE_VERSION).u8(MessageType.Normal);
  writeRatchetHeader(w, ratchet.header);
  return w.bytes(ratchet.ciphertext).finish();
}

/**
 * Decodes an inner message.
 *
 * Every field is bounds-checked and the type byte is validated, so malformed
 * input becomes an error rather than a silently different message. Note this
 * parses *unauthenticated* bytes: the AEAD tag is only checked later, when the
 * ratchet decrypts, so nothing here may be trusted beyond its shape.
 */
export function decodeMessage(raw: Uint8Array): InnerMessage {
  const r = new Reader(raw);

  const version = r.u8();
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(`unsupported envelope version ${version}`);
  }

  const type = r.u8();
  if (type !== MessageType.Initial && type !== MessageType.Normal) {
    throw new EnvelopeError(`unknown message type ${type}`);
  }

  let x3dh: InitialMessageHeader | undefined;
  if (type === MessageType.Initial) {
    const identityKey = r.bytes(KEY_LENGTH);
    const identityDhKey = r.bytes(KEY_LENGTH);
    const ephemeralKey = r.bytes(KEY_LENGTH);
    const signedPrekeyId = r.u32();

    const hasOneTimePrekey = r.u8();
    if (hasOneTimePrekey > 1) {
      throw new EnvelopeError("malformed one-time prekey flag");
    }

    x3dh = {
      identityKey,
      identityDhKey,
      ephemeralKey,
      signedPrekeyId,
      oneTimePrekeyId: hasOneTimePrekey === 1 ? r.u32() : undefined,
    };
  }

  const dhPublicKey = r.bytes(KEY_LENGTH);
  const previousChainLength = r.u32();
  const messageNumber = r.u32();
  const ciphertext = r.rest();

  if (ciphertext.length === 0) {
    throw new EnvelopeError("missing ciphertext");
  }

  return {
    type,
    x3dh,
    ratchet: {
      header: { dhPublicKey, previousChainLength, messageNumber },
      ciphertext,
    },
  };
}
