import { beforeEach, describe, expect, it } from "vitest";

import {
  type Identity,
  generateIdentity,
  signDetached,
  signIdentityDhKey,
  signedPrekeyMessage,
  sodium,
} from "./identity";
import {
  MAX_SKIPPED_KEYS,
  type RatchetMessage,
  RatchetError,
  type SessionState,
  advanceChainKey,
  decryptMessage,
  encryptMessage,
  initializeInitiator,
  initializeResponder,
  serializeHeader,
} from "./ratchet";
import { initiateX3DH, respondX3DH } from "./x3dh";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

/**
 * Runs a real X3DH handshake and hands back both ends of the resulting
 * session, so the ratchet is exercised against genuine key agreement output
 * rather than a hand-made secret.
 */
async function establishSession(): Promise<{
  alice: SessionState;
  bob: SessionState;
  aliceIdentity: Identity;
  bobIdentity: Identity;
}> {
  const s = await sodium();
  const aliceIdentity = await generateIdentity();
  const bobIdentity = await generateIdentity();

  const spkPair = s.crypto_kx_keypair();
  const spkId = 1;
  const signature = await signDetached(
    bobIdentity.signing.privateKey,
    signedPrekeyMessage(spkPair.publicKey, spkId),
  );

  const initiator = await initiateX3DH(aliceIdentity, {
    identityKey: bobIdentity.signing.publicKey,
    identityDhKey: bobIdentity.dh.publicKey,
    identityDhSignature: await signIdentityDhKey(bobIdentity),
    signedPrekey: { id: spkId, publicKey: spkPair.publicKey, signature },
  });
  const responder = await respondX3DH(
    bobIdentity,
    { signedPrekeyPrivate: spkPair.privateKey },
    initiator.header,
  );

  return {
    alice: await initializeInitiator(
      initiator.sharedSecret,
      initiator.associatedData,
      spkPair.publicKey,
    ),
    bob: await initializeResponder(
      responder.sharedSecret,
      responder.associatedData,
      spkPair,
    ),
    aliceIdentity,
    bobIdentity,
  };
}

