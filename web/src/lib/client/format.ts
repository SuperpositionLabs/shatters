/**
 * Presentation helpers.
 *
 * Pure functions, kept out of the components so they can be tested without a
 * DOM and reasoned about on their own.
 */
import type { MessageStatus, StoredMessage } from "../store/types";

/**
 * Splits an account id into readable groups.
 *
 * A 43-character base64url string is impossible to compare at a glance, and
 * "looks about right" is how people accept the wrong key. Grouping makes a
 * mismatch visible rather than plausible.
 */
export function formatAccountId(id: string, groupSize = 7): string {
  const groups: string[] = [];
  for (let i = 0; i < id.length; i += groupSize) {
    groups.push(id.slice(i, i + groupSize));
  }
  return groups.join(" ");
}

/** A short, stable label for a conversation with no name set. */
export function shortAccountId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** Clock time for a message, in the viewer's locale. */
export function formatTime(timestamp: number, locale?: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Day heading for a run of messages. */
export function formatDay(timestamp: number, now: number, locale?: string): string {
  const date = new Date(timestamp);
  const today = new Date(now);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";

  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** Groups messages under day headings, preserving order. */
export function groupByDay(
  messages: StoredMessage[],
  now: number,
  locale?: string,
): { day: string; messages: StoredMessage[] }[] {
  const groups: { day: string; messages: StoredMessage[] }[] = [];

  for (const message of messages) {
    const day = formatDay(message.timestamp, now, locale);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.messages.push(message);
    else groups.push({ day, messages: [message] });
  }
  return groups;
}

/** Symbol shown beside an outgoing message. */
export function statusSymbol(status: MessageStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "sent":
      return "✓";
    case "delivered":
      return "✓✓";
    case "read":
      return "✓✓";
    case "failed":
      return "!";
  }
}

/** Screen-reader text for a status, since the symbols alone are not readable. */
export function statusLabel(status: MessageStatus): string {
  switch (status) {
    case "pending":
      return "Sending";
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "read":
      return "Read";
    case "failed":
      return "Failed to send — select to retry";
  }
}

/** Human-readable file size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One-line summary of a conversation for the list. */
export function previewOf(message: StoredMessage | undefined): string {
  if (!message) return "No messages yet";
  if (message.deletedAt) return "Message deleted";
  if (message.attachment) {
    return message.body || `📎 ${message.attachment.name}`;
  }
  return message.body;
}

/**
 * Validates a pasted account id before it is used.
 *
 * Catching a malformed id here turns a confusing network error into a clear
 * one, and rejects the whitespace that copying inevitably brings along.
 */
export function normalizeAccountId(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (trimmed.length !== 43) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}
