import { beforeEach, describe, expect, it } from "vitest";

import {
  type Identity,
  type KeyPair,
  generateIdentity,
  signDetached,
  signedPrekeyMessage,
  sodium,
} from "./identity";
import { MessageType, decodeMessage } from "./envelope";
import {
  type PrekeyStore,
  type Session,
  SessionError,
  acceptSession,
  decrypt,
  encrypt,
  startSession,
} from "./session";
import type { PrekeyBundle } from "./x3dh";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = (value: string) => encoder.encode(value);

/** An in-memory prekey store that consumes one-time prekeys on use. */
class MemoryPrekeyStore implements PrekeyStore {
  readonly signed = new Map<number, KeyPair>();
  readonly oneTime = new Map<number, KeyPair>();

  async signedPrekey(id: number): Promise<KeyPair | undefined> {
    return this.signed.get(id);
  }

  async takeOneTimePrekey(id: number): Promise<KeyPair | undefined> {
    const key = this.oneTime.get(id);
    this.oneTime.delete(id);
    return key;
  }
}

async function makeResponder(oneTimePrekeyId?: number) {
  const s = await sodium();
  const identity = await generateIdentity();
  const store = new MemoryPrekeyStore();

  const spkId = 1;
  const spkPair = s.crypto_kx_keypair();
  store.signed.set(spkId, spkPair);
  const signature = await signDetached(
    identity.signing.privateKey,
    signedPrekeyMessage(spkPair.publicKey, spkId),
  );

  let oneTimePrekey: PrekeyBundle["oneTimePrekey"];
  if (oneTimePrekeyId !== undefined) {
    const pair = s.crypto_kx_keypair();
    store.oneTime.set(oneTimePrekeyId, pair);
    oneTimePrekey = { id: oneTimePrekeyId, publicKey: pair.publicKey };
  }

  const bundle: PrekeyBundle = {
    identityKey: identity.signing.publicKey,
    identityDhKey: identity.dh.publicKey,
    signedPrekey: { id: spkId, publicKey: spkPair.publicKey, signature },
    oneTimePrekey,
  };

  return { identity, store, bundle };
}

