import { describe, expect, it } from "vitest";

import {
  ENVELOPE_VERSION,
  EnvelopeError,
  MessageType,
  decodeMessage,
  encodeInitialMessage,
  encodeNormalMessage,
} from "./envelope";
import type { RatchetMessage } from "./ratchet";
import type { InitialMessageHeader } from "./x3dh";

function filled(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

const x3dhHeader: InitialMessageHeader = {
  identityKey: filled(1),
  identityDhKey: filled(2),
  ephemeralKey: filled(3),
  signedPrekeyId: 9,
  oneTimePrekeyId: 258,
};

const ratchet: RatchetMessage = {
  header: {
    dhPublicKey: filled(4),
    previousChainLength: 5,
    messageNumber: 65_537,
  },
  ciphertext: new Uint8Array([9, 8, 7, 6, 5]),
};

describe("envelope encoding", () => {
  it("round-trips an initial message with a one-time prekey", () => {
    const decoded = decodeMessage(encodeInitialMessage(x3dhHeader, ratchet));

    expect(decoded.type).toBe(MessageType.Initial);
    expect(decoded.x3dh).toEqual(x3dhHeader);
    expect(decoded.ratchet.header).toEqual(ratchet.header);
    expect(decoded.ratchet.ciphertext).toEqual(ratchet.ciphertext);
  });

  it("round-trips an initial message without a one-time prekey", () => {
    const withoutOtk = { ...x3dhHeader, oneTimePrekeyId: undefined };
    const decoded = decodeMessage(encodeInitialMessage(withoutOtk, ratchet));

    expect(decoded.x3dh?.oneTimePrekeyId).toBeUndefined();
    expect(decoded.x3dh?.signedPrekeyId).toBe(9);
    // The absent id must not shift the ratchet header.
    expect(decoded.ratchet.header).toEqual(ratchet.header);
  });

  it("round-trips a normal message", () => {
    const decoded = decodeMessage(encodeNormalMessage(ratchet));

    expect(decoded.type).toBe(MessageType.Normal);
    expect(decoded.x3dh).toBeUndefined();
    expect(decoded.ratchet.header).toEqual(ratchet.header);
    expect(decoded.ratchet.ciphertext).toEqual(ratchet.ciphertext);
  });

  it("writes the documented layout", () => {
    const bytes = encodeNormalMessage(ratchet);

    expect(bytes[0]).toBe(ENVELOPE_VERSION);
    expect(bytes[1]).toBe(MessageType.Normal);
    expect(bytes.slice(2, 34)).toEqual(filled(4));
    // pn and n big-endian, matching every other length field in the protocol.
    expect(Array.from(bytes.slice(34, 38))).toEqual([0, 0, 0, 5]);
    expect(Array.from(bytes.slice(38, 42))).toEqual([0, 1, 0, 1]);
    expect(bytes).toHaveLength(42 + ratchet.ciphertext.length);
  });

  it("does not alias the input buffer", () => {
    const raw = encodeNormalMessage(ratchet);
    const decoded = decodeMessage(raw);

    raw.fill(0);
    // A decoded message that aliased `raw` would now be zeroed.
    expect(decoded.ratchet.ciphertext).toEqual(ratchet.ciphertext);
    expect(decoded.ratchet.header.dhPublicKey).toEqual(filled(4));
  });

  it("rejects an unknown version", () => {
    const raw = encodeNormalMessage(ratchet);
    raw[0] = 2;

    expect(() => decodeMessage(raw)).toThrow(/unsupported envelope version/);
  });

  it("rejects an unknown message type", () => {
    const raw = encodeNormalMessage(ratchet);
    raw[1] = 7;

    expect(() => decodeMessage(raw)).toThrow(/unknown message type/);
  });

  it("rejects a malformed one-time prekey flag", () => {
    const raw = encodeInitialMessage(x3dhHeader, ratchet);
    raw[2 + 96 + 4] = 5; // the has_otk byte

    expect(() => decodeMessage(raw)).toThrow(/one-time prekey flag/);
  });

  it("rejects input truncated anywhere in the fixed header", () => {
    const raw = encodeInitialMessage(x3dhHeader, ratchet);
    // version+type, three keys, spk id, otk flag, otk id, then the ratchet
    // header - everything before the ciphertext.
    const fixedHeaderLength = 2 + 32 * 3 + 4 + 1 + 4 + 32 + 4 + 4;

    for (let length = 0; length <= fixedHeaderLength; length++) {
      expect(() => decodeMessage(raw.slice(0, length))).toThrow(EnvelopeError);
    }

    // One byte more is a structurally valid message.
    expect(() =>
      decodeMessage(raw.slice(0, fixedHeaderLength + 1)),
    ).not.toThrow();
  });

  it("leaves a truncated ciphertext to the AEAD", () => {
    const raw = encodeInitialMessage(x3dhHeader, ratchet);

    // The decoder cannot know how long the ciphertext was meant to be, so a
    // clipped one parses and is rejected later by the tag. Asserting a parse
    // error here would be asserting something the format cannot detect.
    const decoded = decodeMessage(raw.slice(0, raw.length - 2));
    expect(decoded.ratchet.ciphertext).toHaveLength(
      ratchet.ciphertext.length - 2,
    );
  });

  it("rejects a message with no ciphertext", () => {
    const raw = encodeNormalMessage(ratchet);

    expect(() => decodeMessage(raw.slice(0, 42))).toThrow(/missing ciphertext/);
  });

  it("rejects an oversized ratchet key", () => {
    expect(() =>
      encodeNormalMessage({
        header: { ...ratchet.header, dhPublicKey: new Uint8Array(31) },
        ciphertext: ratchet.ciphertext,
      }),
    ).toThrow(EnvelopeError);
  });

  it("treats trailing bytes as ciphertext rather than ignoring them", () => {
    const raw = encodeNormalMessage(ratchet);
    const padded = new Uint8Array(raw.length + 3);
    padded.set(raw);

    // Extra bytes must land in the ciphertext, where the AEAD tag will reject
    // them, rather than being silently dropped.
    const decoded = decodeMessage(padded);
    expect(decoded.ratchet.ciphertext).toHaveLength(
      ratchet.ciphertext.length + 3,
    );
  });
});
