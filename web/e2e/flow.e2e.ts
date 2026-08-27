/**
 * End-to-end contract test: the real client against a real server.
 *
 * Everything else in this repo is tested in isolation - Go handlers against
 * Postgres, the client transport against a fake fetch and a fake WebSocket.
 * That leaves one gap this suite exists to close: a contract drift both sides
 * independently agree on. Two defects already lived there (#27, #29).
 *
 * Requires a running stack. `SHATTERS_E2E_URL` must point at it; the suite
 * fails rather than skips if it is unset, so a green CI run can never mean
 * "tested nothing".
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  type Identity,
  accountId,
  createSignedPrekey,
  generateIdentity,
  sodium,
} from "../src/lib/crypto/identity";
import { acceptSession, encrypt, startSession } from "../src/lib/crypto/session";
import type { PrekeyStore } from "../src/lib/crypto/session";
import type { KeyPair } from "../src/lib/crypto/identity";
import { ApiClient } from "../src/lib/transport/api";
import {
  type DeliveredEnvelope,
  type SocketLike,
  Transport,
} from "../src/lib/transport/socket";

const BASE_URL = process.env.SHATTERS_E2E_URL ?? "";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One registered, authenticated participant with its local prekey store. */
interface Participant {
  identity: Identity;
  accountId: string;
  api: ApiClient;
  prekeys: MemoryPrekeyStore;
}

class MemoryPrekeyStore implements PrekeyStore {
  readonly signed = new Map<number, KeyPair>();
  readonly oneTime = new Map<number, KeyPair>();

  async signedPrekey(id: number): Promise<KeyPair | undefined> {
    return this.signed.get(id);
  }

  async takeOneTimePrekey(id: number): Promise<KeyPair | undefined> {
    const key = this.oneTime.get(id);
    this.oneTime.delete(id);
    return key;
  }
}

/**
 * Registers a participant, keeping the private halves of every prekey it
 * publishes so it can answer a handshake later.
 */
async function enroll(oneTimePrekeyCount: number): Promise<Participant> {
  const s = await sodium();
  const identity = await generateIdentity();
  const prekeys = new MemoryPrekeyStore();
  const api = new ApiClient({ baseUrl: BASE_URL });

  // createSignedPrekey keeps its private half internal, so mint the pair here
  // and sign it exactly as the client would.
  const spkId = 1;
  const spkPair = s.crypto_kx_keypair();
  prekeys.signed.set(spkId, spkPair);
  const { signDetached, signedPrekeyMessage } = await import(
    "../src/lib/crypto/identity"
  );
  const signature = await signDetached(
    identity.signing.privateKey,
    signedPrekeyMessage(spkPair.publicKey, spkId),
  );

  const otks: { id: number; publicKey: Uint8Array }[] = [];
  for (let i = 0; i < oneTimePrekeyCount; i++) {
    const pair = s.crypto_kx_keypair();
    const id = 100 + i;
    prekeys.oneTime.set(id, pair);
    otks.push({ id, publicKey: pair.publicKey });
  }

  const registered = await api.register(
    identity,
    { id: spkId, publicKey: spkPair.publicKey, signature },
    otks,
  );

  // The server must derive the same opaque id the client does.
  const expected = await accountId(identity.signing.publicKey);
  expect(registered).toBe(expected);

  await api.authenticate(identity, expected);
  return { identity, accountId: expected, api, prekeys };
}

/** Opens a transport and collects everything it delivers. */
function listen(
  participant: Participant,
  onEnvelope: (e: DeliveredEnvelope) => Promise<void> | void,
): Transport {
  const wsUrl = BASE_URL.replace(/^http/, "ws") + "/v1/ws";

  const transport = new Transport({
    api: participant.api,
    url: wsUrl,
    handlers: {
      onEnvelope,
      onError: (error) => {
        // Surfaced rather than swallowed: a silent failure here would look
        // like a timeout further down and waste the reader's time.
        console.error("transport error:", error);
      },
    },
    socketFactory: (url) => new WebSocket(url) as unknown as SocketLike,
  });

  transport.connect();
  return transport;
}

