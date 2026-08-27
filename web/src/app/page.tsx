"use client";

import { useEffect, useMemo, useState } from "react";

import { AccountPanel } from "../components/AccountPanel";
import { ChatView } from "../components/ChatView";
import { ConversationList } from "../components/ConversationList";
import { UnlockScreen } from "../components/UnlockScreen";
import { useChat } from "../hooks/useChat";
import type { StoredMessage } from "../lib/store/types";

export default function Home() {
  const { state, actions } = useChat();
  const [previews, setPreviews] = useState<Record<string, StoredMessage | undefined>>({});

  // The list shows the latest message per conversation, which the engine does
  // not track separately; deriving it here keeps the store simple.
  useEffect(() => {
    if (state.phase !== "ready") return;
    let cancelled = false;

    void (async () => {
      const next: Record<string, StoredMessage | undefined> = {};
      for (const conversation of state.conversations) {
        const messages =
          conversation.id === state.activeId
            ? state.messages
            : await actions.messagesFor(conversation.id);
        next[conversation.id] = messages[messages.length - 1];
      }
      if (!cancelled) setPreviews(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [actions, state.activeId, state.conversations, state.messages, state.phase]);

  const active = useMemo(
    () => state.conversations.find((c) => c.id === state.activeId),
    [state.activeId, state.conversations],
  );

  if (state.phase === "loading") {
    return (
      <main className="splash">
        <p>Opening…</p>
      </main>
    );
  }

  if (state.phase !== "ready") {
    return (
      <UnlockScreen
        mode={state.phase}
        error={state.error}
        recoverable={state.recoverable}
        onCreate={actions.createAccount}
        onUnlock={actions.unlock}
        onReset={actions.resetVault}
      />
    );
  }

  async function download(message: StoredMessage) {
    if (!message.attachment) return;
    const bytes = await actions.attachment(message.attachment.blobRef);
    if (!bytes) return;

    // Decrypted only here, in memory, and handed straight to the browser.
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: message.attachment.mimeType }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = message.attachment.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className={"app" + (state.activeId ? " app--chatting" : "")}>
      <aside className="app__sidebar">
        <ConversationList
          conversations={state.conversations}
          activeId={state.activeId}
          previews={previews}
          typing={state.typing}
          onOpen={(id) => void actions.openConversation(id)}
          onStart={(id, name) => void actions.startConversation(id, name)}
          onCreateGroup={(name, members) => void actions.createGroup(name, members)}
          onDelete={(id) => void actions.deleteConversation(id)}
        />
        {state.accountId && (
          <AccountPanel
            accountId={state.accountId}
            connection={state.connection}
            onLock={actions.lock}
          />
        )}
      </aside>

      <div className="app__main">
        <ChatView
          conversation={active}
          messages={state.messages}
          peerTyping={state.activeId ? state.typing.has(state.activeId) : false}
          onBack={actions.closeConversation}
          onLeaveGroup={(id) => void actions.leaveGroup(id)}
          onSend={(body) => void actions.sendText(body)}
          onAttach={(file) => void actions.sendAttachment(file)}
          onTyping={() => void actions.notifyTyping()}
          onRetry={(id) => void actions.retry(id)}
          onDelete={(id) => void actions.deleteMessage(id)}
          onEdit={(id, body) => void actions.editMessage(id, body)}
          onDownload={(message) => void download(message)}
        />
      </div>

      {state.error && (
        <div className="toast" role="alert">
          <span>{state.error}</span>
          <button
            type="button"
            className="button button--link"
            onClick={actions.dismissError}
          >
            Dismiss
          </button>
        </div>
      )}
    </main>
  );
}
