import { describe, expect, it } from "vitest";

import {
  formatAccountId,
  formatBytes,
  formatDay,
  groupByDay,
  normalizeAccountId,
  previewOf,
  shortAccountId,
  statusLabel,
  statusSymbol,
} from "./format";
import type { StoredMessage } from "../store/types";

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m",
    conversationId: "c",
    direction: "outgoing",
    body: "hi",
    timestamp: 0,
    status: "sent",
    ...overrides,
  };
}

describe("account id formatting", () => {
  it("groups an id so a mismatch is visible", () => {
    const id = "A".repeat(43);
    const formatted = formatAccountId(id);

    // Ungrouped, 43 characters of base64url read as noise and "looks about
    // right" is how people accept the wrong key.
    expect(formatted).toContain(" ");
    expect(formatted.replace(/ /g, "")).toBe(id);
  });

  it("shortens an id without losing both ends", () => {
    const id = "abcdefghijklmnopqrstuvwxyz";
    const short = shortAccountId(id);

    // Both ends matter: truncating one side hides half of any difference.
    expect(short.startsWith("abcdef")).toBe(true);
    expect(short.endsWith("wxyz")).toBe(true);
  });

  it("leaves a short id alone", () => {
    expect(shortAccountId("abc")).toBe("abc");
  });
});

describe("normalizeAccountId", () => {
  const valid = "A".repeat(43);

  it("accepts a well-formed id", () => {
    expect(normalizeAccountId(valid)).toBe(valid);
  });

  it("strips the whitespace that copying brings along", () => {
    expect(normalizeAccountId(`  ${valid.slice(0, 20)} ${valid.slice(20)}\n`)).toBe(
      valid,
    );
  });

  it("rejects the wrong length", () => {
    expect(normalizeAccountId("A".repeat(42))).toBeUndefined();
    expect(normalizeAccountId("A".repeat(44))).toBeUndefined();
    expect(normalizeAccountId("")).toBeUndefined();
  });

  it("rejects characters outside the base64url alphabet", () => {
    // Catching this here turns a confusing network error into a clear one.
    expect(normalizeAccountId("!".repeat(43))).toBeUndefined();
    expect(normalizeAccountId(`${"A".repeat(42)}+`)).toBeUndefined();
  });

  it("accepts the full base64url alphabet", () => {
    const id = `${"-_".repeat(21)}A`;
    expect(normalizeAccountId(id)).toBe(id);
  });
});

describe("day grouping", () => {
  const now = new Date("2026-08-27T12:00:00Z").getTime();
  const hour = 3600_000;

  it("labels today and yesterday", () => {
    expect(formatDay(now, now, "en-GB")).toBe("Today");
    expect(formatDay(now - 24 * hour, now, "en-GB")).toBe("Yesterday");
  });

  it("labels older days with a date", () => {
    const label = formatDay(now - 5 * 24 * hour, now, "en-GB");
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
  });

  it("groups consecutive messages under one heading", () => {
    const groups = groupByDay(
      [
        message({ id: "a", timestamp: now - 24 * hour }),
        message({ id: "b", timestamp: now - 24 * hour + 60_000 }),
        message({ id: "c", timestamp: now }),
      ],
      now,
      "en-GB",
    );

    expect(groups).toHaveLength(2);
    expect(groups[0].messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(groups[1].messages.map((m) => m.id)).toEqual(["c"]);
  });

  it("preserves order within a group", () => {
    const groups = groupByDay(
      [
        message({ id: "a", timestamp: now }),
        message({ id: "b", timestamp: now + 1 }),
      ],
      now,
    );
    expect(groups[0].messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("handles an empty history", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});

describe("status display", () => {
  it("distinguishes every status", () => {
    const symbols = (
      ["pending", "sent", "delivered", "read", "failed"] as const
    ).map(statusSymbol);

    // Read and delivered deliberately share a glyph and differ by colour, so
    // the set is smaller than the list; the rest must be distinct.
    expect(new Set(symbols).size).toBeGreaterThanOrEqual(4);
  });

  it("gives every status readable text", () => {
    for (const status of [
      "pending",
      "sent",
      "delivered",
      "read",
      "failed",
    ] as const) {
      // The glyphs convey nothing to a screen reader on their own.
      expect(statusLabel(status).length).toBeGreaterThan(2);
    }
  });

  it("tells the user a failure is actionable", () => {
    expect(statusLabel("failed")).toMatch(/retry/i);
  });
});

describe("previews", () => {
  it("summarises an empty conversation", () => {
    expect(previewOf(undefined)).toBe("No messages yet");
  });

  it("shows a retraction rather than an empty line", () => {
    expect(previewOf(message({ body: "", deletedAt: 1 }))).toBe(
      "Message deleted",
    );
  });

  it("names an attachment when there is no caption", () => {
    const preview = previewOf(
      message({
        body: "",
        attachment: {
          name: "photo.png",
          mimeType: "image/png",
          size: 10,
          blobRef: "r",
        },
      }),
    );
    expect(preview).toContain("photo.png");
  });

  it("prefers a caption over the file name", () => {
    const preview = previewOf(
      message({
        body: "look at this",
        attachment: {
          name: "photo.png",
          mimeType: "image/png",
          size: 10,
          blobRef: "r",
        },
      }),
    );
    expect(preview).toBe("look at this");
  });
});

describe("formatBytes", () => {
  it("scales the unit to the size", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