/** Resolves when `check` returns a value, or fails at the deadline. */
async function waitFor<T>(
  check: () => T | undefined,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

describe("end-to-end", () => {
  beforeAll(() => {
    if (!BASE_URL) {
      throw new Error(
        "SHATTERS_E2E_URL is not set. This suite must never be skipped " +
          "silently: a green run without it would mean nothing was tested.",
      );
    }
  });

  it("reaches the server", async () => {
    const response = await fetch(`${BASE_URL}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("delivers a message live over the WebSocket", async () => {
    const alice = await enroll(0);
    const bob = await enroll(2);

    const received: DeliveredEnvelope[] = [];
    const transport = listen(bob, (e) => {
      received.push(e);
    });

    try {
      // Alice opens a session from Bob's published bundle.
      const bundle = await alice.api.fetchBundle(bob.accountId);
      const session = await startSession(alice.identity, bundle);
      const wire = await encrypt(session, encoder.encode("hello over the wire"));
      await alice.api.sendEnvelope(bob.accountId, wire);

      const envelope = await waitFor(
        () => received[0],
        "bob to receive a pushed envelope",
      );
      expect(envelope.senderId).toBe(alice.accountId);

      // Bob decrypts with his own private prekeys - proof the whole chain
      // agrees, from the wire format through X3DH to the ratchet.
      const accepted = await acceptSession(
        bob.identity,
        bob.prekeys,
        envelope.payload,
      );
      expect(decoder.decode(accepted.plaintext)).toBe("hello over the wire");
    } finally {
      transport.close();
    }
  }, 60_000);

  it("delivers a message queued while the recipient was offline", async () => {
    const alice = await enroll(0);
    const bob = await enroll(2);

    // Bob is not connected at all when this is sent.
    const bundle = await alice.api.fetchBundle(bob.accountId);
    const session = await startSession(alice.identity, bundle);
    const wire = await encrypt(session, encoder.encode("sent while away"));
    await alice.api.sendEnvelope(bob.accountId, wire);

    const received: DeliveredEnvelope[] = [];
    const transport = listen(bob, (e) => {
      received.push(e);
    });

    try {
      // The backlog drain on connect must produce it without a second send.
      const envelope = await waitFor(
        () => received[0],
        "bob to drain the backlog on connect",
      );

      const accepted = await acceptSession(
        bob.identity,
        bob.prekeys,
        envelope.payload,
      );
      expect(decoder.decode(accepted.plaintext)).toBe("sent while away");

      // Acknowledged during delivery, so the queue is now empty.
      await waitFor(
        async () => ((await bob.api.fetchEnvelopes()).length === 0) || undefined,
        "the envelope to be acknowledged",
      );
    } finally {
      transport.close();
    }
  }, 60_000);

  it("carries a conversation in both directions", async () => {
    const alice = await enroll(0);
    const bob = await enroll(2);

    const bobInbox: DeliveredEnvelope[] = [];
    const aliceInbox: DeliveredEnvelope[] = [];
    const bobTransport = listen(bob, (e) => {
      bobInbox.push(e);
    });
    const aliceTransport = listen(alice, (e) => {
      aliceInbox.push(e);
    });

    try {
      const bundle = await alice.api.fetchBundle(bob.accountId);
      const aliceSession = await startSession(alice.identity, bundle);

      await alice.api.sendEnvelope(
        bob.accountId,
        await encrypt(aliceSession, encoder.encode("ping")),
      );

      const first = await waitFor(() => bobInbox[0], "bob's first message");
      const accepted = await acceptSession(
        bob.identity,
        bob.prekeys,
        first.payload,
      );
      expect(decoder.decode(accepted.plaintext)).toBe("ping");

      // Bob replies on the session the handshake established.
      await bob.api.sendEnvelope(
        alice.accountId,
        await encrypt(accepted.session, encoder.encode("pong")),
      );

      const reply = await waitFor(() => aliceInbox[0], "alice's reply");
      const { decrypt } = await import("../src/lib/crypto/session");
      expect(decoder.decode(await decrypt(aliceSession, reply.payload))).toBe(
        "pong",
      );
    } finally {
      bobTransport.close();
      aliceTransport.close();
    }
  }, 60_000);

  it("refuses a bundle whose signed prekey does not verify", async () => {
    const alice = await enroll(0);
    const bob = await enroll(1);
    const mallory = await generateIdentity();
    const s = await sodium();
    const { signDetached, signedPrekeyMessage } = await import(
      "../src/lib/crypto/identity"
    );

    const bundle = await alice.api.fetchBundle(bob.accountId);
    const forgedPair = s.crypto_kx_keypair();
    const forgedSignature = await signDetached(
      mallory.signing.privateKey,
      signedPrekeyMessage(forgedPair.publicKey, bundle.signedPrekey.id),
    );

    // A substituted prekey is what a malicious operator would serve; the
    // client must refuse it rather than hand the operator a session.
    await expect(
      startSession(alice.identity, {
        ...bundle,
        signedPrekey: {
          id: bundle.signedPrekey.id,
          publicKey: forgedPair.publicKey,
          signature: forgedSignature,
        },
      }),
    ).rejects.toThrow();
  }, 60_000);
});
