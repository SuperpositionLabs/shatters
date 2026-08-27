"use client";

/**
 * React binding for the chat engine.
 *
 * The engine holds all the logic; this hook only mirrors it into state and
 * pushes user actions back. Keeping the split sharp means the interesting
 * behaviour stays testable without a DOM.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatClient, TYPING_TTL_MS } from "../lib/client/chat-client";
import { ChatStore } from "../lib/store/chat";
import type { Conversation, StoredMessage } from "../lib/store/types";
import { Vault } from "../lib/storage/vault";
import { defaultAdapter } from "../lib/storage/adapter";
import { ApiClient } from "../lib/transport/api";
import { Transport } from "../lib/transport/socket";

export type Phase = "loading" | "onboarding" | "unlocking" | "ready";

export interface ChatState {
  phase: Phase;
  accountId?: string;
  conversations: Conversation[];
  activeId?: string;
  messages: StoredMessage[];
  /** Conversation ids where the peer is composing right now. */
  typing: Set<string>;
  connection: "offline" | "connecting" | "online";
  error?: string;
}

/** Server origin. Same-origin by default, which is how it is deployed. */
function serverBase(): string {
  if (typeof window === "undefined") return "";
  return process.env.NEXT_PUBLIC_SHATTERS_API ?? window.location.origin;
}

