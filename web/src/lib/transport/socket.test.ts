import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient, QueuedEnvelope } from "./api";
import {
  type DeliveredEnvelope,
  type SocketLike,
  type TransportStatus,
  Transport,
} from "./socket";

/** A controllable stand-in for a browser WebSocket. */
class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  /** Simulates the server completing the handshake. */
  async ready(): Promise<void> {
    await this.deliver({ type: "ready" });
  }

  async deliver(message: unknown): Promise<void> {
    this.onmessage?.({ data: JSON.stringify(message) });
    // Handlers are async; let their microtasks settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  get authFrame(): { type: string; token: string } | undefined {
    const raw = this.sent.find((s) => s.includes('"auth"'));
    return raw ? JSON.parse(raw) : undefined;
  }
}

/** A minimal ApiClient stand-in. */
function fakeApi(overrides: Partial<ApiClient> = {}) {
  return {
    sessionToken: "tok",
    fetchEnvelopes: vi.fn(async (): Promise<QueuedEnvelope[]> => []),
    acknowledge: vi.fn(async () => 1),
    ...overrides,
  } as unknown as ApiClient & {
    fetchEnvelopes: ReturnType<typeof vi.fn>;
    acknowledge: ReturnType<typeof vi.fn>;
  };
}

function envelope(id: string): QueuedEnvelope {
  return {
    id,
    senderId: "sender",
    payload: new Uint8Array([1, 2, 3]),
    createdAt: "2026-08-27T00:00:00Z",
  };
}

function base64Envelope(id: string) {
  return {
    type: "envelope",
    id,
    sender_id: "sender",
    payload: btoa("\x01\x02\x03"),
    created_at: "2026-08-27T00:00:00Z",
  };
}

interface Harness {
  transport: Transport;
  sockets: FakeSocket[];
  received: DeliveredEnvelope[];
  statuses: TransportStatus[];
  errors: unknown[];
  timers: { fn: () => void; ms: number }[];
  runTimers: () => void;
}

function harness(
  api: ReturnType<typeof fakeApi>,
  onEnvelope?: (e: DeliveredEnvelope) => Promise<void> | void,
): Harness {
  const sockets: FakeSocket[] = [];
  const received: DeliveredEnvelope[] = [];
  const statuses: TransportStatus[] = [];
  const errors: unknown[] = [];
  const timers: { fn: () => void; ms: number }[] = [];

  const transport = new Transport({
    api,
    url: "wss://example.test/v1/ws",
    handlers: {
      onEnvelope:
        onEnvelope ??
        ((e) => {
          received.push(e);
        }),
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeoutImpl: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimeoutImpl: () => undefined,
    random: () => 0.5, // deterministic jitter
  });

  return {
    transport,
    sockets,
    received,
    statuses,
    errors,
    timers,
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const t of pending) t.fn();
    },
  };
}

