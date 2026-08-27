"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { groupByDay, shortAccountId } from "../lib/client/format";
import { searchMessages } from "../lib/client/search";
import type { Conversation, StoredMessage } from "../lib/store/types";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

interface Props {
  conversation?: Conversation;
  messages: StoredMessage[];
  peerTyping: boolean;
  onBack: () => void;
  onLeaveGroup?: (id: string) => void;
  onSend: (body: string) => void;
  onAttach: (file: File) => void;
  onTyping: () => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  onDownload: (message: StoredMessage) => void;
  onReact?: (id: string, emoji: string, active: boolean) => void;
  selfId?: string;
}

export function ChatView({
  conversation,
  messages,
  peerTyping,
  onBack,
  onLeaveGroup,
  onSend,
  onAttach,
  onTyping,
  onRetry,
  onDelete,
  onEdit,
  onDownload,
  onReact,
  selfId,
}: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  // Follow the conversation as it grows, the way every chat does.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, peerTyping]);

  if (!conversation) {
    return (
      <section className="chat chat--empty">
        <p className="chat__placeholder">
          Select a conversation, or start a new one.
        </p>
      </section>
    );
  }

  // Filtering in memory rather than against an index: an unencrypted index of
  // message text would undo the vault entirely.
  const visible = useMemo(
    () =>
      query.trim()
        ? searchMessages(messages, query).map((hit) => hit.message)
        : messages,
    [messages, query],
  );
  const groups = groupByDay(visible, Date.now());

  return (
    <section className="chat" aria-label="Conversation">
      <header className="chat__header">
        <button
          type="button"
          className="button button--ghost chat__back"
          onClick={onBack}
          aria-label="Back to conversations"
        >
          ←
        </button>
        <div className="chat__identity">
          <h2 className="chat__name">
            {conversation.displayName ?? shortAccountId(conversation.id)}
          </h2>
          <p className="chat__id" title={conversation.id}>
            {conversation.isGroup ? "Group" : shortAccountId(conversation.id)}
          </p>
        </div>
        <input
          type="search"
          className="chat__search"
          value={query}
          placeholder="Search"
          aria-label="Search this conversation"
          onChange={(e) => setQuery(e.target.value)}
        />
        {conversation.isGroup && onLeaveGroup && (
          <button
            type="button"
            className="button button--ghost chat__leave"
            onClick={() => onLeaveGroup(conversation.id)}
          >
            Leave
          </button>
        )}
      </header>

      <div className="chat__scroll">
        {query.trim() && visible.length === 0 && (
          <p className="chat__placeholder">No messages match that search.</p>
        )}

        {messages.length === 0 && (
          <p className="chat__placeholder">
            No messages yet. Everything you send here is end-to-end encrypted.
            {conversation.isGroup &&
              " Group messages are encrypted separately for each member."}
          </p>
        )}

        {groups.map((group) => (
          <div key={group.day} className="chat__day">
            <div className="chat__daylabel">
              <span>{group.day}</span>
            </div>
            {group.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                senderLabel={
                  conversation.isGroup && message.senderId
                    ? shortAccountId(message.senderId)
                    : undefined
                }
                onRetry={onRetry}
                onDelete={onDelete}
                onEdit={onEdit}
                onDownload={onDownload}
                onReact={onReact}
                selfId={selfId}
              />
            ))}
          </div>
        ))}

        {peerTyping && (
          <p className="typing" aria-live="polite">
            typing…
          </p>
        )}
        <div ref={bottom} />
      </div>

      <Composer onSend={onSend} onAttach={onAttach} onTyping={onTyping} />
    </section>
  );
}
