/**
 * End-to-end message content.
 *
 * Everything a chat does beyond plain text - receipts, typing, edits,
 * deletions, reactions, attachments - is a content type *inside* the
 * ciphertext, never a server feature. The server must not learn that a receipt
 * is a receipt, so none of this appears in any API.
 *
 * Content is JSON: it is already sealed by the ratchet, so the only cost of a
 * readable format is a few bytes, and the clarity is worth more than that.
 */

export const CONTENT_VERSION = 1;

/** Envelope payloads are capped at 64 KiB (protocol §9); chunks stay well under. */
export const MAX_CHUNK_BYTES = 32 * 1024;

export class ContentError extends Error {}

export interface TextContent {
  type: "text";
  id: string;
  body: string;
  timestamp: number;
  /** Set when this message is a reply to another. */
  replyTo?: string;
}

export interface ReceiptContent {
  type: "receipt";
  kind: "delivered" | "read";
  messageIds: string[];
  timestamp: number;
}

export interface TypingContent {
  type: "typing";
  /**
   * When the indicator stops being true, as a duration in milliseconds from
   * receipt. An absolute timestamp would depend on two devices agreeing about
   * the clock, which they do not.
   */
  ttlMs: number;
}

export interface DeleteContent {
  type: "delete";
  targetId: string;
  timestamp: number;
}

export interface EditContent {
  type: "edit";
  targetId: string;
  body: string;
  timestamp: number;
}

export interface ReactionContent {
  type: "reaction";
  targetId: string;
  emoji: string;
  /** False retracts a previously sent reaction. */
  active: boolean;
  timestamp: number;
}

export interface AttachmentChunkContent {
  type: "attachment";
  /** Groups the chunks of one file. */
  id: string;
  name: string;
  mimeType: string;
  /** Total size of the assembled file, for progress and validation. */
  size: number;
  chunkIndex: number;
  chunkCount: number;
  /** base64 of this chunk's bytes. */
  data: string;
  timestamp: number;
  /** Present on the final chunk only; a caption for the file. */
  caption?: string;
}

/** Announces a group and its initial membership to each member. */
export interface GroupCreateContent {
  type: "group-create";
  groupId: string;
  name: string;
  members: string[];
  timestamp: number;
}

/**
 * A membership or name change.
 *
 * Carries the whole change rather than a delta from a sequence number: there
 * is no server to order changes, so each must stand on its own.
 */
export interface GroupUpdateContent {
  type: "group-update";
  groupId: string;
  name?: string;
  addMembers?: string[];
  removeMembers?: string[];
  timestamp: number;
}

/** A message addressed to a group rather than to one peer. */
export interface GroupTextContent {
  type: "group-text";
  groupId: string;
  id: string;
  body: string;
  timestamp: number;
  replyTo?: string;
}

/**
 * A content type this client does not understand.
 *
 * Decoding to this rather than throwing means a newer peer cannot break an
 * older client simply by sending something it has not heard of.
 */
export interface UnsupportedContent {
  type: "unsupported";
  originalType: string;
}

export type MessageContent =
  | TextContent
  | ReceiptContent
  | TypingContent
  | DeleteContent
  | EditContent
  | ReactionContent
  | AttachmentChunkContent
  | GroupCreateContent
  | GroupUpdateContent
  | GroupTextContent
  | UnsupportedContent;

interface Framed {
  v: number;
  c: MessageContent;
}

const KNOWN_TYPES = new Set([
  "text",
  "receipt",
  "typing",
  "delete",
  "edit",
  "reaction",
  "attachment",
  "group-create",
  "group-update",
  "group-text",
]);

/** Serialises content for the ratchet to seal. */
export function encodeContent(content: MessageContent): Uint8Array {
  if (content.type === "unsupported") {
    throw new ContentError("cannot encode unsupported content");
  }
  const framed: Framed = { v: CONTENT_VERSION, c: content };
  return new TextEncoder().encode(JSON.stringify(framed));
}

/**
 * Parses decrypted content.
 *
 * Throws only on input that is not parseable at all. A recognised frame
 * carrying an unknown type yields `unsupported`, since refusing it would let a
 * newer peer break this client.
 */
export function decodeContent(bytes: Uint8Array): MessageContent {
  let framed: Framed;
  try {
    framed = JSON.parse(new TextDecoder().decode(bytes)) as Framed;
  } catch {
    throw new ContentError("content is not valid JSON");
  }

  if (!framed || typeof framed !== "object" || typeof framed.v !== "number") {
    throw new ContentError("content frame is malformed");
  }
  if (framed.v !== CONTENT_VERSION) {
    // A version bump is a peer speaking a dialect this build does not know;
    // that is the same situation as an unknown type, not a corrupt message.
    return { type: "unsupported", originalType: `v${framed.v}` };
  }

  const content = framed.c;
  if (!content || typeof content !== "object" || typeof content.type !== "string") {
    throw new ContentError("content body is malformed");
  }
  if (!KNOWN_TYPES.has(content.type)) {
    return { type: "unsupported", originalType: content.type };
  }

  validate(content);
  return content;
}

/**
 * Rejects a frame of a known type with the wrong shape.
 *
 * A peer that omits `targetId` on a deletion is not forward compatibility, it
 * is a bug or an attack; letting it through would mean acting on undefined.
 */
