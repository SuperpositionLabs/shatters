import { describe, expect, it } from "vitest";

import {
  AttachmentAssembler,
  CONTENT_VERSION,
  ContentError,
  MAX_CHUNK_BYTES,
  type MessageContent,
  chunkAttachment,
  decodeContent,
  encodeContent,
} from "./content";

function roundTrip(content: MessageContent): MessageContent {
  return decodeContent(encodeContent(content));
}

describe("content encoding", () => {
  it("round-trips a text message", () => {
    const content: MessageContent = {
      type: "text",
      id: "m1",
      body: "hello there",
      timestamp: 1000,
      replyTo: "m0",
    };
    expect(roundTrip(content)).toEqual(content);
  });

  it("round-trips a receipt", () => {
    const content: MessageContent = {
      type: "receipt",
      kind: "read",
      messageIds: ["m1", "m2"],
      timestamp: 1000,
    };
    expect(roundTrip(content)).toEqual(content);
  });

  it("round-trips a typing indicator", () => {
    const content: MessageContent = { type: "typing", ttlMs: 5000 };
    expect(roundTrip(content)).toEqual(content);
  });

  it("round-trips deletions, edits and reactions", () => {
    const cases: MessageContent[] = [
      { type: "delete", targetId: "m1", timestamp: 1 },
      { type: "edit", targetId: "m1", body: "fixed", timestamp: 2 },
      {
        type: "reaction",
        targetId: "m1",
        emoji: "👍",
        active: true,
        timestamp: 3,
      },
    ];
    for (const content of cases) {
      expect(roundTrip(content)).toEqual(content);
    }
  });

  it("preserves non-ASCII bodies", () => {
    const content: MessageContent = {
      type: "text",
      id: "m1",
      body: "olá — 日本語 — 🎉",
      timestamp: 1,
    };
    expect(roundTrip(content)).toEqual(content);
  });

  it("treats an unknown type as unsupported rather than failing", () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({ v: CONTENT_VERSION, c: { type: "hologram" } }),
    );

    // A newer peer must not be able to break an older client.
    expect(decodeContent(raw)).toEqual({
      type: "unsupported",
      originalType: "hologram",
    });
  });

  it("treats a newer version as unsupported rather than failing", () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({ v: 99, c: { type: "text" } }),
    );

    expect(decodeContent(raw)).toEqual({
      type: "unsupported",
      originalType: "v99",
    });
  });

  it("refuses to encode unsupported content", () => {
    expect(() =>
      encodeContent({ type: "unsupported", originalType: "x" }),
    ).toThrow(ContentError);
  });

  it("rejects input that is not parseable", () => {
    expect(() => decodeContent(new TextEncoder().encode("nonsense"))).toThrow(
      /not valid JSON/,
    );
    expect(() => decodeContent(new TextEncoder().encode("[]"))).toThrow(
      /malformed/,
    );
  });

  it("rejects a known type with a missing field", () => {
    // Forward compatibility covers unknown types, not known ones that are
    // wrong. Acting on an undefined targetId would delete nothing, or worse.
    const cases: unknown[] = [
      { type: "delete" },
      { type: "text", id: "", body: "x", timestamp: 1 },
      { type: "text", id: "m", body: "x", timestamp: "soon" },
      { type: "receipt", kind: "seen", messageIds: ["m"] },
      { type: "receipt", kind: "read", messageIds: [] },
      { type: "typing", ttlMs: 0 },
      { type: "reaction", targetId: "m", emoji: "", active: true },
      { type: "reaction", targetId: "m", emoji: "x", active: "yes" },
    ];

    for (const c of cases) {
      const raw = new TextEncoder().encode(
        JSON.stringify({ v: CONTENT_VERSION, c }),
      );
      expect(() => decodeContent(raw), JSON.stringify(c)).toThrow(ContentError);
    }
  });
});

