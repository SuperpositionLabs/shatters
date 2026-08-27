/**
 * WebSocket transport: live envelope delivery with an offline catch-up pass.
 *
 * Mirrors the server contract in `docs/protocol.md` §9. The socket carries
 * opaque envelopes only; decryption happens above this layer.
 */
import type { ApiClient, QueuedEnvelope } from "./api";

/** Backoff bounds for reconnection. */
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Upper bound on pages read in one catch-up pass, so a large backlog cannot
 * hold the connection in a drain loop indefinitely. The server caps a page at
 * 100, so this covers 10 000 queued envelopes - the per-recipient limit.
 */
const MAX_DRAIN_PAGES = 100;

/**
 * How many handled envelope ids to remember for duplicate suppression.
 * Comfortably larger than a page, so a duplicate arriving during the same
 * catch-up pass is always caught, without growing for the life of a session.
 */
const MAX_REMEMBERED_IDS = 1000;

/** Minimal surface this module needs, so tests can supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onclose: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** An envelope delivered to the application, live or from the backlog. */
export interface DeliveredEnvelope {
  id: string;
  senderId: string;
  payload: Uint8Array;
  createdAt: string;
}

export interface TransportHandlers {
  /**
   * Called for each envelope. The envelope is acknowledged only after this
   * resolves; if it throws, the envelope stays queued and is redelivered.
   */
  onEnvelope: (envelope: DeliveredEnvelope) => Promise<void> | void;
  onStatus?: (status: TransportStatus) => void;
  onError?: (error: unknown) => void;
}

export type TransportStatus =
  | "connecting"
  | "authenticating"
  | "ready"
  | "disconnected"
  | "closed";

export interface TransportOptions {
  api: ApiClient;
  /** WebSocket endpoint, e.g. `wss://shatters.example/v1/ws`. */
  url: string;
  handlers: TransportHandlers;
  socketFactory?: SocketFactory;
  /** Injected for deterministic backoff in tests. */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Injected so backoff jitter is reproducible in tests. */
  random?: () => number;
}

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Manages one live connection and the reconnection loop behind it.
 *
 * Deliberately not an EventTarget: the acknowledgement contract depends on
 * knowing when the application has *finished* with an envelope, which needs an
 * awaitable handler rather than fire-and-forget events.
 */
export class Transport {
  private readonly api: ApiClient;
  private readonly url: string;
  private readonly handlers: TransportHandlers;
  private readonly makeSocket: SocketFactory;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly unschedule: (handle: unknown) => void;
  private readonly random: () => number;

  private socket?: SocketLike;
  private backoff = INITIAL_BACKOFF_MS;
  private retryHandle?: unknown;
  private stopped = false;
  /** Ids currently being handled, so concurrent copies do not both run. */
  private readonly inFlight = new Set<string>();
  /**
   * Ids already handled and acknowledged, kept to suppress duplicates.
   *
   * A live push and a backlog page that was already in flight can carry the
   * same envelope, so forgetting an id as soon as it is acknowledged would let
   * the copy through. Bounded FIFO, because the alternative grows for the life
   * of the connection.
   */
  private readonly handled = new Set<string>();

