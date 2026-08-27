import { beforeAll, describe, expect, it } from "vitest";

import {
  type Identity,
  generateIdentity,
  signDetached,
  signIdentityDhKey,
  signedPrekeyMessage,
  sodium,
} from "./identity";
import {
  type PrekeyBundle,
  X3DHError,
  initiateX3DH,
  respondX3DH,
} from "./x3dh";

/**
 * The X3DH module needs the private half of the signed prekey, which
 * `createSignedPrekey` does not expose. Sign a locally generated pair instead,
 * which is what a real client does when it keeps its own prekey store.
 */
async function makeSignedPair(identity: Identity, id: number) {
  const s = await sodium();
  const pair = s.crypto_kx_keypair();
  const signature = await signDetached(
    identity.signing.privateKey,
    signedPrekeyMessage(pair.publicKey, id),
  );
  return { id, pair, signature };
}

describe("X3DH", () => {
  let alice: Identity;
  let bob: Identity;

  beforeAll(async () => {
    alice = await generateIdentity();
    bob = await generateIdentity();
  });

  it("derives an identical secret with a one-time prekey", async () => {
    const s = await sodium();
    const spk = await makeSignedPair(bob, 1);
    const otk = { id: 7, pair: s.crypto_kx_keypair() };

    const bundle: PrekeyBundle = {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id,
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
      oneTimePrekey: { id: otk.id, publicKey: otk.pair.publicKey },
    };

    const initiator = await initiateX3DH(alice, bundle);
    const responder = await respondX3DH(
      bob,
      {
        signedPrekeyPrivate: spk.pair.privateKey,
        oneTimePrekeyPrivate: otk.pair.privateKey,
      },
      initiator.header,
    );

    expect(initiator.sharedSecret).toHaveLength(32);
    expect(responder.sharedSecret).toEqual(initiator.sharedSecret);
    // Not an all-zero or otherwise degenerate secret.
    expect(initiator.sharedSecret.some((b) => b !== 0)).toBe(true);

    // Both sides bind the same AD, initiator identity first.
    expect(responder.associatedData).toEqual(initiator.associatedData);
    expect(initiator.associatedData).toHaveLength(64);
    expect(initiator.associatedData.slice(0, 32)).toEqual(
      alice.signing.publicKey,
    );
    expect(initiator.associatedData.slice(32)).toEqual(bob.signing.publicKey);

    // The header carries what the responder needs, and no private material.
    expect(initiator.header.oneTimePrekeyId).toBe(7);
    expect(initiator.header.signedPrekeyId).toBe(1);
    expect(initiator.header.ephemeralKey).toHaveLength(32);
  });

  it("derives an identical secret when the one-time prekey pool is empty", async () => {
    const spk = await makeSignedPair(bob, 2);

    const bundle: PrekeyBundle = {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id,
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
    };

    const initiator = await initiateX3DH(alice, bundle);
    const responder = await respondX3DH(
      bob,
      { signedPrekeyPrivate: spk.pair.privateKey },
      initiator.header,
    );

    expect(responder.sharedSecret).toEqual(initiator.sharedSecret);
    expect(initiator.header.oneTimePrekeyId).toBeUndefined();
  });

  it("derives a different secret with and without the one-time prekey", async () => {
    const s = await sodium();
    const spk = await makeSignedPair(bob, 3);
    const otk = { id: 9, pair: s.crypto_kx_keypair() };

    const base = {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id,
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
    };

    const withOtk = await initiateX3DH(alice, {
      ...base,
      oneTimePrekey: { id: otk.id, publicKey: otk.pair.publicKey },
    });
    const withoutOtk = await initiateX3DH(alice, base);

    // Different DH count (and fresh ephemerals) must not collide.
    expect(withOtk.sharedSecret).not.toEqual(withoutOtk.sharedSecret);
  });

  it("produces a fresh secret per handshake", async () => {
    const spk = await makeSignedPair(bob, 4);
    const bundle: PrekeyBundle = {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id,
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
    };

    const first = await initiateX3DH(alice, bundle);
    const second = await initiateX3DH(alice, bundle);

    // The ephemeral is regenerated each time, so the same bundle must never
    // yield the same key twice.
    expect(first.sharedSecret).not.toEqual(second.sharedSecret);
    expect(first.header.ephemeralKey).not.toEqual(second.header.ephemeralKey);
  });

  it("rejects a bundle whose signed prekey was not signed by the identity", async () => {
    const mallory = await generateIdentity();
    // Prekey signed by Mallory, presented under Bob's identity - exactly what a
    // malicious server would serve to sit in the middle.
    const forged = await makeSignedPair(mallory, 5);

    const bundle: PrekeyBundle = {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: forged.id,
        publicKey: forged.pair.publicKey,
        signature: forged.signature,
      },
    };

    await expect(initiateX3DH(alice, bundle)).rejects.toThrow(X3DHError);
  });

  it("rejects a bundle whose signed prekey id was tampered with", async () => {
    const spk = await makeSignedPair(bob, 6);

    const bundle: PrekeyBundle = {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id + 1, // signature covers the id, so this must fail
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
    };

    await expect(initiateX3DH(alice, bundle)).rejects.toThrow(X3DHError);
  });

  it("rejects a substituted identity DH key", async () => {
    const s = await sodium();
    const spk = await makeSignedPair(bob, 20);
    const mallory = s.crypto_kx_keypair();

    // Signed for bob's real key, then the key itself swapped - exactly what a
    // malicious operator would serve. Unverified, DH2 would contribute no
    // entropy an attacker lacks.
    await expect(
      initiateX3DH(alice, {
        identityKey: bob.signing.publicKey,
        identityDhKey: mallory.publicKey,
        identityDhSignature: await signIdentityDhKey(bob),
        signedPrekey: {
          id: spk.id,
          publicKey: spk.pair.publicKey,
          signature: spk.signature,
        },
      }),
    ).rejects.toThrow(/identity DH key/);
  });

  it("rejects an identity DH key signed by someone else", async () => {
    const spk = await makeSignedPair(bob, 21);
    const mallory = await generateIdentity();

    await expect(
      initiateX3DH(alice, {
        identityKey: bob.signing.publicKey,
        identityDhKey: bob.dh.publicKey,
        identityDhSignature: await signIdentityDhKey(mallory),
        signedPrekey: {
          id: spk.id,
          publicKey: spk.pair.publicKey,
          signature: spk.signature,
        },
      }),
    ).rejects.toThrow(/identity DH key/);
  });

  it("rejects malformed key lengths", async () => {
    const spk = await makeSignedPair(bob, 8);

    await expect(
      initiateX3DH(alice, {
        identityKey: bob.signing.publicKey,
        identityDhKey: new Uint8Array(16),
        identityDhSignature: await signIdentityDhKey(bob),
        signedPrekey: {
          id: spk.id,
          publicKey: spk.pair.publicKey,
          signature: spk.signature,
        },
      }),
    ).rejects.toThrow(X3DHError);
  });

  it("rejects a one-time prekey mismatch between header and local prekeys", async () => {
    const s = await sodium();
    const spk = await makeSignedPair(bob, 10);
    const otk = { id: 11, pair: s.crypto_kx_keypair() };

    const initiator = await initiateX3DH(alice, {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id,
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
      oneTimePrekey: { id: otk.id, publicKey: otk.pair.publicKey },
    });

    // Responder cannot find the one-time prekey the header names. Deriving a
    // three-DH secret here would silently diverge from the initiator.
    await expect(
      respondX3DH(
        bob,
        { signedPrekeyPrivate: spk.pair.privateKey },
        initiator.header,
      ),
    ).rejects.toThrow(X3DHError);
  });

  it("does not agree when a third party substitutes its own ephemeral", async () => {
    const s = await sodium();
    const mallory = await generateIdentity();
    const spk = await makeSignedPair(bob, 12);

    const initiator = await initiateX3DH(alice, {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id,
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
    });

    const tampered = {
      ...initiator.header,
      ephemeralKey: s.crypto_kx_keypair().publicKey,
    };
    const responder = await respondX3DH(
      bob,
      { signedPrekeyPrivate: spk.pair.privateKey },
      tampered,
    );

    expect(responder.sharedSecret).not.toEqual(initiator.sharedSecret);
  });

  it("binds the associated data to the initiator's identity", async () => {
    const spk = await makeSignedPair(bob, 13);
    const initiator = await initiateX3DH(alice, {
      identityKey: bob.signing.publicKey,
      identityDhKey: bob.dh.publicKey,
      identityDhSignature: await signIdentityDhKey(bob),
      signedPrekey: {
        id: spk.id,
        publicKey: spk.pair.publicKey,
        signature: spk.signature,
      },
    });

    // A responder told the message came from Mallory computes different AD,
    // so the first ratchet message will fail to authenticate.
    const mallory = await generateIdentity();
    const responder = await respondX3DH(
      bob,
      { signedPrekeyPrivate: spk.pair.privateKey },
      { ...initiator.header, identityKey: mallory.signing.publicKey },
    );

    expect(responder.associatedData).not.toEqual(initiator.associatedData);
  });
});