describe("Transport", () => {
  let api: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    api = fakeApi();
  });

  it("authenticates with a first frame, not a URL parameter", async () => {
    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});

    expect(h.sockets[0].authFrame).toEqual({ type: "auth", token: "tok" });
    // A token in the URL would leak into proxy logs and browser history.
    expect(h.sockets[0].sent.join()).toContain("tok");
    expect("wss://example.test/v1/ws").not.toContain("tok");
  });

  it("reports status through the handshake", async () => {
    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    expect(h.statuses).toEqual(["connecting", "authenticating", "ready"]);
  });

  it("closes and stops when there is no session token", () => {
    const h = harness(fakeApi({ sessionToken: undefined }));
    h.transport.connect();
    h.sockets[0].onopen?.({});

    // Retrying without a token would spin forever, so it must give up.
    expect(h.errors).toHaveLength(1);
    expect(h.sockets[0].closed).toBe(true);
    expect(h.timers).toHaveLength(0);
  });

  it("delivers a pushed envelope and acknowledges it", async () => {
    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    await h.sockets[0].deliver(base64Envelope("env-1"));

    expect(h.received.map((e) => e.id)).toEqual(["env-1"]);
    expect(h.received[0].payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(api.acknowledge).toHaveBeenCalledWith(["env-1"]);
  });

  it("drains the backlog on connect before going idle", async () => {
    api.fetchEnvelopes
      .mockResolvedValueOnce([envelope("old-1"), envelope("old-2")])
      .mockResolvedValue([]);

    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    // A client that was away must catch up before live traffic matters.
    expect(h.received.map((e) => e.id)).toEqual(["old-1", "old-2"]);
    expect(api.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("acknowledges only after the handler has finished", async () => {
    const order: string[] = [];
    api.acknowledge = vi.fn(async () => {
      order.push("ack");
      return 1;
    });

    const h = harness(api, async () => {
      order.push("handle-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("handle-end");
    });

    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();
    await h.sockets[0].deliver(base64Envelope("env-1"));
    await new Promise((r) => setTimeout(r, 20));

    // Acknowledging on receipt would lose the message if the client died
    // mid-handling; the ack must come last.
    expect(order).toEqual(["handle-start", "handle-end", "ack"]);
  });

  it("leaves an envelope unacknowledged when the handler throws", async () => {
    const h = harness(api, () => {
      throw new Error("handler blew up");
    });

    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();
    await h.sockets[0].deliver(base64Envelope("env-1"));

    // Unacknowledged means the server redelivers it, which is the point.
    expect(api.acknowledge).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(1);
  });

  it("redelivers to the handler after a failed attempt", async () => {
    let attempts = 0;
    const h = harness(api, () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
    });

    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    await h.sockets[0].deliver(base64Envelope("env-1"));
    await h.sockets[0].deliver(base64Envelope("env-1"));

    // The first failure must not poison the dedup set, or a transient error
    // would drop the message permanently.
    expect(attempts).toBe(2);
    expect(api.acknowledge).toHaveBeenCalledWith(["env-1"]);
  });

  it("does not deliver the same envelope twice", async () => {
    api.fetchEnvelopes.mockResolvedValue([]);
    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    await h.sockets[0].deliver(base64Envelope("env-1"));
    await h.sockets[0].deliver(base64Envelope("env-1"));

    // A live push and a backlog entry can be the same envelope.
    expect(h.received).toHaveLength(1);
  });

  it("stops draining when a page yields no acknowledgement", async () => {
    // Fetching does not delete, so an unacknowledgeable page repeats forever.
    api.fetchEnvelopes.mockResolvedValue([envelope("stuck")]);
    api.acknowledge = vi.fn(async () => {
      throw new Error("ack failed");
    });

    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    expect(api.fetchEnvelopes).toHaveBeenCalledTimes(1);
  });

  it("reconnects with bounded, growing backoff", () => {
    const h = harness(api);
    h.transport.connect();

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      h.sockets[h.sockets.length - 1].onclose?.({});
      delays.push(h.timers[h.timers.length - 1].ms);
      h.runTimers();
    }

    // Growing...
    expect(delays[1]).toBeGreaterThan(delays[0]);
    // ...but capped, so a long outage does not push retries into next week.
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    expect(h.sockets.length).toBeGreaterThan(1);
  });

  it("resets backoff only after a completed handshake", async () => {
    const h = harness(api);
    h.transport.connect();

    h.sockets[0].onclose?.({});
    const firstRetry = h.timers[0].ms;
    h.runTimers();
    h.sockets[1].onclose?.({});
    const grownRetry = h.timers[0].ms;
    h.runTimers();

    expect(grownRetry).toBeGreaterThan(firstRetry);

    // A socket that opens but never authenticates is not a healthy endpoint,
    // so only "ready" may reset the backoff.
    h.sockets[2].onopen?.({});
    await h.sockets[2].ready();
    h.sockets[2].onclose?.({});

    expect(h.timers[0].ms).toBe(firstRetry);
  });

  it("stops reconnecting once closed", () => {
    const h = harness(api);
    h.transport.connect();
    h.transport.close();

    h.sockets[0].onclose?.({});
    expect(h.timers).toHaveLength(0);
    expect(h.statuses).toContain("closed");
  });

  it("surfaces a server error frame", async () => {
    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].deliver({ type: "error", error: "invalid token" });

    expect(h.errors).toHaveLength(1);
    expect(String(h.errors[0])).toContain("invalid token");
  });

  it("ignores malformed and unknown frames without dropping the socket", async () => {
    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    h.sockets[0].onmessage?.({ data: "not json at all" });
    await h.sockets[0].deliver({ type: "from-the-future" });
    await h.sockets[0].deliver(base64Envelope("env-1"));

    // Forward compatibility: unknown frames must not break delivery.
    expect(h.received.map((e) => e.id)).toEqual(["env-1"]);
    expect(h.sockets[0].closed).toBe(false);
  });

  it("reports a backlog fetch failure without tearing down the socket", async () => {
    api.fetchEnvelopes = vi.fn(async () => {
      throw new Error("backlog unavailable");
    });

    const h = harness(api);
    h.transport.connect();
    h.sockets[0].onopen?.({});
    await h.sockets[0].ready();

    expect(h.errors).toHaveLength(1);
    expect(h.sockets[0].closed).toBe(false);

    // Live pushes still work even though catch-up failed.
    await h.sockets[0].deliver(base64Envelope("env-1"));
    expect(h.received.map((e) => e.id)).toEqual(["env-1"]);
  });

  it("refuses to reconnect after close", () => {
    const h = harness(api);
    h.transport.connect();
    h.transport.close();

    expect(() => h.transport.connect()).toThrow(/already closed/);
  });
});