function validate(content: MessageContent): void {
  const require = (ok: boolean, field: string) => {
    if (!ok) throw new ContentError(`${content.type}: invalid ${field}`);
  };

  switch (content.type) {
    case "text":
      require(typeof content.id === "string" && content.id.length > 0, "id");
      require(typeof content.body === "string", "body");
      require(Number.isFinite(content.timestamp), "timestamp");
      break;

    case "receipt":
      require(
        content.kind === "delivered" || content.kind === "read",
        "kind",
      );
      require(
        Array.isArray(content.messageIds) && content.messageIds.length > 0,
        "messageIds",
      );
      break;

    case "typing":
      require(
        Number.isFinite(content.ttlMs) && content.ttlMs > 0,
        "ttlMs",
      );
      break;

    case "delete":
      require(typeof content.targetId === "string", "targetId");
      break;

    case "edit":
      require(typeof content.targetId === "string", "targetId");
      require(typeof content.body === "string", "body");
      break;

    case "reaction":
      require(typeof content.targetId === "string", "targetId");
      require(typeof content.emoji === "string" && content.emoji.length > 0, "emoji");
      require(typeof content.active === "boolean", "active");
      break;

    case "attachment":
      require(typeof content.id === "string" && content.id.length > 0, "id");
      require(Number.isInteger(content.chunkCount) && content.chunkCount > 0, "chunkCount");
      require(
        Number.isInteger(content.chunkIndex) &&
          content.chunkIndex >= 0 &&
          content.chunkIndex < content.chunkCount,
        "chunkIndex",
      );
      require(typeof content.data === "string", "data");
      require(Number.isInteger(content.size) && content.size >= 0, "size");
      break;

    case "group-create":
      require(typeof content.groupId === "string" && content.groupId.length > 0, "groupId");
      require(typeof content.name === "string", "name");
      require(Array.isArray(content.members), "members");
      break;

    case "group-update":
      require(typeof content.groupId === "string" && content.groupId.length > 0, "groupId");
      require(Number.isFinite(content.timestamp), "timestamp");
      require(
        content.name !== undefined ||
          (content.addMembers?.length ?? 0) > 0 ||
          (content.removeMembers?.length ?? 0) > 0,
        "change",
      );
      break;

    case "group-text":
      require(typeof content.groupId === "string" && content.groupId.length > 0, "groupId");
      require(typeof content.id === "string" && content.id.length > 0, "id");
      require(typeof content.body === "string", "body");
      require(Number.isFinite(content.timestamp), "timestamp");
      break;

    default:
      break;
  }
}

// --- attachments ----------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface AttachmentInput {
  id: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  timestamp: number;
  caption?: string;
}

/**
 * Splits a file into chunks that fit an envelope.
 *
 * Each chunk repeats the file metadata so a receiver that missed the first one
 * can still make sense of what is arriving, and carries its index and the
 * total so reassembly works out of order.
 */
export function chunkAttachment(input: AttachmentInput): AttachmentChunkContent[] {
  const total = Math.max(1, Math.ceil(input.bytes.length / MAX_CHUNK_BYTES));
  const chunks: AttachmentChunkContent[] = [];

  for (let i = 0; i < total; i++) {
    const slice = input.bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
    chunks.push({
      type: "attachment",
      id: input.id,
      name: input.name,
      mimeType: input.mimeType,
      size: input.bytes.length,
      chunkIndex: i,
      chunkCount: total,
      data: toBase64(slice),
      timestamp: input.timestamp,
      // The caption rides on the last chunk, so it appears when the file is
      // complete rather than beside a partial download.
      caption: i === total - 1 ? input.caption : undefined,
    });
  }
  return chunks;
}

/** Accumulates chunks of one file until it is whole. */
export class AttachmentAssembler {
  private readonly parts = new Map<number, Uint8Array>();
  private meta?: AttachmentChunkContent;

  /** Adds a chunk; returns the file once every piece has arrived. */
  add(chunk: AttachmentChunkContent):
    | { name: string; mimeType: string; bytes: Uint8Array; caption?: string }
    | undefined {
    if (this.meta && this.meta.id !== chunk.id) {
      throw new ContentError("chunk belongs to a different attachment");
    }
    if (this.meta && this.meta.chunkCount !== chunk.chunkCount) {
      // Disagreement about the total means one side is confused; assembling
      // anyway would produce a file that is quietly wrong.
      throw new ContentError("chunk count changed mid-transfer");
    }
    this.meta ??= chunk;
    if (chunk.caption !== undefined) this.meta = { ...this.meta, caption: chunk.caption };

    this.parts.set(chunk.chunkIndex, fromBase64(chunk.data));
    if (this.parts.size !== chunk.chunkCount) return undefined;

    const ordered: Uint8Array[] = [];
    for (let i = 0; i < chunk.chunkCount; i++) {
      const part = this.parts.get(i);
      // Unreachable while size equals count, but a silent truncation here
      // would be indistinguishable from a successful transfer.
      if (!part) throw new ContentError(`missing chunk ${i}`);
      ordered.push(part);
    }

    const total = ordered.reduce((sum, p) => sum + p.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of ordered) {
      bytes.set(part, offset);
      offset += part.length;
    }

    if (bytes.length !== this.meta.size) {
      throw new ContentError(
        `assembled ${bytes.length} bytes, expected ${this.meta.size}`,
      );
    }

    return {
      name: this.meta.name,
      mimeType: this.meta.mimeType,
      bytes,
      caption: this.meta.caption,
    };
  }

  /** How much of the file has arrived, for progress display. */
  get progress(): { received: number; total: number } {
    return {
      received: this.parts.size,
      total: this.meta?.chunkCount ?? 0,
    };
  }
}
