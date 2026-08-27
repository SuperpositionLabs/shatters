/**
 * Client-side search over decrypted history.
 *
 * Deliberately a filter and nothing else. An index would have to live
 * somewhere, and an unencrypted index of message text would undo the vault
 * entirely — the plaintext an attacker wants is exactly what an index holds.
 * Filtering in memory is slower and gives that away for free.
 */
import type { Conversation, StoredMessage } from "../store/types";

export interface SearchHit {
  message: StoredMessage;
  /** Where the match starts in the body, for highlighting. */
  index: number;
}

/** Case-insensitive, accent-insensitive containment. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    // Strip combining marks so "cafe" finds "café", which is what someone
    // typing quickly on a phone keyboard expects.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Finds messages whose body contains the query.
 *
 * Deleted messages are skipped: their body is gone, and surfacing a tombstone
 * as a search hit would be a result the user cannot open.
 */
export function searchMessages(
  messages: StoredMessage[],
  query: string,
): SearchHit[] {
  const needle = normalize(query.trim());
  if (!needle) return [];

  const hits: SearchHit[] = [];
  for (const message of messages) {
    if (message.deletedAt) continue;

    const index = normalize(message.body).indexOf(needle);
    if (index !== -1) hits.push({ message, index });
  }

  // Most recent first: in a long conversation the recent match is almost
  // always the one being looked for.
  return hits.sort((a, b) => b.message.timestamp - a.message.timestamp);
}

/**
 * Filters a conversation list by name or account id.
 *
 * Matching the id as well as the name matters because a conversation with no
 * name set is only ever identified by its id.
 */
export function searchConversations(
  conversations: Conversation[],
  query: string,
): Conversation[] {
  const needle = normalize(query.trim());
  if (!needle) return conversations;

  return conversations.filter(
    (conversation) =>
      normalize(conversation.displayName ?? "").includes(needle) ||
      normalize(conversation.id).includes(needle),
  );
}

/** Splits a body around a match, for rendering without dangerouslySetInnerHTML. */
export function highlightParts(
  body: string,
  query: string,
): { text: string; match: boolean }[] {
  const needle = normalize(query.trim());
  if (!needle) return [{ text: body, match: false }];

  const haystack = normalize(body);
  const parts: { text: string; match: boolean }[] = [];

  let cursor = 0;
  for (;;) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;

    if (index > cursor) {
      parts.push({ text: body.slice(cursor, index), match: false });
    }
    // Sliced from the original, so the rendered text keeps its original case
    // and accents rather than the normalised form used for matching.
    parts.push({ text: body.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }

  if (cursor < body.length) {
    parts.push({ text: body.slice(cursor), match: false });
  }
  return parts;
}