describe("attachments", () => {
  const file = (size: number) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    return bytes;
  };

  it("round-trips a small file in one chunk", () => {
    const bytes = file(100);
    const chunks = chunkAttachment({
      id: "a1",
      name: "note.txt",
      mimeType: "text/plain",
      bytes,
      timestamp: 1,
    });

    expect(chunks).toHaveLength(1);
    const assembler = new AttachmentAssembler();
    const done = assembler.add(chunks[0]);

    expect(done?.bytes).toEqual(bytes);
    expect(done?.name).toBe("note.txt");
  });

  it("chunks a file larger than one envelope", () => {
    const bytes = file(MAX_CHUNK_BYTES * 3 + 17);
    const chunks = chunkAttachment({
      id: "a1",
      name: "big.bin",
      mimeType: "application/octet-stream",
      bytes,
      timestamp: 1,
    });

    expect(chunks).toHaveLength(4);
    // Every chunk must survive an envelope, so none may exceed the cap.
    for (const chunk of chunks) {
      expect(encodeContent(chunk).length).toBeLessThan(64 * 1024);
    }

    const assembler = new AttachmentAssembler();
    let done;
    for (const chunk of chunks) done = assembler.add(chunk);
    expect(done?.bytes).toEqual(bytes);
  });

  it("reassembles chunks arriving out of order", () => {
    const bytes = file(MAX_CHUNK_BYTES * 2 + 5);
    const chunks = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "application/octet-stream",
      bytes,
      timestamp: 1,
    });

    const assembler = new AttachmentAssembler();
    // Delivery order is not guaranteed, so reversal must work.
    const reversed = [...chunks].reverse();
    let done;
    for (const chunk of reversed) done = assembler.add(chunk);

    expect(done?.bytes).toEqual(bytes);
  });

  it("reports progress and stays incomplete until the last chunk", () => {
    const bytes = file(MAX_CHUNK_BYTES * 3);
    const chunks = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "x",
      bytes,
      timestamp: 1,
    });

    const assembler = new AttachmentAssembler();
    expect(assembler.add(chunks[0])).toBeUndefined();
    expect(assembler.progress).toEqual({ received: 1, total: 3 });
    expect(assembler.add(chunks[1])).toBeUndefined();
    expect(assembler.add(chunks[2])).toBeDefined();
  });

  it("carries the caption on the final chunk", () => {
    const chunks = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "x",
      bytes: file(MAX_CHUNK_BYTES + 1),
      timestamp: 1,
      caption: "look at this",
    });

    // Shown when the file is whole, not beside a partial download.
    expect(chunks[0].caption).toBeUndefined();
    expect(chunks[1].caption).toBe("look at this");

    const assembler = new AttachmentAssembler();
    assembler.add(chunks[0]);
    expect(assembler.add(chunks[1])?.caption).toBe("look at this");
  });

  it("rejects chunks from a different attachment", () => {
    const a = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "x",
      bytes: file(10),
      timestamp: 1,
    })[0];
    const b = chunkAttachment({
      id: "a2",
      name: "g",
      mimeType: "x",
      bytes: file(10),
      timestamp: 1,
    })[0];

    const assembler = new AttachmentAssembler();
    assembler.add(a);
    expect(() => assembler.add(b)).toThrow(/different attachment/);
  });

  it("rejects a changing chunk count", () => {
    const chunks = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "x",
      bytes: file(MAX_CHUNK_BYTES * 2),
      timestamp: 1,
    });

    const assembler = new AttachmentAssembler();
    assembler.add(chunks[0]);

    // Assembling despite disagreement would produce a quietly wrong file.
    expect(() => assembler.add({ ...chunks[1], chunkCount: 5 })).toThrow(
      /chunk count changed/,
    );
  });

  it("detects a size mismatch rather than yielding a truncated file", () => {
    const chunks = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "x",
      bytes: file(100),
      timestamp: 1,
    });

    const assembler = new AttachmentAssembler();
    // A truncated file that reports success is worse than a failed transfer.
    expect(() => assembler.add({ ...chunks[0], size: 999 })).toThrow(
      /expected 999/,
    );
  });

  it("rejects an out-of-range chunk index on decode", () => {
    const chunk = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "x",
      bytes: file(10),
      timestamp: 1,
    })[0];

    const raw = new TextEncoder().encode(
      JSON.stringify({
        v: CONTENT_VERSION,
        c: { ...chunk, chunkIndex: 7, chunkCount: 2 },
      }),
    );
    expect(() => decodeContent(raw)).toThrow(/chunkIndex/);
  });

  it("handles an empty file without dividing by zero", () => {
    const chunks = chunkAttachment({
      id: "a1",
      name: "empty",
      mimeType: "x",
      bytes: new Uint8Array(0),
      timestamp: 1,
    });

    expect(chunks).toHaveLength(1);
    expect(new AttachmentAssembler().add(chunks[0])?.bytes).toEqual(
      new Uint8Array(0),
    );
  });

  it("round-trips chunks through the wire format", () => {
    const bytes = file(MAX_CHUNK_BYTES + 500);
    const chunks = chunkAttachment({
      id: "a1",
      name: "f",
      mimeType: "image/png",
      bytes,
      timestamp: 1,
    });

    // The real path is encode -> ratchet -> decode, so assemble from decoded
    // chunks rather than the originals.
    const assembler = new AttachmentAssembler();
    let done;
    for (const chunk of chunks) {
      const decoded = decodeContent(encodeContent(chunk));
      if (decoded.type !== "attachment") throw new Error("wrong type");
      done = assembler.add(decoded);
    }
    expect(done?.bytes).toEqual(bytes);
    expect(done?.mimeType).toBe("image/png");
  });
});