  constructor(options: TransportOptions) {
    this.api = options.api;
    this.url = options.url;
    this.handlers = options.handlers;
    this.makeSocket =
      options.socketFactory ??
      ((url) => new WebSocket(url) as unknown as SocketLike);
    this.schedule =
      options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.unschedule =
      options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as never));
    this.random = options.random ?? Math.random;
  }

  /** Opens the connection and keeps it open until `close` is called. */
  connect(): void {
    if (this.stopped) throw new Error("transport: already closed");
    this.open();
  }

  /** Stops reconnecting and closes the current socket. */
  close(): void {
    this.stopped = true;
    if (this.retryHandle !== undefined) {
      this.unschedule(this.retryHandle);
      this.retryHandle = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.status("closed");
  }

  private status(status: TransportStatus): void {
    this.handlers.onStatus?.(status);
  }

  private fail(error: unknown): void {
    this.handlers.onError?.(error);
  }

  private open(): void {
    this.status("connecting");

    let socket: SocketLike;
    try {
      socket = this.makeSocket(this.url);
    } catch (error) {
      this.fail(error);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      const token = this.api.sessionToken;
      if (!token) {
        // Without a token the socket can never authenticate, and retrying
        // would spin. Surface it and stop.
        this.fail(new Error("transport: no session token"));
        this.close();
        return;
      }
      this.status("authenticating");
      socket.send(JSON.stringify({ type: "auth", token }));
    };

    socket.onmessage = (event) => {
      void this.handleMessage(event.data);
    };

    socket.onerror = (event) => this.fail(event);

    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) return;
      this.status("disconnected");
      this.scheduleRetry();
    };
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "string") return;

    let message: {
      type?: string;
      id?: string;
      sender_id?: string;
      payload?: string;
      created_at?: string;
      error?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.fail(error);
      return;
    }

    switch (message.type) {
      case "ready":
        // A successful handshake is what proves the endpoint is healthy, so
        // the backoff resets here rather than on socket open.
        this.backoff = INITIAL_BACKOFF_MS;
        this.status("ready");
        await this.drainBacklog();
        break;

      case "envelope":
        if (message.id && message.sender_id && message.payload) {
          await this.deliver({
            id: message.id,
            senderId: message.sender_id,
            payload: decodeBase64(message.payload),
            createdAt: message.created_at ?? "",
          });
        }
        break;

      case "error":
        this.fail(new Error(message.error ?? "server error"));
        break;

      default:
        // Unknown types are ignored, matching the server's own leniency.
        break;
    }
  }

  /**
   * Reads anything queued while the client was away.
   *
   * Runs on every successful handshake, before live pushes are acted on, so a
   * client that reconnects after downtime catches up in order.
   */
  private async drainBacklog(): Promise<void> {
    try {
      for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
        const batch: QueuedEnvelope[] = await this.api.fetchEnvelopes();
        if (batch.length === 0) return;

        let acknowledged = false;
        for (const envelope of batch) {
          if (await this.deliver(envelope)) acknowledged = true;
        }

        // Fetching does not delete, so a page where nothing was acknowledged
        // comes back identical next time. Stopping is the only way out; the
        // remaining envelopes are picked up on the next reconnect.
        if (!acknowledged) return;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Hands an envelope to the application and acknowledges it afterwards.
   *
   * Acknowledging on receipt would defeat the point of the server keeping the
   * row: a client crashing mid-handling would lose the message. A handler that
   * throws therefore leaves the envelope queued for redelivery.
   */
  private async deliver(envelope: DeliveredEnvelope): Promise<boolean> {
    // The same envelope can arrive twice: pushed live and again in a backlog
    // page that was already in flight. Deduplicate before invoking the handler.
    if (this.inFlight.has(envelope.id) || this.handled.has(envelope.id)) {
      return false;
    }
    this.inFlight.add(envelope.id);

    try {
      await this.handlers.onEnvelope(envelope);
    } catch (error) {
      // Not acknowledged, so the server redelivers it - and the id is released
      // so a retry can run. A transient handler failure must not drop the
      // message permanently.
      this.inFlight.delete(envelope.id);
      this.fail(error);
      return false;
    }

    try {
      await this.api.acknowledge([envelope.id]);
      this.remember(envelope.id);
      return true;
    } catch (error) {
      // Handled but unacknowledged: the server will redeliver, and the dedup
      // set stops the application seeing it twice.
      this.remember(envelope.id);
      this.fail(error);
      return false;
    }
  }

  private remember(id: string): void {
    this.inFlight.delete(id);
    this.handled.add(id);

    // Set preserves insertion order, so the oldest id is the first key.
    while (this.handled.size > MAX_REMEMBERED_IDS) {
      const oldest = this.handled.values().next();
      if (oldest.done) break;
      this.handled.delete(oldest.value);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryHandle !== undefined) return;

    // Full jitter: without it, every client dropped by one server restart
    // reconnects in lockstep and knocks it over again.
    const delay = Math.round(this.backoff * (0.5 + this.random() * 0.5));
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);

    this.retryHandle = this.schedule(() => {
      this.retryHandle = undefined;
      if (!this.stopped) this.open();
    }, delay);
  }
}
