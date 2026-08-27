import { beforeEach, describe, expect, it } from "vitest";

import { FakeNetwork, makePeer } from "./test-harness";

describe("reactions", () => {
  let net: FakeNetwork;

  beforeEach(() => {
    net = new FakeNetwork();
  });

  it("records a reaction locally and delivers it to the peer", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "look at this");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);

    await bob.client.react(alice.id, sent.id, "👍");

    // Recorded on the reacting side immediately, so it appears without a round
    // trip and survives a send that fails.
    expect((await bob.client.messages(alice.id))[0].reactions).toEqual({
      "👍": [bob.id],
    });

    await net.drain(alice.id, alice.client);

    // And it actually arrives. Sending then discarding is how two users end up
    // seeing different things with no way to tell why.
    expect((await alice.client.messages(bob.id))[0].reactions).toEqual({
      "👍": [bob.id],
    });
  });

  it("toggles a reaction off", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);

    await bob.client.react(alice.id, sent.id, "👍");
    await net.drain(alice.id, alice.client);
    await bob.client.react(alice.id, sent.id, "👍", false);
    await net.drain(alice.id, alice.client);

    // An emoji nobody is holding should disappear rather than linger empty.
    expect((await alice.client.messages(bob.id))[0].reactions).toEqual({});
  });

  it("counts the same emoji from different people separately", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);

    await bob.client.react(alice.id, sent.id, "👍");
    await net.drain(alice.id, alice.client);
    await alice.client.react(bob.id, sent.id, "👍");

    // The same emoji from two people is two facts, not one.
    const reactions = (await alice.client.messages(bob.id))[0].reactions;
    expect(reactions?.["👍"]).toHaveLength(2);
    expect(reactions?.["👍"]).toContain(alice.id);
    expect(reactions?.["👍"]).toContain(bob.id);
  });

  it("is idempotent for the same account and emoji", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);

    await bob.client.react(alice.id, sent.id, "👍");
    await bob.client.react(alice.id, sent.id, "👍");
    await net.drain(alice.id, alice.client);

    // A redelivered envelope must not inflate the count.
    expect(
      (await alice.client.messages(bob.id))[0].reactions?.["👍"],
    ).toHaveLength(1);
  });

  it("keeps different emoji apart", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);

    await bob.client.react(alice.id, sent.id, "👍");
    await bob.client.react(alice.id, sent.id, "🎉");
    await net.drain(alice.id, alice.client);

    const reactions = (await alice.client.messages(bob.id))[0].reactions;
    expect(Object.keys(reactions ?? {}).sort()).toEqual(["🎉", "👍"]);
  });

  it("leaves no transcript entry for a reaction", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);

    await bob.client.react(alice.id, sent.id, "👍");
    await net.drain(alice.id, alice.client);

    // A reaction annotates a message; it is not one.
    expect(await alice.client.messages(bob.id)).toHaveLength(1);
  });

  it("ignores a reaction to a message it has never seen", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.startConversation(bob.id);
    await alice.client.react(bob.id, "never-existed", "👍");
    await net.drain(bob.id, bob.client);

    // Delivery reordering makes this ordinary rather than exceptional, so it
    // must not throw or invent a message to hang the reaction on.
    expect(await bob.client.messages(alice.id)).toEqual([]);
  });
});
