/**
 * The chat engine.
 *
 * Joins identity, X3DH, the ratchet, envelopes, the transport, the vault and
 * the content protocol into one object a UI can drive. Deliberately free of
 * React: this is the model, and it must be testable without a DOM.
 */
import {
  AttachmentAssembler,
  type AttachmentChunkContent,
  type MessageContent,
  chunkAttachment,
  decodeContent,
  encodeContent,
} from "../crypto/content";
import {
  type Identity,
  type KeyPair,
  accountId,
  createSignedPrekey,
  generateIdentity,
  signDetached,
  signedPrekeyMessage,
  sodium,
} from "../crypto/identity";
import {
  type PrekeyStore,
  type Session,
  acceptSession,
  decrypt,
  encrypt,
  startSession,
} from "../crypto/session";
import type { ApiClient } from "../transport/api";
import type { DeliveredEnvelope, Transport } from "../transport/socket";
import type { ChatStore, StoredIdentity } from "../store/chat";
import type { Conversation, StoredMessage } from "../store/types";

/** How many one-time prekeys to publish, and when to top up. */
export const PREKEY_TARGET = 50;
export const PREKEY_LOW_WATER = 10;

/** How long a typing indicator stays true without renewal. */
export const TYPING_TTL_MS = 6000;

export class ChatClientError extends Error {}

export interface ChatEvents {
  /** A conversation's messages changed. */
  onConversationChanged?: (conversationId: string) => void;
  /** The conversation list changed. */
  onConversationsChanged?: () => void;
  /** The peer started or stopped composing. */
  onTyping?: (conversationId: string, until: number) => void;
  /** Something failed in the background, where no call is waiting. */
  onError?: (error: unknown) => void;
}

export interface ChatClientOptions {
  api: ApiClient;
  store: ChatStore;
  events?: ChatEvents;
  /** Injected so tests need neither randomness nor a clock. */
  now?: () => number;
  newId?: () => string;
}

/** Reads the client's own prekeys out of the vault for inbound handshakes. */
class VaultPrekeyStore implements PrekeyStore {
  constructor(
    private readonly client: ChatClient,
    private readonly identity: StoredIdentity,
  ) {}

  async signedPrekey(id: number): Promise<KeyPair | undefined> {
    if (id !== this.identity.signedPrekeyId) return undefined;
    return {
      publicKey: decodeB64(this.identity.signedPrekeyPublic),
      privateKey: decodeB64(this.identity.signedPrekeyPrivate),
      keyType: "x25519",
    };
  }

  async takeOneTimePrekey(id: number): Promise<KeyPair | undefined> {
    const entry = this.identity.oneTimePrekeys[id];
    if (!entry) return undefined;

    // Consumed, then persisted: a one-time prekey reused would let a recorded
    // handshake rebuild the same session.
    delete this.identity.oneTimePrekeys[id];
    await this.client.persistIdentity(this.identity);

    return {
      publicKey: decodeB64(entry.publicKey),
      privateKey: decodeB64(entry.privateKey),
      keyType: "x25519",
    };
  }
}

