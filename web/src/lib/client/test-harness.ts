/**
 * Shared test harness for the chat engine.
 *
 * An in-memory stand-in for the server: it holds registered bundles and routes
 * envelopes between clients, so two or more real ChatClients can talk without
 * one running. Not a `.test.ts` file, so it is imported rather than collected.
 */
import { vi } from "vitest";

import type { Identity, SignedPrekey } from "../crypto/identity";
import { MemoryAdapter } from "../storage/adapter";
import { Vault } from "../storage/vault";
import { ChatStore } from "../store/chat";
import type { ApiClient } from "../transport/api";
import type { DeliveredEnvelope } from "../transport/socket";
import { ChatClient } from "./chat-client";

/** Argon2id at moderate cost is far too slow for a suite that unlocks often. */
export const fastVault = { strength: "interactive" } as const;

export class FakeNetwork {
  readonly accounts = new Map<
    string,
    {
      identityKey: Uint8Array;
      identityDhKey: Uint8Array;
      signedPrekey: { id: number; publicKey: Uint8Array; signature: Uint8Array };
      oneTimePrekeys: { id: number; publicKey: Uint8Array }[];
    }
  >();

  readonly inboxes = new Map<string, DeliveredEnvelope[]>();
  private nextEnvelope = 0;
  /** Set to make the next send fail, for the failure paths. */
  failNextSend = false;

  apiFor(accountId: () => string): ApiClient {
    const net = this;

    return {
      get sessionToken() {
        return "token";
      },
      register: async (
        identity: Identity,
        signedPrekey: SignedPrekey,
        oneTimePrekeys: { id: number; publicKey: Uint8Array }[] = [],
      ) => {
        const { accountId: derive } = await import("../crypto/identity");
        const id = await derive(identity.signing.publicKey);
        net.accounts.set(id, {
          identityKey: identity.signing.publicKey,
          identityDhKey: identity.dh.publicKey,
          signedPrekey,
          oneTimePrekeys: [...oneTimePrekeys],
        });
        return id;
      },
      authenticate: async () => "token",
      useToken: () => undefined,
      fetchBundle: async (peer: string) => {
        const account = net.accounts.get(peer);
        if (!account) throw new Error(`unknown account ${peer}`);
        // Consumed on fetch, exactly as the server does.
        const otk = account.oneTimePrekeys.shift();
        return {
          identityKey: account.identityKey,
          identityDhKey: account.identityDhKey,
          signedPrekey: account.signedPrekey,
          oneTimePrekey: otk,
        };
      },
      uploadPrekeys: async (prekeys: { id: number; publicKey: Uint8Array }[]) => {
        net.accounts.get(accountId())?.oneTimePrekeys.push(...prekeys);
        return prekeys.length;
      },
      sendEnvelope: async (recipient: string, payload: Uint8Array) => {
        if (net.failNextSend) {
          net.failNextSend = false;
          throw new Error("network down");
        }
        const id = `env-${net.nextEnvelope++}`;
        const inbox = net.inboxes.get(recipient) ?? [];
        inbox.push({ id, senderId: accountId(), payload, createdAt: "now" });
        net.inboxes.set(recipient, inbox);
        return id;
      },
      fetchEnvelopes: async () => [],
      acknowledge: async () => 0,
    } as unknown as ApiClient;
  }

  /** Delivers everything queued for a client into its engine. */
  async drain(to: string, client: ChatClient): Promise<void> {
    const inbox = this.inboxes.get(to) ?? [];
    this.inboxes.set(to, []);
    for (const envelope of inbox) {
      await client.handleEnvelope(envelope);
    }
  }
}

export interface Peer {
  client: ChatClient;
  store: ChatStore;
  id: string;
  typing: { conversationId: string; until: number }[];
  errors: unknown[];
}

export async function makePeer(
  net: FakeNetwork,
  clock = { t: 1000 },
): Promise<Peer> {
  const vault = await Vault.create("pw", {
    adapter: new MemoryAdapter(),
    ...fastVault,
  });
  const store = new ChatStore(vault);

  const typing: { conversationId: string; until: number }[] = [];
  const errors: unknown[] = [];

  let ownId = "";
  let counter = 0;
  const client = new ChatClient({
    api: net.apiFor(() => ownId),
    store,
    now: () => clock.t++,
    newId: () => `id-${ownId.slice(0, 4)}-${counter++}`,
    events: {
      onTyping: (conversationId, until) => typing.push({ conversationId, until }),
      onError: (e) => errors.push(e),
    },
  });

  ownId = await client.register();
  return { client, store, id: ownId, typing, errors };
}

/** Reaches past the public API to send content the client would not offer. */
export function rawSend(client: ChatClient) {
  return (
    client as unknown as {
      sendContent: (id: string, content: unknown) => Promise<string>;
    }
  ).sendContent.bind(client);
}

/** Keeps vitest from flagging the unused import in consumers. */
export const harnessMocks = { vi };
