"use client";

import { type FormEvent, useState } from "react";

import { normalizeAccountId, previewOf, shortAccountId } from "../lib/client/format";
import type { Conversation, StoredMessage } from "../lib/store/types";

interface Props {
  conversations: Conversation[];
  activeId?: string;
  previews: Record<string, StoredMessage | undefined>;
  typing: Set<string>;
  onOpen: (id: string) => void;
  onStart: (id: string, displayName?: string) => void;
  onDelete: (id: string) => void;
}

export function ConversationList({
  conversations,
  activeId,
  previews,
  typing,
  onOpen,
  onStart,
  onDelete,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();

  function submit(event: FormEvent) {
    event.preventDefault();

    // Validating here turns a confusing network error into a clear one, and
    // strips the whitespace that copying an id always brings along.
    const normalized = normalizeAccountId(peerId);
    if (!normalized) {
      setError("That does not look like an account ID.");
      return;
    }

    onStart(normalized, name.trim() || undefined);
    setPeerId("");
    setName("");
    setError(undefined);
    setAdding(false);
  }

  return (
    <section className="sidebar" aria-label="Conversations">
      <header className="sidebar__header">
        <h2 className="sidebar__title">Chats</h2>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
        >
          {adding ? "Cancel" : "New"}
        </button>
      </header>

      {adding && (
        <form className="sidebar__new" onSubmit={submit}>
          <label className="field">
            <span className="field__label">Account ID</span>
            <input
              className="field__input field__input--mono"
              value={peerId}
              onChange={(e) => setPeerId(e.target.value)}
              placeholder="43-character ID"
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field__label">Name (only on this device)</span>
            <input
              className="field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional"
            />
          </label>
          {error && (
            <p className="alert alert--inline" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button--primary">
            Start chat
          </button>
        </form>
      )}

      {conversations.length === 0 ? (
        <p className="sidebar__empty">
          No conversations yet. Share your account ID to get started.
        </p>
      ) : (
        <ul className="conversations">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <div
                className={
                  "conversation" +
                  (conversation.id === activeId ? " conversation--active" : "")
                }
              >
                <button
                  type="button"
                  className="conversation__main"
                  onClick={() => onOpen(conversation.id)}
                  aria-current={conversation.id === activeId}
                >
                  <span className="conversation__name">
                    {conversation.displayName ?? shortAccountId(conversation.id)}
                  </span>
                  <span className="conversation__preview">
                    {typing.has(conversation.id)
                      ? "typing…"
                      : previewOf(previews[conversation.id])}
                  </span>
                </button>

                {conversation.unreadCount > 0 && (
                  <span
                    className="badge"
                    aria-label={`${conversation.unreadCount} unread`}
                  >
                    {conversation.unreadCount}
                  </span>
                )}

                <button
                  type="button"
                  className="conversation__delete"
                  onClick={() => onDelete(conversation.id)}
                  aria-label={`Delete conversation with ${
                    conversation.displayName ?? shortAccountId(conversation.id)
                  }`}
                  title="Delete conversation"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
