import { describe, expect, it } from "vitest";

import {
  highlightParts,
  searchConversations,
  searchMessages,
} from "./search";
import type { Conversation, StoredMessage } from "../store/types";

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m",
    conversationId: "c",
    direction: "incoming",
    body: "hello",
    timestamp: 1000,
    status: "delivered",
    ...overrides,
  };
}

describe("searchMessages", () => {
  const history = [
    message({ id: "a", body: "Meet me at the café", timestamp: 1 }),
    message({ id: "b", body: "CAFETERIA is closed", timestamp: 2 }),
    message({ id: "c", body: "nothing relevant", timestamp: 3 }),
  ];

  it("matches regardless of case", () => {
    expect(searchMessages(history, "MEET").map((h) => h.message.id)).toEqual([
      "a",
    ]);
  });

  it("matches regardless of accents", () => {
    // Someone typing quickly on a phone keyboard will not reach for the
    // accented character.
    expect(searchMessages(history, "cafe").map((h) => h.message.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("returns the most recent match first", () => {
    // In a long conversation the recent match is almost always the one being
    // looked for.
    expect(searchMessages(history, "e").map((h) => h.message.id)[0]).toBe("c");
  });

  it("reports where the match starts", () => {
    const [hit] = searchMessages(history, "me at");
    expect(hit.message.body.slice(hit.index)).toContain("me at");
  });

  it("skips a deleted message even if a body survives on it", () => {
    // markDeleted clears the body today, so a tombstone cannot match anything
    // anyway. The guard exists so that a future tombstone which keeps its text
    // does not quietly become searchable; testing it needs a message the
    // current code would not produce.
    const withBody = [
      message({ id: "z", body: "the deleted secret", deletedAt: 5, timestamp: 9 }),
    ];
    expect(searchMessages(withBody, "secret")).toEqual([]);
  });

  it("skips deleted messages", () => {
    const withTombstone = [
      ...history,
      message({ id: "d", body: "", deletedAt: 5, timestamp: 9 }),
    ];
    // A tombstone has no body, so a hit on one is a result nobody can open.
    // Note "café" would also match "CAFETERIA" once accents are stripped, so
    // this uses a query that only the intended message contains.
    expect(searchMessages(withTombstone, "").map((h) => h.message.id)).toEqual(
      [],
    );
    expect(
      searchMessages(withTombstone, "meet me").map((h) => h.message.id),
    ).toEqual(["a"]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchMessages(history, "   ")).toEqual([]);
  });

  it("handles a query that matches nothing", () => {
    expect(searchMessages(history, "zzzz")).toEqual([]);
  });
});

describe("searchConversations", () => {
  const conversations: Conversation[] = [
    { id: "aaaa1111", displayName: "Alice", lastActivity: 1, unreadCount: 0 },
    { id: "bbbb2222", lastActivity: 2, unreadCount: 0 },
  ];

  it("matches on display name", () => {
    expect(searchConversations(conversations, "ali").map((c) => c.id)).toEqual([
      "aaaa1111",
    ]);
  });

  it("matches on account id", () => {
    // A conversation with no name is only ever identified by its id.
    expect(searchConversations(conversations, "bbbb").map((c) => c.id)).toEqual(
      ["bbbb2222"],
    );
  });

  it("returns everything for an empty query", () => {
    expect(searchConversations(conversations, "")).toHaveLength(2);
  });
});

describe("highlightParts", () => {
  it("splits around every match", () => {
    const parts = highlightParts("one two one", "one");
    expect(parts.map((p) => p.text).join("")).toBe("one two one");
    expect(parts.filter((p) => p.match)).toHaveLength(2);
  });

  it("preserves the original case and accents in the output", () => {
    const parts = highlightParts("Café time", "cafe");
    // Matching is normalised; rendering must not be, or the highlight rewrites
    // the user's own message.
    expect(parts.map((p) => p.text).join("")).toBe("Café time");
    expect(parts.find((p) => p.match)?.text).toBe("Café");
  });

  it("returns the whole body when there is no query", () => {
    expect(highlightParts("hello", "")).toEqual([
      { text: "hello", match: false },
    ]);
  });

  it("returns the whole body when nothing matches", () => {
    const parts = highlightParts("hello", "zzz");
    expect(parts.map((p) => p.text).join("")).toBe("hello");
    expect(parts.some((p) => p.match)).toBe(false);
  });
});