describe("Double Ratchet", () => {
  let alice: SessionState;
  let bob: SessionState;

  beforeEach(async () => {
    ({ alice, bob } = await establishSession());
  });

  it("carries a message from initiator to responder", async () => {
    const message = await encryptMessage(alice, text("hello bob"));
    const plaintext = await decryptMessage(bob, message);

    expect(decoder.decode(plaintext)).toBe("hello bob");
    // The wire form leaks nothing: ciphertext must not contain the plaintext.
    expect(decoder.decode(message.ciphertext)).not.toContain("hello");
  });

  it("refuses to let the responder speak before it has heard anything", async () => {
    // Bob has no peer ratchet key yet, so there is no sending chain.
    await expect(encryptMessage(bob, text("too early"))).rejects.toThrow(
      RatchetError,
    );
  });

  it("survives a long back-and-forth conversation with ratchet steps", async () => {
    const transcript: string[] = [];

    for (let round = 0; round < 5; round++) {
      const fromAlice = await encryptMessage(alice, text(`a${round}`));
      transcript.push(decoder.decode(await decryptMessage(bob, fromAlice)));

      const fromBob = await encryptMessage(bob, text(`b${round}`));
      transcript.push(decoder.decode(await decryptMessage(alice, fromBob)));
    }

    expect(transcript).toEqual([
      "a0", "b0", "a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4",
    ]);
  });

  it("handles several messages in a row without a reply", async () => {
    const messages: RatchetMessage[] = [];
    for (let i = 0; i < 4; i++) {
      messages.push(await encryptMessage(alice, text(`burst ${i}`)));
    }

    for (let i = 0; i < messages.length; i++) {
      expect(decoder.decode(await decryptMessage(bob, messages[i]))).toBe(
        `burst ${i}`,
      );
    }
  });

  it("decrypts out-of-order messages within the skip window", async () => {
    const first = await encryptMessage(alice, text("one"));
    const second = await encryptMessage(alice, text("two"));
    const third = await encryptMessage(alice, text("three"));

    // Arrives last-first; the skipped keys must be cached and reused.
    expect(decoder.decode(await decryptMessage(bob, third))).toBe("three");
    expect(decoder.decode(await decryptMessage(bob, first))).toBe("one");
    expect(decoder.decode(await decryptMessage(bob, second))).toBe("two");
  });

  it("decrypts a message from a previous chain after a ratchet step", async () => {
    const straggler = await encryptMessage(alice, text("sent before reply"));

    // Bob replies without ever seeing the straggler, forcing a ratchet.
    const opener = await encryptMessage(alice, text("opener"));
    await decryptMessage(bob, opener);
    const reply = await encryptMessage(bob, text("reply"));
    await decryptMessage(alice, reply);
    const afterRatchet = await encryptMessage(alice, text("after"));
    await decryptMessage(bob, afterRatchet);

    // The straggler belongs to Alice's first chain; `pn` tells Bob how far to
    // skip back, so it must still decrypt.
    expect(decoder.decode(await decryptMessage(bob, straggler))).toBe(
      "sent before reply",
    );
  });

  it("never decrypts the same message twice", async () => {
    const message = await encryptMessage(alice, text("once"));
    expect(decoder.decode(await decryptMessage(bob, message))).toBe("once");

    // The message key was destroyed on use, so a replay finds nothing.
    await expect(decryptMessage(bob, message)).rejects.toThrow(RatchetError);
  });

  it("never decrypts a skipped message twice", async () => {
    const skipped = await encryptMessage(alice, text("skipped"));
    const later = await encryptMessage(alice, text("later"));

    // Receiving `later` first caches the key for `skipped`.
    await decryptMessage(bob, later);
    expect(decoder.decode(await decryptMessage(bob, skipped))).toBe("skipped");

    // Using a cached key must evict it, or a replayed message would decrypt
    // for as long as the key stayed in the window.
    await expect(decryptMessage(bob, skipped)).rejects.toThrow(RatchetError);
  });

  it("rejects tampered ciphertext", async () => {
    const message = await encryptMessage(alice, text("intact"));
    message.ciphertext[0] ^= 0x01;

    await expect(decryptMessage(bob, message)).rejects.toThrow(
      /authentication failed/,
    );
  });

  it("rejects a tampered message number", async () => {
    const message = await encryptMessage(alice, text("intact"));
    // The header is bound into the AEAD, so editing it must fail the tag.
    message.header.messageNumber = 5;

    await expect(decryptMessage(bob, message)).rejects.toThrow(RatchetError);
  });

  it("binds every header field into the associated data", async () => {
    const message = await encryptMessage(alice, text("intact"));
    // `previousChainLength` plays no part in choosing the message key while
    // the ratchet key is unchanged, so it is only rejected if the header is
    // genuinely covered by the AEAD tag rather than merely used for lookup.
    message.header.previousChainLength = 7;

    await expect(decryptMessage(bob, message)).rejects.toThrow(
      /authentication failed/,
    );
  });

  it("rejects a substituted ratchet key", async () => {
    const s = await sodium();
    const message = await encryptMessage(alice, text("intact"));
    message.header.dhPublicKey = s.crypto_kx_keypair().publicKey;

    await expect(decryptMessage(bob, message)).rejects.toThrow(RatchetError);
  });

  it("rejects a session whose associated data does not match", async () => {
    const message = await encryptMessage(alice, text("bound"));
    // Simulates a peer that believes it is talking to someone else.
    bob.associatedData = new Uint8Array(bob.associatedData.length).fill(9);

    await expect(decryptMessage(bob, message)).rejects.toThrow(RatchetError);
  });

  it("keeps the session usable after a forged message is rejected", async () => {
    const s = await sodium();
    await decryptMessage(bob, await encryptMessage(alice, text("first")));

    // A forgery bearing an unknown ratchet key is the damaging case: acting on
    // it would advance the root key and rebuild both chains around a key Alice
    // never used, permanently desynchronising the session. Merely corrupting a
    // ciphertext is not enough to prove rollback, because the skipped-key cache
    // would paper over it.
    const forged = await encryptMessage(alice, text("forged"));
    forged.header.dhPublicKey = s.crypto_kx_keypair().publicKey;
    await expect(decryptMessage(bob, forged)).rejects.toThrow(RatchetError);

    // State was rolled back, so Alice's genuine next message still decrypts.
    const next = await encryptMessage(alice, text("still fine"));
    expect(decoder.decode(await decryptMessage(bob, next))).toBe("still fine");

    // And the session keeps working in both directions.
    const reply = await encryptMessage(bob, text("reply"));
    expect(decoder.decode(await decryptMessage(alice, reply))).toBe("reply");
  });

  it("enforces the skipped-key window", async () => {
    const message = await encryptMessage(alice, text("far future"));
    // Claim a message number beyond the bound; deriving that many keys is
    // exactly the denial of service the window exists to prevent.
    message.header.messageNumber = MAX_SKIPPED_KEYS + 1;

    await expect(decryptMessage(bob, message)).rejects.toThrow(
      /too many skipped messages/,
    );
  });

  it("keeps the message key independent of the next chain key", async () => {
    const chainKey = new Uint8Array(32).fill(0x42);
    const first = await advanceChainKey(chainKey);
    const second = await advanceChainKey(first.chainKey);

    // If mk and CK' collided, learning one message key would unroll the rest
    // of the chain. Round-trip tests cannot see this - both peers would still
    // agree - so it is asserted directly.
    expect(Array.from(first.messageKey)).not.toEqual(
      Array.from(first.chainKey),
    );
    expect(Array.from(first.messageKey)).not.toEqual(Array.from(chainKey));
    expect(Array.from(first.chainKey)).not.toEqual(Array.from(chainKey));
    // Successive message keys must differ too.
    expect(Array.from(second.messageKey)).not.toEqual(
      Array.from(first.messageKey),
    );
    // Deterministic: both peers derive the same chain from the same input.
    const repeat = await advanceChainKey(chainKey);
    expect(Array.from(repeat.messageKey)).toEqual(Array.from(first.messageKey));
  });

  it("produces a distinct ciphertext for identical plaintext", async () => {
    const first = await encryptMessage(alice, text("same"));
    const second = await encryptMessage(alice, text("same"));

    // Per-message keys mean no two ciphertexts ever match, so an observer
    // cannot tell that the same thing was sent twice.
    expect(Array.from(first.ciphertext)).not.toEqual(
      Array.from(second.ciphertext),
    );
  });

  it("advances the ratchet key when the direction changes", async () => {
    const first = await encryptMessage(alice, text("a"));
    const aliceKeyBefore = first.header.dhPublicKey.slice();
    await decryptMessage(bob, first);

    const reply = await encryptMessage(bob, text("b"));
    await decryptMessage(alice, reply);

    const second = await encryptMessage(alice, text("c"));

    // Alice ratcheted on receiving Bob's reply, so her key must have changed.
    expect(Array.from(second.header.dhPublicKey)).not.toEqual(
      Array.from(aliceKeyBefore),
    );
    // And `pn` records how long the previous chain was.
    expect(second.header.previousChainLength).toBe(1);
    expect(second.header.messageNumber).toBe(0);
  });

  it("serializes headers to a fixed 40-byte layout", async () => {
    const message = await encryptMessage(alice, text("x"));
    const bytes = serializeHeader({
      dhPublicKey: message.header.dhPublicKey,
      previousChainLength: 1,
      messageNumber: 258,
    });

    expect(bytes).toHaveLength(40);
    expect(bytes.slice(0, 32)).toEqual(message.header.dhPublicKey);
    // Big-endian, matching every other length-prefixed field in the protocol.
    expect(Array.from(bytes.slice(32, 36))).toEqual([0, 0, 0, 1]);
    expect(Array.from(bytes.slice(36, 40))).toEqual([0, 0, 1, 2]);
  });

  it("rejects a shared secret of the wrong size", async () => {
    const s = await sodium();
    await expect(
      initializeInitiator(
        new Uint8Array(16),
        new Uint8Array(64),
        s.crypto_kx_keypair().publicKey,
      ),
    ).rejects.toThrow(RatchetError);
  });

  it("gives the two parties the same view of an interleaved exchange", async () => {
    // Alice sends two, Bob replies, Alice sends again while Bob's second
    // reply is still in flight - a realistic crossing pattern.
    const a1 = await encryptMessage(alice, text("a1"));
    const a2 = await encryptMessage(alice, text("a2"));
    await decryptMessage(bob, a1);
    await decryptMessage(bob, a2);

    const b1 = await encryptMessage(bob, text("b1"));
    const b2 = await encryptMessage(bob, text("b2"));
    await decryptMessage(alice, b2); // out of order
    await decryptMessage(alice, b1);

    const a3 = await encryptMessage(alice, text("a3"));
    expect(decoder.decode(await decryptMessage(bob, a3))).toBe("a3");

    const b3 = await encryptMessage(bob, text("b3"));
    expect(decoder.decode(await decryptMessage(alice, b3))).toBe("b3");
  });
});