describe("session facade", () => {
  let alice: Identity;

  beforeEach(async () => {
    alice = await generateIdentity();
  });

  it("carries a full conversation from handshake to steady state", async () => {
    const bob = await makeResponder(42);

    const aliceSession = await startSession(alice, bob.bundle);
    const opener = await encrypt(aliceSession, text("hello bob"));

    const accepted = await acceptSession(bob.identity, bob.store, opener);
    expect(decoder.decode(accepted.plaintext)).toBe("hello bob");

    const bobSession = accepted.session;

    // Bob replies; Alice's session picks up from the handshake.
    const reply = await encrypt(bobSession, text("hello alice"));
    expect(decoder.decode(await decrypt(aliceSession, reply))).toBe(
      "hello alice",
    );

    // Several more rounds, now fully established.
    for (let i = 0; i < 3; i++) {
      const fromAlice = await encrypt(aliceSession, text(`a${i}`));
      expect(decoder.decode(await decrypt(bobSession, fromAlice))).toBe(`a${i}`);

      const fromBob = await encrypt(bobSession, text(`b${i}`));
      expect(decoder.decode(await decrypt(aliceSession, fromBob))).toBe(`b${i}`);
    }
  });

  it("works when the bundle carries no one-time prekey", async () => {
    const bob = await makeResponder();

    const aliceSession = await startSession(alice, bob.bundle);
    const opener = await encrypt(aliceSession, text("no otk"));

    expect(decodeMessage(opener).x3dh?.oneTimePrekeyId).toBeUndefined();

    const accepted = await acceptSession(bob.identity, bob.store, opener);
    expect(decoder.decode(accepted.plaintext)).toBe("no otk");
  });

  it("repeats the X3DH header until the peer answers", async () => {
    const bob = await makeResponder(42);
    const aliceSession = await startSession(alice, bob.bundle);

    // Bob may not have received the first message, so every message before his
    // reply must be able to establish the session on its own.
    const first = await encrypt(aliceSession, text("one"));
    const second = await encrypt(aliceSession, text("two"));
    expect(decodeMessage(first).type).toBe(MessageType.Initial);
    expect(decodeMessage(second).type).toBe(MessageType.Initial);

    const accepted = await acceptSession(bob.identity, bob.store, first);
    expect(decoder.decode(await decrypt(accepted.session, second))).toBe("two");

    // Once Bob answers, the header is dropped.
    const reply = await encrypt(accepted.session, text("got it"));
    await decrypt(aliceSession, reply);
    expect(decodeMessage(await encrypt(aliceSession, text("three"))).type).toBe(
      MessageType.Normal,
    );
  });

  it("establishes from a later initial message if the first is lost", async () => {
    const bob = await makeResponder(42);
    const aliceSession = await startSession(alice, bob.bundle);

    await encrypt(aliceSession, text("lost in transit"));
    const second = await encrypt(aliceSession, text("this one arrives"));

    // Bob never saw message 0; the ratchet must skip to message 1.
    const accepted = await acceptSession(bob.identity, bob.store, second);
    expect(decoder.decode(accepted.plaintext)).toBe("this one arrives");
  });

  it("consumes the one-time prekey exactly once", async () => {
    const bob = await makeResponder(42);
    const aliceSession = await startSession(alice, bob.bundle);
    const opener = await encrypt(aliceSession, text("first"));

    await acceptSession(bob.identity, bob.store, opener);
    expect(bob.store.oneTime.has(42)).toBe(false);

    // Replaying the opener must fail: rebuilding the session from a recording
    // is exactly what consuming the one-time prekey prevents.
    await expect(
      acceptSession(bob.identity, bob.store, opener),
    ).rejects.toThrow(SessionError);
  });

  it("rejects an initial message naming an unknown signed prekey", async () => {
    const bob = await makeResponder(42);
    const aliceSession = await startSession(alice, bob.bundle);
    const opener = await encrypt(aliceSession, text("hi"));

    bob.store.signed.clear();

    await expect(
      acceptSession(bob.identity, bob.store, opener),
    ).rejects.toThrow(/unknown signed prekey/);
  });

  it("refuses to accept a normal message as a handshake", async () => {
    const bob = await makeResponder(42);
    const aliceSession = await startSession(alice, bob.bundle);

    const opener = await encrypt(aliceSession, text("one"));
    const accepted = await acceptSession(bob.identity, bob.store, opener);
    await decrypt(aliceSession, await encrypt(accepted.session, text("ack")));

    const normal = await encrypt(aliceSession, text("normal"));
    const freshBob = await makeResponder(42);
    await expect(
      acceptSession(freshBob.identity, freshBob.store, normal),
    ).rejects.toThrow(/not an initial message/);
  });

  it("rejects a bundle whose signed prekey does not verify", async () => {
    const bob = await makeResponder(42);
    const mallory = await generateIdentity();
    const s = await sodium();

    // A server-substituted prekey, signed by the wrong identity.
    const pair = s.crypto_kx_keypair();
    const signature = await signDetached(
      mallory.signing.privateKey,
      signedPrekeyMessage(pair.publicKey, 1),
    );

    await expect(
      startSession(alice, {
        ...bob.bundle,
        signedPrekey: { id: 1, publicKey: pair.publicKey, signature },
      }),
    ).rejects.toThrow();
  });

  it("leaves no session behind when the initial message is forged", async () => {
    const bob = await makeResponder(42);
    const aliceSession = await startSession(alice, bob.bundle);
    const opener = await encrypt(aliceSession, text("genuine"));

    const forged = opener.slice();
    forged[forged.length - 1] ^= 0xff;

    await expect(
      acceptSession(bob.identity, bob.store, forged),
    ).rejects.toThrow();
  });

  it("keeps two sessions with the same peer independent", async () => {
    const bob = await makeResponder(42);
    const s = await sodium();
    // A second one-time prekey for the second session.
    const secondOtk = s.crypto_kx_keypair();
    bob.store.oneTime.set(43, secondOtk);

    const first = await startSession(alice, bob.bundle);
    const second = await startSession(alice, {
      ...bob.bundle,
      oneTimePrekey: { id: 43, publicKey: secondOtk.publicKey },
    });

    const m1 = await encrypt(first, text("session one"));
    const m2 = await encrypt(second, text("session two"));

    const s1 = await acceptSession(bob.identity, bob.store, m1);
    const s2 = await acceptSession(bob.identity, bob.store, m2);

    expect(decoder.decode(s1.plaintext)).toBe("session one");
    expect(decoder.decode(s2.plaintext)).toBe("session two");

    // Distinct one-time prekeys must yield distinct root keys.
    expect(Array.from(s1.session.state.rootKey)).not.toEqual(
      Array.from(s2.session.state.rootKey),
    );
  });

  it("survives out-of-order delivery on an established session", async () => {
    const bob = await makeResponder(42);
    const aliceSession = await startSession(alice, bob.bundle);
    const accepted = await acceptSession(
      bob.identity,
      bob.store,
      await encrypt(aliceSession, text("open")),
    );
    const bobSession: Session = accepted.session;
    await decrypt(aliceSession, await encrypt(bobSession, text("ack")));

    const one = await encrypt(aliceSession, text("one"));
    const two = await encrypt(aliceSession, text("two"));
    const three = await encrypt(aliceSession, text("three"));

    expect(decoder.decode(await decrypt(bobSession, three))).toBe("three");
    expect(decoder.decode(await decrypt(bobSession, one))).toBe("one");
    expect(decoder.decode(await decrypt(bobSession, two))).toBe("two");
  });
});
