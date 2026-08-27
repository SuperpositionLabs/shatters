/**
 * Randomised decoding of the client wire formats.
 *
 * The inner message is parsed *before* the AEAD tag is checked — by
 * definition, since the ratchet header has to be read to find the key — so it
 * sees bytes an attacker chooses. Content is parsed after decryption, but a
 * compromised peer controls it entirely.
 *
 * Vitest has no native fuzzer, so this is a deterministic pseudo-random sweep:
 * a fixed seed keeps a failure reproducible, which matters more here than
 * exploring new input on every run.
 */
import { describe, expect, it } from "vitest";

import { decodeContent, encodeContent, type MessageContent } from "./content";
import { decodeMessage, encodeNormalMessage } from "./envelope";

/** Deterministic PRNG, so a failure can be reproduced from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function randomBytes(random: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(random() * 256);
  return out;
}

/** Flips a random bit, the mutation most likely to survive a length check. */
function mutate(random: () => number, input: Uint8Array): Uint8Array {
  const out = input.slice();
  if (out.length === 0) return out;
  const index = Math.floor(random() * out.length);
  out[index] ^= 1 << Math.floor(random() * 8);
  return out;
}

/** Truncates to a random length, exercising every partial parse. */
function truncate(random: () => number, input: Uint8Array): Uint8Array {
  return input.slice(0, Math.floor(random() * (input.length + 1)));
}

const ITERATIONS = 2000;

describe("envelope decoding under random input", () => {
  it("never throws anything but an EnvelopeError", () => {
    const random = makeRandom(0xc0ffee);

    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomBytes(random, Math.floor(random() * 200));
      try {
        decodeMessage(input);
      } catch (error) {
        // An error is always acceptable. A TypeError or a RangeError is not:
        // it means the parser read past something it did not check.
        expect(error, `input ${[...input].join(",")}`).toBeInstanceOf(Error);
        expect((error as Error).name, `input ${[...input].join(",")}`).toBe(
          "Error",
        );
      }
    }
  });

  it("survives mutation and truncation of valid messages", () => {
    const random = makeRandom(0xbadbeef);
    const valid = encodeNormalMessage({
      header: {
        dhPublicKey: randomBytes(random, 32),
        previousChainLength: 3,
        messageNumber: 7,
      },
      ciphertext: randomBytes(random, 64),
    });

    for (let i = 0; i < ITERATIONS; i++) {
      const input =
        random() < 0.5 ? mutate(random, valid) : truncate(random, valid);
      try {
        const decoded = decodeMessage(input);
        // Anything accepted must be structurally whole.
        expect(decoded.ratchet.header.dhPublicKey).toHaveLength(32);
        expect(decoded.ratchet.ciphertext.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  it("does not allocate on an attacker-supplied length", () => {
    // The format carries no length prefix, deliberately: the ciphertext is
    // simply the remainder. A parser that trusted a declared length could be
    // asked to allocate gigabytes from a few bytes of input.
    const random = makeRandom(1);
    const header = encodeNormalMessage({
      header: {
        dhPublicKey: randomBytes(random, 32),
        previousChainLength: 0xffffffff,
        messageNumber: 0xffffffff,
      },
      ciphertext: new Uint8Array([1]),
    });

    const decoded = decodeMessage(header);
    expect(decoded.ratchet.header.previousChainLength).toBe(0xffffffff);
    expect(decoded.ratchet.ciphertext).toHaveLength(1);
  });
});

describe("content decoding under random input", () => {
  it("never throws anything but a ContentError", () => {
    const random = makeRandom(0x5eed);

    for (let i = 0; i < ITERATIONS; i++) {
      const input = randomBytes(random, Math.floor(random() * 120));
      try {
        decodeContent(input);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("Error");
      }
    }
  });

  it("survives mutation of every content type", () => {
    const random = makeRandom(0xfeed);

    const samples: MessageContent[] = [
      { type: "text", id: "m", body: "hello", timestamp: 1 },
      { type: "receipt", kind: "read", messageIds: ["m"], timestamp: 1 },
      { type: "typing", ttlMs: 1000 },
      { type: "delete", targetId: "m", timestamp: 1 },
      { type: "edit", targetId: "m", body: "x", timestamp: 1 },
      { type: "reaction", targetId: "m", emoji: "x", active: true, timestamp: 1 },
      {
        type: "group-text",
        groupId: "g",
        id: "m",
        body: "hi",
        timestamp: 1,
      },
    ];

    for (const sample of samples) {
      const encoded = encodeContent(sample);
      for (let i = 0; i < 300; i++) {
        const input =
          random() < 0.5 ? mutate(random, encoded) : truncate(random, encoded);
        try {
          decodeContent(input);
        } catch (error) {
          expect(error, `mutating ${sample.type}`).toBeInstanceOf(Error);
        }
      }
    }
  });

  it("round-trips whatever it accepts", () => {
    const random = makeRandom(0xd00d);
    const encoded = encodeContent({
      type: "text",
      id: "m1",
      body: "hello",
      timestamp: 1,
    });

    for (let i = 0; i < 500; i++) {
      const input = mutate(random, encoded);
      let decoded: MessageContent;
      try {
        decoded = decodeContent(input);
      } catch {
        continue;
      }
      if (decoded.type === "unsupported") continue;

      // Anything that decodes must re-encode and decode to the same value, or
      // two spellings of one message exist and peers can disagree about it.
      expect(decodeContent(encodeContent(decoded))).toEqual(decoded);
    }
  });
});
