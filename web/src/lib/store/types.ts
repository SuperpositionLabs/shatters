/** Durable chat model. Everything here is written through the vault. */

/**
 * Lifecycle of an outgoing message.
 *
 * `pending` exists so a message appears the instant it is composed rather than
 * after a round trip; the UI has something real to show while the network is
 * slow or absent.
 */
export type MessageStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type MessageDirection = "outgoing" | "incoming";

export interface StoredMessage {
  /** Locally generated, so a message is trackable before the server sees it. */
  id: string;
  conversationId: string;
  direction: MessageDirection;
  body: string;
  /** Milliseconds since the epoch, from the composing device's clock. */
  timestamp: number;
  status: MessageStatus;
  /** Server envelope id, once known. Lets a receipt find its message. */
  envelopeId?: string;
  /** Attachment metadata, when the message carries one. */
  attachment?: StoredAttachment;
  /** Set when the sender has since retracted this message. */
  deletedAt?: number;
  /**
   * Who sent it, for group conversations.
   *
   * Absent in a direct chat, where the conversation id already identifies the
   * other party.
   */
  senderId?: string;
}

export interface StoredAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Vault record name holding the decrypted bytes. */
  blobRef: string;
}

export interface Conversation {
  /** The peer's opaque account id, which is also the conversation key. */
  id: string;
  /** Local-only label. Never uploaded: the server must not learn a contact graph. */
  displayName?: string;
  lastActivity: number;
  unreadCount: number;
  /** Set when the peer is currently composing; not persisted. */
  typingUntil?: number;
  /** True when this conversation is a group rather than a direct chat. */
  isGroup?: boolean;
}
