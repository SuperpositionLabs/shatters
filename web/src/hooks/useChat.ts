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
  /** The current error can be escaped by destroying the vault and starting over. */
  recoverable?: boolean;
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
  /**
   * Held only between a successful unlock and a possible reset, so the vault
   * can be destroyed properly rather than by clearing the whole store.
   */
  const pendingPassphrase = useRef<string | undefined>(undefined);
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

      let vault: Vault | undefined;
      try {
        vault = await Vault.create(passphrase, { adapter: defaultAdapter() });
        await boot(vault, "register");
      } catch (error) {
        // Registration can fail after the vault exists - an unreachable server
        // is the common case. Leaving it behind strands the user: the app
        // would offer Unlock forever on a vault with no account in it. It
        // holds nothing yet, so removing it costs nothing.
        await vault?.destroy().catch(() => undefined);
        patch({ phase: "onboarding", error: describe(error) });
      }
    },
    [boot, patch],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      patch({ error: undefined, recoverable: false });
      try {
        const vault = await Vault.unlock(passphrase, defaultAdapter());
        pendingPassphrase.current = passphrase;
        await boot(vault, "resume");
      } catch (error) {
        // A vault that opened but holds no account is recoverable only by
        // starting over, so the UI needs to know to offer that.
        const recoverable = error instanceof NoAccountError;
        if (!recoverable) pendingPassphrase.current = undefined;
        patch({ error: describe(error), recoverable });
      }
    },
    [boot, patch],
  );

  /**
   * Destroys the local vault and starts over.
   *
   * Deliberately explicit and confirmed by the caller: silently wiping a vault
   * that might hold real history would be far worse than the dead end this
   * exists to escape.
   */
  const resetVault = useCallback(async () => {
    try {
      const vault = await Vault.unlock(pendingPassphrase.current ?? "", defaultAdapter())
        .catch(() => undefined);
      if (vault) {
        await vault.destroy();
      } else {
        // Cannot open it, so remove the whole store rather than leave a vault
        // nobody can get into.
        await defaultAdapter().clear();
      }
    } finally {
      pendingPassphrase.current = undefined;
      setState({
        phase: "onboarding",
        conversations: [],
        messages: [],
        typing: new Set(),
        connection: "offline",
      });
    }
  }, []);

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
      resetVault,
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
      resetVault,
      openConversation,
      patch,
      refreshConversations,
      startConversation,
      unlock,
    ],
  );

  return { state, actions, typingTtlMs: TYPING_TTL_MS };
}

/** The vault opened but holds no identity. */
class NoAccountError extends Error {
  constructor() {
    super("This vault has no account on it.");
  }
}

async function resumeOrThrow(client: ChatClient): Promise<string> {
  if (!(await client.resume())) {
    throw new NoAccountError();
  }
  return client.accountId;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
