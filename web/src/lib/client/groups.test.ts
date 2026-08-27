import { beforeEach, describe, expect, it } from "vitest";

import { currentMembers } from "../group/state";
import { FakeNetwork, makePeer, rawSend } from "./test-harness";

describe("ChatClient groups", () => {
  let net: FakeNetwork;

  beforeEach(() => {
    net = new FakeNetwork();
  });

  it("creates a group and tells every member", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [
      bob.id,
      carol.id,
    ]);

    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    for (const peer of [bob, carol]) {
      const conversation = (await peer.client.conversations()).find(
        (c) => c.id === group.id,
      );
      expect(conversation?.isGroup).toBe(true);
      expect(conversation?.displayName).toBe("Team");
    }
  });

  it("does not derive the group id from its membership", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const first = await alice.client.createGroupConversation("A", [bob.id]);
    const second = await alice.client.createGroupConversation("B", [bob.id]);

    // An id computed from who is in the group would leak exactly that to
    // anyone who saw it.
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toContain(bob.id);
  });

  it("fans a message out to every member, attributed to its sender", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [
      bob.id,
      carol.id,
    ]);
    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    await alice.client.sendGroupText(group.id, "hello everyone");
    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    for (const peer of [bob, carol]) {
      const [message] = await peer.client.messages(group.id);
      expect(message.body).toBe("hello everyone");
      // In a group the conversation id is the group, so the sender must be
      // recorded separately or nobody knows who spoke.
      expect(message.senderId).toBe(alice.id);
    }
  });

  it("lets any member speak to the others", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [
      bob.id,
      carol.id,
    ]);
    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    await bob.client.sendGroupText(group.id, "bob here");
    await net.drain(alice.id, alice.client);
    await net.drain(carol.id, carol.client);

    expect((await alice.client.messages(group.id))[0].body).toBe("bob here");
    expect((await carol.client.messages(group.id))[0].senderId).toBe(bob.id);
  });

  it("distributes membership changes", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [bob.id]);
    await net.drain(bob.id, bob.client);

    await alice.client.updateGroup(group.id, { add: [carol.id] });
    await net.drain(bob.id, bob.client);

    const bobView = await bob.client.group(group.id);
    expect(bobView && currentMembers(bobView)).toContain(carol.id);
  });

  it("distributes a rename", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const group = await alice.client.createGroupConversation("Old", [bob.id]);
    await net.drain(bob.id, bob.client);

    await alice.client.updateGroup(group.id, { name: "New" });
    await net.drain(bob.id, bob.client);

    expect((await bob.client.group(group.id))?.name).toBe("New");
  });

  it("refuses a group message from a non-member", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const mallory = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [bob.id]);
    await net.drain(bob.id, bob.client);

    // Mallory knows the id but was never added. The client would not let her
    // send to a group she is not in, so this reaches past it.
    await mallory.client.startConversation(bob.id);
    await rawSend(mallory.client)(bob.id, {
      type: "group-text",
      groupId: group.id,
      id: "injected",
      body: "I am in this group",
      timestamp: 9999,
    });

    await net.drain(bob.id, bob.client);

    // A message must not enter a group view on its own say-so.
    expect(await bob.client.messages(group.id)).toEqual([]);
    expect(bob.errors.length).toBeGreaterThan(0);
  });

  it("refuses a membership change from a non-member", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const mallory = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [bob.id]);
    await net.drain(bob.id, bob.client);

    await mallory.client.startConversation(bob.id);
    await rawSend(mallory.client)(bob.id, {
      type: "group-update",
      groupId: group.id,
      addMembers: [mallory.id],
      timestamp: 9999,
    });

    await net.drain(bob.id, bob.client);

    // Otherwise anyone who learned the id could add themselves to it.
    const view = await bob.client.group(group.id);
    expect(view && currentMembers(view)).not.toContain(mallory.id);
  });

  it("stops delivering to a member who was removed", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [
      bob.id,
      carol.id,
    ]);
    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    await alice.client.updateGroup(group.id, { remove: [carol.id] });
    await net.drain(bob.id, bob.client);
    net.inboxes.set(carol.id, []);

    await alice.client.sendGroupText(group.id, "members only");
    await net.drain(bob.id, bob.client);

    expect((await bob.client.messages(group.id)).at(-1)?.body).toBe(
      "members only",
    );
    // Removed means removed: no envelope should have been addressed to her.
    expect(net.inboxes.get(carol.id) ?? []).toHaveLength(0);
  });

  it("tells a removed member so they stop locally too", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [bob.id]);
    await net.drain(bob.id, bob.client);

    await alice.client.updateGroup(group.id, { remove: [bob.id] });
    await net.drain(bob.id, bob.client);

    // Waiting to notice the silence is worse than being told.
    const view = await bob.client.group(group.id);
    expect(view && currentMembers(view)).not.toContain(bob.id);
  });

  it("leaves a group locally even when nobody can be told", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [bob.id]);
    await net.drain(bob.id, bob.client);

    net.failNextSend = true;
    await alice.client.leaveGroup(group.id);

    // Staying in a group the user left is worse than the others not knowing.
    const view = await alice.client.group(group.id);
    expect(view && currentMembers(view)).not.toContain(alice.id);
  });

  it("refuses to send to a group it is not in", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [bob.id]);
    await alice.client.leaveGroup(group.id);

    await expect(
      alice.client.sendGroupText(group.id, "still here?"),
    ).rejects.toThrow(/not a member/);
  });

  it("refuses to act on an unknown group", async () => {
    const alice = await makePeer(net);
    await expect(alice.client.sendGroupText("g-nope", "hi")).rejects.toThrow(
      /unknown group/,
    );
  });

  it("delivers to the reachable members when one send fails", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [
      bob.id,
      carol.id,
    ]);
    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    // One recipient fails; a member whose session is unreachable must not
    // silence the group for everyone else.
    net.failNextSend = true;
    const message = await alice.client.sendGroupText(group.id, "partial");
    expect(message.status).toBe("sent");

    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    const delivered = [
      (await bob.client.messages(group.id)).length,
      (await carol.client.messages(group.id)).length,
    ];
    expect(delivered.filter((n) => n > 0)).toHaveLength(1);
  });

  it("converges when two members change membership independently", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);
    const dave = await makePeer(net);

    const group = await alice.client.createGroupConversation("Team", [
      bob.id,
      carol.id,
    ]);
    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);

    // Two members act without seeing each other's change first.
    await alice.client.updateGroup(group.id, { add: [dave.id] });
    await bob.client.updateGroup(group.id, { name: "Renamed" });

    await net.drain(bob.id, bob.client);
    await net.drain(carol.id, carol.client);
    await net.drain(alice.id, alice.client);

    const views = await Promise.all([
      alice.client.group(group.id),
      bob.client.group(group.id),
      carol.client.group(group.id),
    ]);

    // Every member must reach the same answer without a server to arbitrate.
    const memberships = views.map((v) => v && currentMembers(v));
    expect(memberships[1]).toEqual(memberships[0]);
    expect(memberships[2]).toEqual(memberships[0]);
    expect(views[0]?.name).toBe("Renamed");
    expect(views[2]?.name).toBe("Renamed");
  });
});
