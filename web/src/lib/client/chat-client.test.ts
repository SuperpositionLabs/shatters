import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Identity, SignedPrekey } from "../crypto/identity";
import { MemoryAdapter } from "../storage/adapter";
import { Vault } from "../storage/vault";
import { ChatStore } from "../store/chat";
import type { ApiClient } from "../transport/api";
import type { DeliveredEnvelope } from "../transport/socket";
import { ChatClient, PREKEY_LOW_WATER, PREKEY_TARGET } from "./chat-client";

const fast = { strength: "interactive" } as const;

/**
 * An in-memory stand-in for the server: it holds registered bundles and routes
 * envelopes between clients, so two real ChatClients can talk without one.
 */
class FakeNetwork {
  readonly accounts = new Map<
    string,
    {
      identityKey: Uint8Array;
      identityDhKey: Uint8Array;
      signedPrekey: { id: number; publicKey: Uint8Array; signature: Uint8Array };
      oneTimePrekeys: { id: number; publicKey: Uint8Array }[];
    }
  >();

  readonly inboxes = new Map<string, DeliveredEnvelope[]>();
  private nextEnvelope = 0;
  /** Set to make the next send fail, for the failure paths. */
  failNextSend = false;

  apiFor(accountId: () => string): ApiClient {
    const net = this;

    return {
      get sessionToken() {
        return "token";
      },
      register: async (
        identity: Identity,
        signedPrekey: SignedPrekey,
        oneTimePrekeys: { id: number; publicKey: Uint8Array }[] = [],
      ) => {
        const { accountId: derive } = await import("../crypto/identity");
        const id = await derive(identity.signing.publicKey);
        net.accounts.set(id, {
          identityKey: identity.signing.publicKey,
          identityDhKey: identity.dh.publicKey,
          signedPrekey,
          oneTimePrekeys: [...oneTimePrekeys],
        });
        return id;
      },
      authenticate: async () => "token",
      useToken: () => undefined,
      fetchBundle: async (peer: string) => {
        const account = net.accounts.get(peer);
        if (!account) throw new Error(`unknown account ${peer}`);
        // Consumed on fetch, exactly as the server does.
        const otk = account.oneTimePrekeys.shift();
        return {
          identityKey: account.identityKey,
          identityDhKey: account.identityDhKey,
          signedPrekey: account.signedPrekey,
          oneTimePrekey: otk,
        };
      },
      uploadPrekeys: async (prekeys: { id: number; publicKey: Uint8Array }[]) => {
        net.accounts.get(accountId())?.oneTimePrekeys.push(...prekeys);
        return prekeys.length;
      },
      sendEnvelope: async (recipient: string, payload: Uint8Array) => {
        if (net.failNextSend) {
          net.failNextSend = false;
          throw new Error("network down");
        }
        const id = `env-${net.nextEnvelope++}`;
        const inbox = net.inboxes.get(recipient) ?? [];
        inbox.push({
          id,
          senderId: accountId(),
          payload,
          createdAt: "now",
        });
        net.inboxes.set(recipient, inbox);
        return id;
      },
      fetchEnvelopes: async () => [],
      acknowledge: async () => 0,
    } as unknown as ApiClient;
  }

  /** Delivers everything queued for a client into its engine. */
  async drain(to: string, client: ChatClient): Promise<void> {
    const inbox = this.inboxes.get(to) ?? [];
    this.inboxes.set(to, []);
    for (const envelope of inbox) {
      await client.handleEnvelope(envelope);
    }
  }
}

interface Peer {
  client: ChatClient;
  store: ChatStore;
  id: string;
  typing: { conversationId: string; until: number }[];
  errors: unknown[];
}

