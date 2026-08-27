import { beforeEach, describe, expect, it } from "vitest";

import {
  type Identity,
  generateIdentity,
  signDetached,
  signedPrekeyMessage,
  sodium,
} from "../crypto/identity";
import {
  SerializationError,
  deserializeSession,
  serializeSession,
} from "../crypto/serialize";
import {
  type PrekeyStore,
  acceptSession,
  decrypt,
  encrypt,
  startSession,
} from "../crypto/session";
import type { KeyPair } from "../crypto/identity";
import { MemoryAdapter } from "../storage/adapter";
import { Vault } from "../storage/vault";
import { ChatStore } from "./chat";
import type { StoredMessage } from "./types";

const fast = { strength: "interactive" } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class MemoryPrekeys implements PrekeyStore {
  readonly signed = new Map<number, KeyPair>();
  readonly oneTime = new Map<number, KeyPair>();

  async signedPrekey(id: number) {
    return this.signed.get(id);
  }

  async takeOneTimePrekey(id: number) {
    const key = this.oneTime.get(id);
    this.oneTime.delete(id);
    return key;
  }
}

/** Establishes a real session pair so the codec is exercised on live state. */
async function establish() {
  const s = await sodium();
  const alice: Identity = await generateIdentity();
  const bob: Identity = await generateIdentity();

  const prekeys = new MemoryPrekeys();
  const spkPair = s.crypto_kx_keypair();
  prekeys.signed.set(1, spkPair);
  const signature = await signDetached(
    bob.signing.privateKey,
    signedPrekeyMessage(spkPair.publicKey, 1),
  );

  const aliceSession = await startSession(alice, {
    identityKey: bob.signing.publicKey,
    identityDhKey: bob.dh.publicKey,
    signedPrekey: { id: 1, publicKey: spkPair.publicKey, signature },
  });

  return { alice, bob, prekeys, aliceSession };
}

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m1",
    conversationId: "peer-1",
    direction: "outgoing",
    body: "hello",
    timestamp: 1000,
    status: "pending",
    ...overrides,
  };
}

describe("session serialisation", () => {
  it("round-trips a session that can still decrypt", async () => {
    const { bob, prekeys, aliceSession } = await establish();

    const wire = await encrypt(aliceSession, encoder.encode("before reload"));

    // Serialise Alice's session, revive it, and keep talking.
    const revived = deserializeSession(
      JSON.parse(JSON.stringify(serializeSession(aliceSession))),
    );

    const accepted = await acceptSession(bob, prekeys, wire);
    expect(decoder.decode(accepted.plaintext)).toBe("before reload");

    const reply = await encrypt(accepted.session, encoder.encode("after"));
    // The revived session must carry the ratchet forward, not just look right.
    expect(decoder.decode(await decrypt(revived, reply))).toBe("after");
  });

  it("preserves the skipped-key window", async () => {
    const { bob, prekeys, aliceSession } = await establish();

    const first = await encrypt(aliceSession, encoder.encode("one"));
    const second = await encrypt(aliceSession, encoder.encode("two"));
    const third = await encrypt(aliceSession, encoder.encode("three"));

    const accepted = await acceptSession(bob, prekeys, first);
    // Receiving out of order caches a skipped key.
    await decrypt(accepted.session, third);
    expect(accepted.session.state.skippedKeys.size).toBeGreaterThan(0);

    const revived = deserializeSession(
      JSON.parse(JSON.stringify(serializeSession(accepted.session))),
    );
    expect(revived.state.skippedKeys.size).toBe(
      accepted.session.state.skippedKeys.size,
    );

    // Dropping the window would silently break out-of-order delivery after a
    // reload - a failure that only shows up on a bad network.
    expect(decoder.decode(await decrypt(revived, second))).toBe("two");
  });

  it("preserves the pending handshake header", async () => {
    const { aliceSession } = await establish();
    expect(aliceSession.pendingX3DH).toBeDefined();

    const revived = deserializeSession(
      JSON.parse(JSON.stringify(serializeSession(aliceSession))),
    );

    // Lost here, a reloaded initiator would stop repeating the handshake and
    // a peer that never received it could never reply.
    expect(revived.pendingX3DH?.ephemeralKey).toEqual(
      aliceSession.pendingX3DH?.ephemeralKey,
    );
    expect(revived.pendingX3DH?.signedPrekeyId).toBe(1);
  });

  it("refuses an unknown format version", async () => {
    const { aliceSession } = await establish();
    const raw = serializeSession(aliceSession) as unknown as Record<
      string,
      unknown
    >;
    raw.version = 99;

    // Guessing at an unknown layout risks reviving a corrupt ratchet that
    // fails later, far from the cause.
    expect(() => deserializeSession(raw)).toThrow(SerializationError);
  });

  it("refuses a non-object record", () => {
    expect(() => deserializeSession(null)).toThrow(SerializationError);
  });
});

