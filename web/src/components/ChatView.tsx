"use client";

import { useEffect, useRef } from "react";

import { groupByDay, shortAccountId } from "../lib/client/format";
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
}: Props) {
  const bottom = useRef<HTMLDivElement>(null);

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

  const groups = groupByDay(messages, Date.now());

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