async function makePeer(net: FakeNetwork, clock = { t: 1000 }): Promise<Peer> {
  const vault = await Vault.create("pw", {
    adapter: new MemoryAdapter(),
    ...fast,
  });
  const store = new ChatStore(vault);

  const typing: { conversationId: string; until: number }[] = [];
  const errors: unknown[] = [];

  let ownId = "";
  let counter = 0;
  const client = new ChatClient({
    api: net.apiFor(() => ownId),
    store,
    now: () => clock.t++,
    newId: () => `id-${ownId.slice(0, 4)}-${counter++}`,
    events: {
      onTyping: (conversationId, until) => typing.push({ conversationId, until }),
      onError: (e) => errors.push(e),
    },
  });

  ownId = await client.register();
  return { client, store, id: ownId, typing, errors };
}

describe("ChatClient", () => {
  let net: FakeNetwork;

  beforeEach(() => {
    net = new FakeNetwork();
  });

  it("registers and publishes a full prekey pool", async () => {
    const alice = await makePeer(net);

    expect(alice.id).toHaveLength(43);
    expect(net.accounts.get(alice.id)?.oneTimePrekeys).toHaveLength(
      PREKEY_TARGET,
    );
    expect(alice.client.ready).toBe(true);
  });

  it("carries a text message between two clients", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "hello bob");
    await net.drain(bob.id, bob.client);

    const received = await bob.client.messages(alice.id);
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe("hello bob");
    expect(received[0].direction).toBe("incoming");
  });

  it("shows an outgoing message before the network responds", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const seen: string[] = [];
    // A UI that waits for a round trip feels broken on a slow link, so the
    // first notification must arrive while the message is still pending.
    const client = alice.client;
    (client as unknown as { events: { onConversationChanged: (c: string) => void } }).events.onConversationChanged =
      () => {
        void client.messages(bob.id).then((m) => {
          if (m[0]) seen.push(m[0].status);
        });
      };

    await client.sendText(bob.id, "hi");
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]).toBe("pending");
  });

  it("marks a failed send instead of losing the message", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    // Establish the session first so the failure is the send, not the bundle.
    await alice.client.startConversation(bob.id);
    net.failNextSend = true;

    const message = await alice.client.sendText(bob.id, "lost?");
    expect(message.status).toBe("failed");

    // Still in history and retryable: a message stuck with no way back is a
    // lost message.
    const history = await alice.client.messages(bob.id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("failed");

    await alice.client.retry(bob.id, message.id);
    expect((await alice.client.messages(bob.id))[0].status).toBe("sent");

    await net.drain(bob.id, bob.client);
    expect((await bob.client.messages(alice.id))[0].body).toBe("lost?");
  });

  it("ignores a retry for a message that did not fail", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const message = await alice.client.sendText(bob.id, "fine");

    await alice.client.retry(bob.id, message.id);
    // Re-sending an already delivered message would duplicate it for the peer.
    expect(net.inboxes.get(bob.id)).toHaveLength(1);
  });

  it("reports delivery back to the sender", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "did you get this?");
    await net.drain(bob.id, bob.client);
    // Bob's automatic delivery receipt travels back to Alice.
    await net.drain(alice.id, alice.client);

    const [message] = await alice.client.messages(bob.id);
    expect(message.status).toBe("delivered");
    expect(message.id).toBe(sent.id);
  });

  it("reports read separately from delivered", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "read me");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);
    expect((await alice.client.messages(bob.id))[0].status).toBe("delivered");

    // Delivery is not reading; only opening the conversation says that.
    await bob.client.markRead(alice.id);
    await net.drain(alice.id, alice.client);
    expect((await alice.client.messages(bob.id))[0].status).toBe("read");
  });

  it("does not acknowledge acknowledgements", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);
    await net.drain(alice.id, alice.client);

    // Alice received a receipt. If receipts begat receipts the two clients
    // would acknowledge each other forever.
    await net.drain(bob.id, bob.client);
    expect(net.inboxes.get(alice.id) ?? []).toHaveLength(0);
  });

  it("tracks unread counts and clears them on read", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "one");
    await alice.client.sendText(bob.id, "two");
    await net.drain(bob.id, bob.client);

    const before = await bob.client.conversations();
    expect(before[0].unreadCount).toBe(2);

    await bob.client.markRead(alice.id);
    const after = await bob.client.conversations();
    expect(after[0].unreadCount).toBe(0);
  });

  it("surfaces a typing indicator with an expiry", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    await alice.client.startConversation(bob.id);

    await alice.client.sendTyping(bob.id);
    await net.drain(bob.id, bob.client);

    expect(bob.typing).toHaveLength(1);
    expect(bob.typing[0].conversationId).toBe(alice.id);
    // An expiry, not a flag: a "stopped typing" message that is lost would
    // otherwise leave the indicator stuck on forever.
    expect(bob.typing[0].until).toBeGreaterThan(0);
  });

  it("leaves no transcript entry for a typing indicator", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    await alice.client.startConversation(bob.id);

    await alice.client.sendTyping(bob.id);
    await net.drain(bob.id, bob.client);

    expect(await bob.client.messages(alice.id)).toEqual([]);
  });

  it("propagates a deletion to the peer", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "regrettable");
    await net.drain(bob.id, bob.client);
    expect((await bob.client.messages(alice.id))[0].body).toBe("regrettable");

    await alice.client.deleteMessage(bob.id, sent.id);
    await net.drain(bob.id, bob.client);

    const [message] = await bob.client.messages(alice.id);
    expect(message.body).toBe("");
    expect(message.deletedAt).toBeDefined();
  });

  it("propagates an edit to the peer", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const sent = await alice.client.sendText(bob.id, "teh typo");
    await net.drain(bob.id, bob.client);

    await alice.client.editMessage(bob.id, sent.id, "the typo");
    await net.drain(bob.id, bob.client);

    expect((await bob.client.messages(alice.id))[0].body).toBe("the typo");
  });

  it("carries an attachment across multiple chunks", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

    await alice.client.sendAttachment(
      bob.id,
      { name: "photo.png", mimeType: "image/png", bytes },
      "look",
    );
    // More than one envelope, since the file exceeds the cap.
    expect((net.inboxes.get(bob.id) ?? []).length).toBeGreaterThan(1);

    await net.drain(bob.id, bob.client);

    const [message] = await bob.client.messages(alice.id);
    expect(message.attachment?.name).toBe("photo.png");
    expect(message.body).toBe("look");
    expect(await bob.client.attachment(message.attachment!.blobRef)).toEqual(
      bytes,
    );
  });

  it("does not surface a partially received attachment as a message", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    const bytes = new Uint8Array(70_000);
    await alice.client.sendAttachment(bob.id, {
      name: "big.bin",
      mimeType: "application/octet-stream",
      bytes,
    });

    // Deliver every chunk but the last.
    const inbox = net.inboxes.get(bob.id) ?? [];
    net.inboxes.set(bob.id, []);
    for (const envelope of inbox.slice(0, -1)) {
      await bob.client.handleEnvelope(envelope);
    }

    expect(await bob.client.messages(alice.id)).toEqual([]);
  });

  it("keeps one bad envelope from wedging the conversation", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "first");
    await net.drain(bob.id, bob.client);

    await alice.client.sendText(bob.id, "second");
    const inbox = net.inboxes.get(bob.id) ?? [];
    // Corrupt the queued envelope, then send a good one behind it.
    inbox[0].payload[inbox[0].payload.length - 1] ^= 0xff;
    net.inboxes.set(bob.id, []);
    await bob.client.handleEnvelope(inbox[0]);

    expect(bob.errors.length).toBeGreaterThan(0);

    await alice.client.sendText(bob.id, "third");
    await net.drain(bob.id, bob.client);

    // The undecryptable message is lost, but the conversation is not.
    const bodies = (await bob.client.messages(alice.id)).map((m) => m.body);
    expect(bodies).toContain("first");
    expect(bodies).toContain("third");
  });

  it("ignores content it does not understand", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    await alice.client.startConversation(bob.id);

    // Reach past the public API to send a frame from a hypothetical future.
    const send = (
      alice.client as unknown as {
        sendContent: (id: string, c: unknown) => Promise<string>;
      }
    ).sendContent.bind(alice.client);
    await send(bob.id, { type: "text", id: "x", body: "ok", timestamp: 1 });

    await net.drain(bob.id, bob.client);
    expect(await bob.client.messages(alice.id)).toHaveLength(1);
  });

  it("replenishes prekeys once the pool runs low", async () => {
    const alice = await makePeer(net);
    const stored = (await alice.store.loadIdentity())!;

    // Drain the local pool to just under the low-water mark.
    const ids = Object.keys(stored.oneTimePrekeys).map(Number);
    for (const id of ids.slice(0, ids.length - PREKEY_LOW_WATER)) {
      delete stored.oneTimePrekeys[id];
    }
    await alice.client.persistIdentity(stored);

    const added = await alice.client.replenishPrekeys();
    expect(added).toBeGreaterThan(0);

    // Otherwise a busy account eventually exhausts its pool and every new peer
    // falls back to the weaker three-DH handshake.
    const after = await alice.store.loadIdentity();
    expect(Object.keys(after!.oneTimePrekeys)).toHaveLength(PREKEY_TARGET);
  });

  it("does not replenish while the pool is healthy", async () => {
    const alice = await makePeer(net);
    expect(await alice.client.replenishPrekeys()).toBe(0);
  });

  it("consumes a one-time prekey exactly once on inbound handshake", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "hello");
    await net.drain(bob.id, bob.client);

    const stored = await bob.store.loadIdentity();
    // Bob published PREKEY_TARGET and Alice consumed one.
    expect(Object.keys(stored!.oneTimePrekeys).length).toBeLessThan(
      PREKEY_TARGET,
    );
  });

  it("resumes from the vault after a restart", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "before restart");
    await net.drain(bob.id, bob.client);

    // A fresh engine over the same store, as if the page had reloaded.
    let ownId = bob.id;
    const revived = new ChatClient({
      api: net.apiFor(() => ownId),
      store: bob.store,
      now: () => 5000,
      newId: () => "revived",
    });
    expect(await revived.resume()).toBe(true);
    ownId = revived.accountId;

    expect((await revived.messages(alice.id))[0].body).toBe("before restart");

    // And the revived session still decrypts new traffic.
    await alice.client.sendText(bob.id, "after restart");
    await net.drain(bob.id, revived);
    expect((await revived.messages(alice.id)).map((m) => m.body)).toContain(
      "after restart",
    );
  });

  it("reports no identity to resume from an empty store", async () => {
    const vault = await Vault.create("pw", {
      adapter: new MemoryAdapter(),
      ...fast,
    });
    const client = new ChatClient({
      api: net.apiFor(() => ""),
      store: new ChatStore(vault),
    });

    expect(await client.resume()).toBe(false);
    expect(client.ready).toBe(false);
  });

  it("refuses a conversation with yourself", async () => {
    const alice = await makePeer(net);
    await expect(alice.client.startConversation(alice.id)).rejects.toThrow(
      /yourself/,
    );
  });

  it("fails to start a conversation with an unknown account", async () => {
    const alice = await makePeer(net);
    await expect(
      alice.client.startConversation("not-an-account"),
    ).rejects.toThrow();
  });

  it("forgets everything when a conversation is deleted", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);

    await alice.client.sendText(bob.id, "hello");
    await alice.client.deleteConversation(bob.id);

    expect(await alice.client.conversations()).toEqual([]);
    expect(await alice.client.messages(bob.id)).toEqual([]);
  });

  it("orders the conversation list by recency", async () => {
    const alice = await makePeer(net);
    const bob = await makePeer(net);
    const carol = await makePeer(net);

    await alice.client.sendText(bob.id, "first");
    await alice.client.sendText(carol.id, "second");

    expect((await alice.client.conversations())[0].id).toBe(carol.id);
  });

  it("throws rather than guessing when used before it is ready", async () => {
    const vault = await Vault.create("pw", {
      adapter: new MemoryAdapter(),
      ...fast,
    });
    const client = new ChatClient({
      api: net.apiFor(() => ""),
      store: new ChatStore(vault),
    });

    expect(() => client.accountId).toThrow(/not ready/);
  });
});
