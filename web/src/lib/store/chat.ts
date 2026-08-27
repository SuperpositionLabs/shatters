/**
 * Durable chat store.
 *
 * Wraps the vault with the shapes a UI actually needs: conversations, message
 * history, and the ratchet session behind each one. Nothing here reaches
 * storage unencrypted.
 */
import { deserializeSession, serializeSession } from "../crypto/serialize";
import type { Session } from "../crypto/session";
import type { Vault } from "../storage/vault";
import type { Conversation, MessageStatus, StoredMessage } from "./types";

const IDENTITY_KEY = "identity";
const CONVERSATIONS_KEY = "conversations";
const sessionKey = (id: string) => `session:${id}`;
const historyKey = (id: string) => `history:${id}`;

/** Serialised device identity. Private keys included, so vault-only. */
export interface StoredIdentity {
  accountId: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  dhPublicKey: string;
  dhPrivateKey: string;
  /** Signed prekey pair and its id, needed to answer inbound handshakes. */
  signedPrekeyId: number;
  signedPrekeyPublic: string;
  signedPrekeyPrivate: string;
  signedPrekeySignature: string;
  /** Unconsumed one-time prekeys, by id. */
  oneTimePrekeys: Record<number, { publicKey: string; privateKey: string }>;
}

export class ChatStore {
  /**
   * Serialises writes per record.
   *
   * Two appends to the same conversation racing on read-modify-write would
   * silently drop one message; a queued write is merely slower.
   */
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(private readonly vault: Vault) {}

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    // Errors must not poison the chain for later writers, hence the catch.
    const next = previous.catch(() => undefined).then(work);
    this.writeChains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  // --- identity -----------------------------------------------------------

  async saveIdentity(identity: StoredIdentity): Promise<void> {
    await this.serialize(IDENTITY_KEY, () =>
      this.vault.putJSON(IDENTITY_KEY, identity),
    );
  }

  async loadIdentity(): Promise<StoredIdentity | undefined> {
    return this.vault.getJSON<StoredIdentity>(IDENTITY_KEY);
  }

  // --- sessions -----------------------------------------------------------

  async saveSession(conversationId: string, session: Session): Promise<void> {
    await this.serialize(sessionKey(conversationId), () =>
      this.vault.putJSON(sessionKey(conversationId), serializeSession(session)),
    );
  }

  async loadSession(conversationId: string): Promise<Session | undefined> {
    const raw = await this.vault.getJSON(sessionKey(conversationId));
    return raw === undefined ? undefined : deserializeSession(raw);
  }

  async deleteSession(conversationId: string): Promise<void> {
    await this.vault.delete(sessionKey(conversationId));
  }

  // --- conversations ------------------------------------------------------

  async listConversations(): Promise<Conversation[]> {
    const all =
      (await this.vault.getJSON<Conversation[]>(CONVERSATIONS_KEY)) ?? [];
    // Most recent first: that is the only order a conversation list is ever
    // read in.
    return [...all].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    return (await this.listConversations()).find((c) => c.id === id);
  }

  /** Creates or updates a conversation, merging the given fields. */
  async upsertConversation(
    id: string,
    patch: Partial<Omit<Conversation, "id">> = {},
  ): Promise<Conversation> {
    return this.serialize(CONVERSATIONS_KEY, async () => {
      const all =
        (await this.vault.getJSON<Conversation[]>(CONVERSATIONS_KEY)) ?? [];
      const index = all.findIndex((c) => c.id === id);

      const existing: Conversation = all[index] ?? {
        id,
        lastActivity: 0,
        unreadCount: 0,
      };
      const updated: Conversation = { ...existing, ...patch, id };

      if (index === -1) all.push(updated);
      else all[index] = updated;

      await this.vault.putJSON(CONVERSATIONS_KEY, all);
      return updated;
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.serialize(CONVERSATIONS_KEY, async () => {
      const all =
        (await this.vault.getJSON<Conversation[]>(CONVERSATIONS_KEY)) ?? [];
      await this.vault.putJSON(
        CONVERSATIONS_KEY,
        all.filter((c) => c.id !== id),
      );
    });
    // History and session go too: leaving them would keep a readable record of
    // a conversation the user asked to remove.
    await this.vault.delete(historyKey(id));
    await this.vault.delete(sessionKey(id));
  }

  // --- messages -----------------------------------------------------------

  async listMessages(conversationId: string): Promise<StoredMessage[]> {
    const history =
      (await this.vault.getJSON<StoredMessage[]>(
        historyKey(conversationId),
      )) ?? [];
    return [...history].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Appends a message and bumps the conversation.
   *
   * Idempotent on id, so a redelivered envelope does not duplicate history.
   */
  async appendMessage(message: StoredMessage): Promise<void> {
    await this.serialize(historyKey(message.conversationId), async () => {
      const key = historyKey(message.conversationId);
      const history = (await this.vault.getJSON<StoredMessage[]>(key)) ?? [];

      const index = history.findIndex((m) => m.id === message.id);
      if (index === -1) history.push(message);
      else history[index] = { ...history[index], ...message };

      await this.vault.putJSON(key, history);
    });

    await this.upsertConversation(message.conversationId, {
      lastActivity: message.timestamp,
    });
  }

  /** Updates the delivery status of a single message. */
  async setMessageStatus(
    conversationId: string,
    messageId: string,
    status: MessageStatus,
    envelopeId?: string,
  ): Promise<void> {
    await this.patchMessage(conversationId, messageId, (message) => ({
      ...message,
      status,
      envelopeId: envelopeId ?? message.envelopeId,
    }));
  }

  /**
   * Marks a message deleted, keeping the row.
   *
   * A tombstone rather than a removal, so the UI can show that something was
   * retracted instead of silently reshuffling history under the reader.
   */
  async markDeleted(
    conversationId: string,
    messageId: string,
    at: number,
  ): Promise<void> {
    await this.patchMessage(conversationId, messageId, (message) => ({
      ...message,
      body: "",
      attachment: undefined,
      deletedAt: at,
    }));
  }

  private async patchMessage(
    conversationId: string,
    messageId: string,
    patch: (message: StoredMessage) => StoredMessage,
  ): Promise<void> {
    await this.serialize(historyKey(conversationId), async () => {
      const key = historyKey(conversationId);
      const history = (await this.vault.getJSON<StoredMessage[]>(key)) ?? [];

      const index = history.findIndex((m) => m.id === messageId);
      if (index === -1) return;

      history[index] = patch(history[index]);
      await this.vault.putJSON(key, history);
    });
  }

  // --- unread bookkeeping -------------------------------------------------

  async incrementUnread(conversationId: string): Promise<void> {
    const existing = await this.getConversation(conversationId);
    await this.upsertConversation(conversationId, {
      unreadCount: (existing?.unreadCount ?? 0) + 1,
    });
  }

  async clearUnread(conversationId: string): Promise<void> {
    await this.upsertConversation(conversationId, { unreadCount: 0 });
  }

  // --- attachments --------------------------------------------------------

  async saveAttachment(ref: string, bytes: Uint8Array): Promise<void> {
    await this.vault.put(`blob:${ref}`, bytes);
  }

  async loadAttachment(ref: string): Promise<Uint8Array | undefined> {
    return this.vault.get(`blob:${ref}`);
  }

  async deleteAttachment(ref: string): Promise<void> {
    await this.vault.delete(`blob:${ref}`);
  }
}