describe("ChatStore", () => {
  let adapter: MemoryAdapter;
  let vault: Vault;
  let store: ChatStore;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    vault = await Vault.create("pw", { adapter, ...fast });
    store = new ChatStore(vault);
  });

  it("persists a session across a lock and unlock", async () => {
    const { aliceSession } = await establish();
    await store.saveSession("peer-1", aliceSession);

    vault.lock();
    const reopened = new ChatStore(await Vault.unlock("pw", adapter));

    const loaded = await reopened.loadSession("peer-1");
    expect(loaded?.state.rootKey).toEqual(aliceSession.state.rootKey);
  });

  it("never writes session keys in the clear", async () => {
    const { aliceSession } = await establish();
    await store.saveSession("peer-1", aliceSession);

    const s = await sodium();
    const rootKey = s.to_base64(
      aliceSession.state.rootKey,
      s.base64_variants.ORIGINAL,
    );

    // Serialised session state contains live chain keys; it must only ever
    // reach storage through the vault.
    for (const key of await adapter.keys()) {
      const raw = await adapter.get(key);
      expect(decoder.decode(raw!)).not.toContain(rootKey);
    }
  });

  it("stores and orders message history", async () => {
    await store.appendMessage(message({ id: "b", timestamp: 2000 }));
    await store.appendMessage(message({ id: "a", timestamp: 1000 }));
    await store.appendMessage(message({ id: "c", timestamp: 3000 }));

    expect((await store.listMessages("peer-1")).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is idempotent on message id", async () => {
    await store.appendMessage(message({ id: "m1", status: "pending" }));
    await store.appendMessage(message({ id: "m1", status: "sent" }));

    // A redelivered envelope must not duplicate history.
    const history = await store.listMessages("peer-1");
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("sent");
  });

  it("records status transitions", async () => {
    await store.appendMessage(message({ id: "m1" }));

    await store.setMessageStatus("peer-1", "m1", "sent", "env-1");
    await store.setMessageStatus("peer-1", "m1", "delivered");

    const [stored] = await store.listMessages("peer-1");
    expect(stored.status).toBe("delivered");
    // The envelope id survives a later status change that does not supply one.
    expect(stored.envelopeId).toBe("env-1");
  });

  it("tombstones a deleted message instead of removing it", async () => {
    await store.appendMessage(message({ id: "m1", body: "regrettable" }));
    await store.markDeleted("peer-1", "m1", 5000);

    const [stored] = await store.listMessages("peer-1");
    // Keeping the row lets the UI show a retraction rather than silently
    // reshuffling history under the reader.
    expect(stored.deletedAt).toBe(5000);
    expect(stored.body).toBe("");
  });

  it("ignores a status update for an unknown message", async () => {
    await expect(
      store.setMessageStatus("peer-1", "nope", "sent"),
    ).resolves.toBeUndefined();
  });

  it("does not lose messages appended concurrently", async () => {
    // Read-modify-write on shared history: without serialisation these
    // interleave and silently drop all but the last.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.appendMessage(message({ id: `m${i}`, timestamp: 1000 + i })),
      ),
    );

    expect(await store.listMessages("peer-1")).toHaveLength(20);
  });

  it("does not lose conversations upserted concurrently", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.upsertConversation(`peer-${i}`, { lastActivity: i }),
      ),
    );

    expect(await store.listConversations()).toHaveLength(20);
  });

  it("orders conversations by recency", async () => {
    await store.upsertConversation("old", { lastActivity: 1 });
    await store.upsertConversation("new", { lastActivity: 100 });
    await store.upsertConversation("middle", { lastActivity: 50 });

    expect((await store.listConversations()).map((c) => c.id)).toEqual([
      "new",
      "middle",
      "old",
    ]);
  });

  it("bumps last activity when a message arrives", async () => {
    await store.upsertConversation("peer-1", { lastActivity: 1 });
    await store.appendMessage(message({ timestamp: 9999 }));

    expect((await store.getConversation("peer-1"))?.lastActivity).toBe(9999);
  });

  it("tracks unread counts", async () => {
    await store.incrementUnread("peer-1");
    await store.incrementUnread("peer-1");
    expect((await store.getConversation("peer-1"))?.unreadCount).toBe(2);

    await store.clearUnread("peer-1");
    expect((await store.getConversation("peer-1"))?.unreadCount).toBe(0);
  });

  it("keeps a display name local", async () => {
    await store.upsertConversation("peer-1", { displayName: "Alice" });
    expect((await store.getConversation("peer-1"))?.displayName).toBe("Alice");

    // Contact names are local-only; the server must not learn a contact graph.
    for (const key of await adapter.keys()) {
      const raw = await adapter.get(key);
      expect(decoder.decode(raw!)).not.toContain("Alice");
    }
  });

  it("removes history and session when a conversation is deleted", async () => {
    const { aliceSession } = await establish();
    await store.saveSession("peer-1", aliceSession);
    await store.appendMessage(message());

    await store.deleteConversation("peer-1");

    // Leaving either behind would keep a readable record of a conversation
    // the user asked to remove.
    expect(await store.getConversation("peer-1")).toBeUndefined();
    expect(await store.listMessages("peer-1")).toEqual([]);
    expect(await store.loadSession("peer-1")).toBeUndefined();
  });

  it("round-trips an identity", async () => {
    await store.saveIdentity({
      accountId: "acc-1",
      signingPublicKey: "a",
      signingPrivateKey: "b",
      dhPublicKey: "c",
      dhPrivateKey: "d",
      signedPrekeyId: 1,
      signedPrekeyPublic: "e",
      signedPrekeyPrivate: "f",
      signedPrekeySignature: "g",
      oneTimePrekeys: { 1: { publicKey: "h", privateKey: "i" } },
    });

    expect((await store.loadIdentity())?.accountId).toBe("acc-1");
  });

  it("round-trips an attachment", async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await store.saveAttachment("ref-1", bytes);

    expect(await store.loadAttachment("ref-1")).toEqual(bytes);

    await store.deleteAttachment("ref-1");
    expect(await store.loadAttachment("ref-1")).toBeUndefined();
  });
});