export function useChat() {
  const [state, setState] = useState<ChatState>({
    phase: "loading",
    conversations: [],
    messages: [],
    typing: new Set(),
    connection: "offline",
  });

  const clientRef = useRef<ChatClient>(undefined);
  const transportRef = useRef<Transport>(undefined);
  const activeRef = useRef<string | undefined>(undefined);
  /** Timers that clear a typing indicator when its TTL runs out. */
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const patch = useCallback((next: Partial<ChatState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  // Decide between onboarding and unlock exactly once, on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const exists = await Vault.exists(defaultAdapter());
      if (!cancelled) patch({ phase: exists ? "unlocking" : "onboarding" });
    })();
    return () => {
      cancelled = true;
    };
  }, [patch]);

  useEffect(() => {
    const timers = typingTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      transportRef.current?.close();
    };
  }, []);

  const refreshConversations = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    patch({ conversations: await client.conversations() });
  }, [patch]);

  const refreshMessages = useCallback(
    async (conversationId: string) => {
      const client = clientRef.current;
      // Ignore a refresh for a conversation the user has already left, or the
      // open thread would be replaced by a stale one.
      if (!client || activeRef.current !== conversationId) return;
      patch({ messages: await client.messages(conversationId) });
    },
    [patch],
  );

  const markTyping = useCallback(
    (conversationId: string, until: number) => {
      setState((current) => {
        const typing = new Set(current.typing);
        typing.add(conversationId);
        return { ...current, typing };
      });

      const timers = typingTimers.current;
      clearTimeout(timers.get(conversationId));
      // Expiry, not a "stopped" message: a lost stop would otherwise leave the
      // indicator on forever.
      timers.set(
        conversationId,
        setTimeout(
          () => {
            setState((current) => {
              const typing = new Set(current.typing);
              typing.delete(conversationId);
              return { ...current, typing };
            });
          },
          Math.max(0, until - Date.now()),
        ),
      );
    },
    [],
  );

  /** Builds the engine over an unlocked vault and connects the transport. */
  const boot = useCallback(
    async (vault: Vault, mode: "register" | "resume") => {
      const api = new ApiClient({ baseUrl: serverBase() });
      const store = new ChatStore(vault);

      const client = new ChatClient({
        api,
        store,
        events: {
          onConversationChanged: (id) => void refreshMessages(id),
          onConversationsChanged: () => void refreshConversations(),
          onTyping: markTyping,
          onError: (error) =>
            patch({ error: error instanceof Error ? error.message : String(error) }),
        },
      });
      clientRef.current = client;

      const accountId =
        mode === "register" ? await client.register() : await resumeOrThrow(client);

      patch({ phase: "ready", accountId, connection: "connecting" });
      await refreshConversations();

      const transport = new Transport({
        api,
        url: serverBase().replace(/^http/, "ws") + "/v1/ws",
        handlers: {
          onEnvelope: (envelope) => client.handleEnvelope(envelope),
          onStatus: (status) =>
            patch({
              connection:
                status === "ready"
                  ? "online"
                  : status === "connecting" || status === "authenticating"
                    ? "connecting"
                    : "offline",
            }),
          onError: (error) =>
            patch({ error: error instanceof Error ? error.message : String(error) }),
        },
      });
      transportRef.current = transport;
      client.attachTransport(transport);
      transport.connect();
    },
    [markTyping, patch, refreshConversations, refreshMessages],
  );

  const createAccount = useCallback(
    async (passphrase: string) => {
      patch({ error: undefined });
      try {
        const vault = await Vault.create(passphrase, { adapter: defaultAdapter() });
        await boot(vault, "register");
      } catch (error) {
        patch({ error: describe(error) });
      }
    },
    [boot, patch],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      patch({ error: undefined });
      try {
        const vault = await Vault.unlock(passphrase, defaultAdapter());
        await boot(vault, "resume");
      } catch (error) {
        patch({ error: describe(error) });
      }
    },
    [boot, patch],
  );

  /** Drops every decrypted trace from memory and from the screen. */
  const lock = useCallback(() => {
    transportRef.current?.close();
    transportRef.current = undefined;
    clientRef.current?.disconnect();
    clientRef.current = undefined;
    activeRef.current = undefined;

    setState({
      phase: "unlocking",
      conversations: [],
      messages: [],
      typing: new Set(),
      connection: "offline",
    });
  }, []);

  const openConversation = useCallback(
    async (conversationId: string) => {
      const client = clientRef.current;
      if (!client) return;

      activeRef.current = conversationId;
      patch({ activeId: conversationId, messages: await client.messages(conversationId) });
      await client.markRead(conversationId);
      await refreshConversations();
    },
    [patch, refreshConversations],
  );

  const closeConversation = useCallback(() => {
    activeRef.current = undefined;
    patch({ activeId: undefined, messages: [] });
  }, [patch]);

  const startConversation = useCallback(
    async (peerId: string, displayName?: string) => {
      const client = clientRef.current;
      if (!client) return;
      patch({ error: undefined });
      try {
        await client.startConversation(peerId, displayName);
        await refreshConversations();
        await openConversation(peerId);
      } catch (error) {
        patch({ error: describe(error) });
      }
    },
    [openConversation, patch, refreshConversations],
  );

  const actions = useMemo(
    () => ({
      createAccount,
      unlock,
      lock,
      openConversation,
      closeConversation,
      startConversation,
      sendText: async (body: string) => {
        const id = activeRef.current;
        if (!id || !clientRef.current) return;
        await clientRef.current.sendText(id, body);
      },
      sendAttachment: async (file: File) => {
        const id = activeRef.current;
        if (!id || !clientRef.current) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        await clientRef.current.sendAttachment(id, {
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          bytes,
        });
      },
      notifyTyping: async () => {
        const id = activeRef.current;
        if (!id || !clientRef.current) return;
        await clientRef.current.sendTyping(id);
      },
      retry: async (messageId: string) => {
        const id = activeRef.current;
        if (!id || !clientRef.current) return;
        await clientRef.current.retry(id, messageId);
      },
      deleteMessage: async (messageId: string) => {
        const id = activeRef.current;
        if (!id || !clientRef.current) return;
        await clientRef.current.deleteMessage(id, messageId);
      },
      editMessage: async (messageId: string, body: string) => {
        const id = activeRef.current;
        if (!id || !clientRef.current) return;
        await clientRef.current.editMessage(id, messageId, body);
      },
      deleteConversation: async (conversationId: string) => {
        if (!clientRef.current) return;
        await clientRef.current.deleteConversation(conversationId);
        if (activeRef.current === conversationId) closeConversation();
        await refreshConversations();
      },
      attachment: async (ref: string) => clientRef.current?.attachment(ref),
      /** History for a conversation that is not the open one, for previews. */
      messagesFor: async (conversationId: string): Promise<StoredMessage[]> =>
        (await clientRef.current?.messages(conversationId)) ?? [],
      dismissError: () => patch({ error: undefined }),
    }),
    [
      closeConversation,
      createAccount,
      lock,
      openConversation,
      patch,
      refreshConversations,
      startConversation,
      unlock,
    ],
  );

  return { state, actions, typingTtlMs: TYPING_TTL_MS };
}

async function resumeOrThrow(client: ChatClient): Promise<string> {
  if (!(await client.resume())) {
    // The vault opened but holds no identity: recoverable only by starting
    // over, so say so rather than failing obscurely later.
    throw new Error("This vault has no account. Create a new one.");
  }
  return client.accountId;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
