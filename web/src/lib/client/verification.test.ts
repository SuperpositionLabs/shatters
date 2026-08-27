import { beforeEach, describe, expect, it } from "vitest";

import { FakeNetwork, makePeer } from "./test-harness";

describe("identity verification", () => {
  let net: FakeNetwork;

  beforeEach(() => {
    net = new FakeNetwork();
  });

  it("gives both sides the same safety number", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);

    // A number that differed by whose screen it was on would be useless for
    // exactly the comparison it exists to support.
    expect(await alice.client.safetyNumberFor(bob.id)).toBe(
      await bob.client.safetyNumberFor(alice.id),
    );
  });

  it("records the peer identity for an inbound session too", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);

    // Bob never fetched a bundle; the handshake carried the key.
    const conversation = (await bob.client.conversations()).find(
      (c) => c.id === alice.id,
    );
    expect(conversation?.peerIdentityKey).toBeDefined();
  });

  it("has no safety number before a session exists", async () => {
    const alice = await makePeer(net);
    expect(await alice.client.safetyNumberFor("nobody")).toBeUndefined();
  });

  it("marks and clears verification", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    await alice.client.startConversation(bob.id);

    await alice.client.setVerified(bob.id, true);
    let conversation = (await alice.client.conversations()).find(
      (c) => c.id === bob.id,
    );
    expect(conversation?.verifiedIdentityKey).toBe(conversation?.peerIdentityKey);

    await alice.client.setVerified(bob.id, false);
    conversation = (await alice.client.conversations()).find(
      (c) => c.id === bob.id,
    );
    expect(conversation?.verifiedIdentityKey).toBeUndefined();
  });

  it("drops verification when the key changes underneath a live conversation", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const mallory = await makePeer(net);

    await alice.client.startConversation(bob.id);
    await alice.client.setVerified(bob.id, true);

    // Reach into the engine to re-run the identity check with a different key,
    // which is what a second handshake against a substituted bundle does.
    const record = (
      alice.client as unknown as {
        recordPeerIdentity: (id: string, key: Uint8Array) => Promise<void>;
      }
    ).recordPeerIdentity.bind(alice.client);
    await record(bob.id, net.accounts.get(mallory.id)!.identityKey);

    const conversation = (await alice.client.conversations()).find(
      (c) => c.id === bob.id,
    );

    // Carrying an old verification onto a new key would defeat the point of
    // having verified anything.
    expect(conversation?.verifiedIdentityKey).toBeUndefined();
    // And the warning persists rather than appearing once and vanishing.
    expect(conversation?.identityChangedFrom).toBeDefined();
  });

  it("keeps the warning until it is acknowledged", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const mallory = await makePeer(net);

    await alice.client.startConversation(bob.id);
    const record = (
      alice.client as unknown as {
        recordPeerIdentity: (id: string, key: Uint8Array) => Promise<void>;
      }
    ).recordPeerIdentity.bind(alice.client);
    await record(bob.id, net.accounts.get(mallory.id)!.identityKey);

    await alice.client.acknowledgeIdentityChange(bob.id);
    const conversation = (await alice.client.conversations()).find(
      (c) => c.id === bob.id,
    );
    expect(conversation?.identityChangedFrom).toBeUndefined();
  });

  it("does not warn when the key is unchanged", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.startConversation(bob.id);
    const record = (
      alice.client as unknown as {
        recordPeerIdentity: (id: string, key: Uint8Array) => Promise<void>;
      }
    ).recordPeerIdentity.bind(alice.client);
    await record(bob.id, net.accounts.get(bob.id)!.identityKey);

    const conversation = (await alice.client.conversations()).find(
      (c) => c.id === bob.id,
    );
    // A warning that fires on ordinary use is a warning people learn to
    // dismiss without reading.
    expect(conversation?.identityChangedFrom).toBeUndefined();
  });
});