function encodeB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeB64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class ChatClient {
  private readonly api: ApiClient;
  private readonly store: ChatStore;
  private readonly events: ChatEvents;
  private readonly now: () => number;
  private readonly newId: () => string;

  private identity?: Identity;
  private stored?: StoredIdentity;
  private transport?: Transport;

  /** Partially received attachments, keyed by attachment id. */
  private readonly assemblers = new Map<string, AttachmentAssembler>();
  /** Live sessions, so a conversation is not deserialised per message. */
  private readonly sessions = new Map<string, Session>();

  constructor(options: ChatClientOptions) {
    this.api = options.api;
    this.store = options.store;
    this.events = options.events ?? {};
    this.now = options.now ?? (() => Date.now());
    this.newId =
      options.newId ??
      (() => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return encodeB64(bytes).replace(/[+/=]/g, "");
      });
  }

  get accountId(): string {
    if (!this.stored) throw new ChatClientError("client is not ready");
    return this.stored.accountId;
  }

  get ready(): boolean {
    return this.identity !== undefined;
  }

  // --- lifecycle ----------------------------------------------------------

  /** Generates an identity, registers it, and authenticates. */
  async register(): Promise<string> {
    const s = await sodium();
    const identity = await generateIdentity();

    const signedPrekeyId = 1;
    const spkPair = s.crypto_kx_keypair();
    const signature = await signDetached(
      identity.signing.privateKey,
      signedPrekeyMessage(spkPair.publicKey, signedPrekeyId),
    );

    const oneTimePrekeys: StoredIdentity["oneTimePrekeys"] = {};
    const published: { id: number; publicKey: Uint8Array }[] = [];
    for (let i = 0; i < PREKEY_TARGET; i++) {
      const pair = s.crypto_kx_keypair();
      const id = i + 1;
      oneTimePrekeys[id] = {
        publicKey: encodeB64(pair.publicKey),
        privateKey: encodeB64(pair.privateKey),
      };
      published.push({ id, publicKey: pair.publicKey });
    }

    const id = await accountId(identity.signing.publicKey);
    await this.api.register(
      identity,
      { id: signedPrekeyId, publicKey: spkPair.publicKey, signature },
      published,
    );

    const stored: StoredIdentity = {
      accountId: id,
      signingPublicKey: encodeB64(identity.signing.publicKey),
      signingPrivateKey: encodeB64(identity.signing.privateKey),
      dhPublicKey: encodeB64(identity.dh.publicKey),
      dhPrivateKey: encodeB64(identity.dh.privateKey),
      signedPrekeyId,
      signedPrekeyPublic: encodeB64(spkPair.publicKey),
      signedPrekeyPrivate: encodeB64(spkPair.privateKey),
      signedPrekeySignature: encodeB64(signature),
      oneTimePrekeys,
    };

    await this.store.saveIdentity(stored);
    this.adopt(stored);
    await this.api.authenticate(identity, id);
    return id;
  }

  /** Resumes from a previously stored identity. */
  async resume(): Promise<boolean> {
    const stored = await this.store.loadIdentity();
    if (!stored) return false;

    this.adopt(stored);
    await this.api.authenticate(this.requireIdentity(), stored.accountId);
    return true;
  }

  private adopt(stored: StoredIdentity): void {
    this.stored = stored;
    this.identity = {
      signing: {
        publicKey: decodeB64(stored.signingPublicKey),
        privateKey: decodeB64(stored.signingPrivateKey),
        keyType: "ed25519",
      },
      dh: {
        publicKey: decodeB64(stored.dhPublicKey),
        privateKey: decodeB64(stored.dhPrivateKey),
        keyType: "x25519",
      },
    };
  }

  /** Persists mutated identity state, e.g. after consuming a prekey. */
  async persistIdentity(stored: StoredIdentity): Promise<void> {
    this.stored = stored;
    await this.store.saveIdentity(stored);
  }

  private requireIdentity(): Identity {
    if (!this.identity) throw new ChatClientError("client is not ready");
    return this.identity;
  }

  private requireStored(): StoredIdentity {
    if (!this.stored) throw new ChatClientError("client is not ready");
    return this.stored;
  }

  /** Attaches a connected transport so inbound envelopes reach the engine. */
  attachTransport(transport: Transport): void {
    this.transport = transport;
  }

  // --- prekeys ------------------------------------------------------------

  /**
   * Publishes more one-time prekeys when the local pool runs low.
   *
   * Without this a busy account eventually exhausts its pool, and every new
   * peer falls back to the weaker three-DH handshake.
   */
  async replenishPrekeys(): Promise<number> {
    const stored = this.requireStored();
    const remaining = Object.keys(stored.oneTimePrekeys).length;
    if (remaining > PREKEY_LOW_WATER) return 0;

    const s = await sodium();
    const highest = Object.keys(stored.oneTimePrekeys)
      .map(Number)
      .reduce((max, n) => Math.max(max, n), 0);

    const published: { id: number; publicKey: Uint8Array }[] = [];
    for (let i = 0; i < PREKEY_TARGET - remaining; i++) {
      const pair = s.crypto_kx_keypair();
      const id = highest + i + 1;
      stored.oneTimePrekeys[id] = {
        publicKey: encodeB64(pair.publicKey),
        privateKey: encodeB64(pair.privateKey),
      };
      published.push({ id, publicKey: pair.publicKey });
    }

    await this.api.uploadPrekeys(published);
    await this.persistIdentity(stored);
    return published.length;
  }

  // --- sessions -----------------------------------------------------------

  private async sessionFor(conversationId: string): Promise<Session> {
    const cached = this.sessions.get(conversationId);
    if (cached) return cached;

    const loaded = await this.store.loadSession(conversationId);
    if (loaded) {
      this.sessions.set(conversationId, loaded);
      return loaded;
    }

    // No session yet: fetch the peer's bundle and run X3DH. The bundle's
    // signed prekey is verified inside startSession.
    const bundle = await this.api.fetchBundle(conversationId);
    const session = await startSession(this.requireIdentity(), bundle);
    this.sessions.set(conversationId, session);
    await this.store.saveSession(conversationId, session);
    return session;
  }

  private async persistSession(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (session) await this.store.saveSession(conversationId, session);
  }

  // --- sending ------------------------------------------------------------

  /**
   * Seals and submits content, without touching local history.
   *
   * Used directly for signals the user never sees as messages - receipts,
   * typing, reactions - so they leave no trace in the transcript.
   */
  private async sendContent(
    conversationId: string,
    content: MessageContent,
  ): Promise<string> {
    const session = await this.sessionFor(conversationId);
    const wire = await encrypt(session, encodeContent(content));
    const envelopeId = await this.api.sendEnvelope(conversationId, wire);
    await this.persistSession(conversationId);
    return envelopeId;
  }

  /**
   * Sends a text message.
   *
   * The message is stored as `pending` and surfaced before the network is
   * consulted: a UI that waits for a round trip feels broken on a slow link.
   * A failure marks it `failed` rather than throwing it away, so it can be
   * retried instead of lost.
   */
  async sendText(
    conversationId: string,
    body: string,
    replyTo?: string,
  ): Promise<StoredMessage> {
    const message: StoredMessage = {
      id: this.newId(),
      conversationId,
      direction: "outgoing",
      body,
      timestamp: this.now(),
      status: "pending",
    };

    await this.store.appendMessage(message);
    this.events.onConversationChanged?.(conversationId);

    try {
      const envelopeId = await this.sendContent(conversationId, {
        type: "text",
        id: message.id,
        body,
        timestamp: message.timestamp,
        replyTo,
      });
      await this.store.setMessageStatus(
        conversationId,
        message.id,
        "sent",
        envelopeId,
      );
      return { ...message, status: "sent", envelopeId };
    } catch (error) {
      await this.store.setMessageStatus(conversationId, message.id, "failed");
      this.events.onError?.(error);
      return { ...message, status: "failed" };
    } finally {
      this.events.onConversationChanged?.(conversationId);
    }
  }

  /** Retries a message previously marked failed. */
  async retry(conversationId: string, messageId: string): Promise<void> {
    const message = (await this.store.listMessages(conversationId)).find(
      (m) => m.id === messageId,
    );
    if (!message || message.status !== "failed") return;

    await this.store.setMessageStatus(conversationId, messageId, "pending");
    this.events.onConversationChanged?.(conversationId);

    try {
      const envelopeId = await this.sendContent(conversationId, {
        type: "text",
        id: message.id,
        body: message.body,
        timestamp: message.timestamp,
      });
      await this.store.setMessageStatus(
        conversationId,
        messageId,
        "sent",
        envelopeId,
      );
    } catch (error) {
      await this.store.setMessageStatus(conversationId, messageId, "failed");
      this.events.onError?.(error);
    } finally {
      this.events.onConversationChanged?.(conversationId);
    }
  }

  /** Sends a file, chunked to fit the envelope cap. */
  async sendAttachment(
    conversationId: string,
    file: { name: string; mimeType: string; bytes: Uint8Array },
    caption?: string,
  ): Promise<StoredMessage> {
    const attachmentId = this.newId();
    const message: StoredMessage = {
      id: attachmentId,
      conversationId,
      direction: "outgoing",
      body: caption ?? "",
      timestamp: this.now(),
      status: "pending",
      attachment: {
        name: file.name,
        mimeType: file.mimeType,
        size: file.bytes.length,
        blobRef: attachmentId,
      },
    };

    await this.store.saveAttachment(attachmentId, file.bytes);
    await this.store.appendMessage(message);
    this.events.onConversationChanged?.(conversationId);

    try {
      const chunks = chunkAttachment({
        id: attachmentId,
        name: file.name,
        mimeType: file.mimeType,
        bytes: file.bytes,
        timestamp: message.timestamp,
        caption,
      });
      // Sequential: the ratchet is stateful, so parallel sends would race on
      // the sending chain.
      for (const chunk of chunks) {
        await this.sendContent(conversationId, chunk);
      }
      await this.store.setMessageStatus(conversationId, attachmentId, "sent");
      return { ...message, status: "sent" };
    } catch (error) {
      await this.store.setMessageStatus(conversationId, attachmentId, "failed");
      this.events.onError?.(error);
      return { ...message, status: "failed" };
    } finally {
      this.events.onConversationChanged?.(conversationId);
    }
  }

  /** Retracts a message for both sides. */
  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    const at = this.now();
    await this.store.markDeleted(conversationId, messageId, at);
    this.events.onConversationChanged?.(conversationId);

    await this.sendContent(conversationId, {
      type: "delete",
      targetId: messageId,
      timestamp: at,
    }).catch((error) => this.events.onError?.(error));
  }

  /** Replaces the body of a message already sent. */
  async editMessage(
    conversationId: string,
    messageId: string,
    body: string,
  ): Promise<void> {
    const at = this.now();
    await this.store.appendMessage({
      ...(await this.requireMessage(conversationId, messageId)),
      body,
    });
    this.events.onConversationChanged?.(conversationId);

    await this.sendContent(conversationId, {
      type: "edit",
      targetId: messageId,
      body,
      timestamp: at,
    }).catch((error) => this.events.onError?.(error));
  }

  /** Adds or removes an emoji reaction. */
  async react(
    conversationId: string,
    messageId: string,
    emoji: string,
    active = true,
  ): Promise<void> {
    await this.sendContent(conversationId, {
      type: "reaction",
      targetId: messageId,
      emoji,
      active,
      timestamp: this.now(),
    }).catch((error) => this.events.onError?.(error));
  }

  /** Signals that the user is composing. Safe to call repeatedly. */
  async sendTyping(conversationId: string): Promise<void> {
    await this.sendContent(conversationId, {
      type: "typing",
      ttlMs: TYPING_TTL_MS,
    }).catch((error) => this.events.onError?.(error));
  }

  /** Marks a conversation read locally and tells the peer. */
  async markRead(conversationId: string): Promise<void> {
    const unread = (await this.store.listMessages(conversationId))
      .filter((m) => m.direction === "incoming")
      .map((m) => m.id);

    await this.store.clearUnread(conversationId);
    this.events.onConversationsChanged?.();

    if (unread.length === 0) return;
    await this.sendContent(conversationId, {
      type: "receipt",
      kind: "read",
      messageIds: unread,
      timestamp: this.now(),
    }).catch((error) => this.events.onError?.(error));
  }

  private async requireMessage(
    conversationId: string,
    messageId: string,
  ): Promise<StoredMessage> {
    const message = (await this.store.listMessages(conversationId)).find(
      (m) => m.id === messageId,
    );
    if (!message) throw new ChatClientError(`unknown message ${messageId}`);
    return message;
  }

  // --- receiving ----------------------------------------------------------

  /**
   * Handles one inbound envelope.
   *
   * Errors are contained per envelope: one message that will not decrypt must
   * not wedge the conversation or stop the rest of a batch.
   */
  async handleEnvelope(envelope: DeliveredEnvelope): Promise<void> {
    const conversationId = envelope.senderId;

    try {
      const plaintext = await this.openEnvelope(conversationId, envelope);
      const content = decodeContent(plaintext);
      await this.applyContent(conversationId, content, envelope);
    } catch (error) {
      this.events.onError?.(error);
    }
  }

  private async openEnvelope(
    conversationId: string,
    envelope: DeliveredEnvelope,
  ): Promise<Uint8Array> {
    const existing =
      this.sessions.get(conversationId) ??
      (await this.store.loadSession(conversationId));

    if (existing) {
      const plaintext = await decrypt(existing, envelope.payload);
      this.sessions.set(conversationId, existing);
      await this.persistSession(conversationId);
      return plaintext;
    }

    // First contact: the payload must be a handshake.
    const stored = this.requireStored();
    const accepted = await acceptSession(
      this.requireIdentity(),
      new VaultPrekeyStore(this, stored),
      envelope.payload,
    );
    this.sessions.set(conversationId, accepted.session);
    await this.store.saveSession(conversationId, accepted.session);

    // A consumed prekey brings the pool closer to empty.
    void this.replenishPrekeys().catch((e) => this.events.onError?.(e));

    return accepted.plaintext;
  }

  private async applyContent(
    conversationId: string,
    content: MessageContent,
    envelope: DeliveredEnvelope,
  ): Promise<void> {
    switch (content.type) {
      case "text":
        await this.store.appendMessage({
          id: content.id,
          conversationId,
          direction: "incoming",
          body: content.body,
          timestamp: content.timestamp,
          status: "delivered",
          envelopeId: envelope.id,
        });
        await this.store.incrementUnread(conversationId);
        this.events.onConversationChanged?.(conversationId);
        this.events.onConversationsChanged?.();
        // Confirms arrival, not reading: the user may not have looked yet.
        await this.acknowledge(conversationId, [content.id], "delivered");
        break;

      case "receipt":
        for (const id of content.messageIds) {
          await this.store.setMessageStatus(
            conversationId,
            id,
            content.kind === "read" ? "read" : "delivered",
          );
        }
        this.events.onConversationChanged?.(conversationId);
        break;

      case "typing":
        this.events.onTyping?.(conversationId, this.now() + content.ttlMs);
        break;

      case "delete":
        await this.store.markDeleted(
          conversationId,
          content.targetId,
          content.timestamp,
        );
        this.events.onConversationChanged?.(conversationId);
        break;

      case "edit": {
        const target = (await this.store.listMessages(conversationId)).find(
          (m) => m.id === content.targetId,
        );
        if (target) {
          await this.store.appendMessage({ ...target, body: content.body });
          this.events.onConversationChanged?.(conversationId);
        }
        break;
      }

      case "reaction":
        // Reactions are surfaced as events; persisting them is future work and
        // dropping one is harmless, unlike dropping a message.
        this.events.onConversationChanged?.(conversationId);
        break;

      case "attachment":
        await this.applyAttachmentChunk(conversationId, content, envelope);
        break;

      case "unsupported":
        // A peer speaking a dialect this build does not know. Ignoring is the
        // whole point of decoding it to a value instead of throwing.
        break;
    }
  }

  private async applyAttachmentChunk(
    conversationId: string,
    chunk: AttachmentChunkContent,
    envelope: DeliveredEnvelope,
  ): Promise<void> {
    let assembler = this.assemblers.get(chunk.id);
    if (!assembler) {
      assembler = new AttachmentAssembler();
      this.assemblers.set(chunk.id, assembler);
    }

    const complete = assembler.add(chunk);
    if (!complete) {
      this.events.onConversationChanged?.(conversationId);
      return;
    }
    this.assemblers.delete(chunk.id);

    await this.store.saveAttachment(chunk.id, complete.bytes);
    await this.store.appendMessage({
      id: chunk.id,
      conversationId,
      direction: "incoming",
      body: complete.caption ?? "",
      timestamp: chunk.timestamp,
      status: "delivered",
      envelopeId: envelope.id,
      attachment: {
        name: complete.name,
        mimeType: complete.mimeType,
        size: complete.bytes.length,
        blobRef: chunk.id,
      },
    });
    await this.store.incrementUnread(conversationId);
    this.events.onConversationChanged?.(conversationId);
    this.events.onConversationsChanged?.();
    await this.acknowledge(conversationId, [chunk.id], "delivered");
  }

  /**
   * Sends a delivery receipt.
   *
   * Receipts never generate receipts of their own, or two clients would
   * acknowledge each other forever.
   */
  private async acknowledge(
    conversationId: string,
    messageIds: string[],
    kind: "delivered" | "read",
  ): Promise<void> {
    await this.sendContent(conversationId, {
      type: "receipt",
      kind,
      messageIds,
      timestamp: this.now(),
    }).catch((error) => this.events.onError?.(error));
  }

  // --- reads --------------------------------------------------------------

  async conversations(): Promise<Conversation[]> {
    return this.store.listConversations();
  }

  async messages(conversationId: string): Promise<StoredMessage[]> {
    return this.store.listMessages(conversationId);
  }

  async attachment(ref: string): Promise<Uint8Array | undefined> {
    return this.store.loadAttachment(ref);
  }

  /** Starts a conversation with a peer, verifying their bundle. */
  async startConversation(
    peerAccountId: string,
    displayName?: string,
  ): Promise<Conversation> {
    if (peerAccountId === this.accountId) {
      throw new ChatClientError("cannot start a conversation with yourself");
    }
    // Establishes the session eagerly so an unknown or unverifiable peer fails
    // here rather than when the user sends their first message.
    await this.sessionFor(peerAccountId);

    const conversation = await this.store.upsertConversation(peerAccountId, {
      displayName,
      lastActivity: this.now(),
    });
    this.events.onConversationsChanged?.();
    return conversation;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.sessions.delete(conversationId);
    await this.store.deleteConversation(conversationId);
    this.events.onConversationsChanged?.();
  }

  /** Closes the transport and forgets in-memory session state. */
  disconnect(): void {
    this.transport?.close();
    this.transport = undefined;
    this.sessions.clear();
    this.assemblers.clear();
  }
}
