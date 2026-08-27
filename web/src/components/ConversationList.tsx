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
  onCreateGroup: (name: string, members: string[]) => void;
  onDelete: (id: string) => void;
}

export function ConversationList({
  conversations,
  activeId,
  previews,
  typing,
  onOpen,
  onStart,
  onCreateGroup,
  onDelete,
}: Props) {
  const [adding, setAdding] = useState<"direct" | "group" | undefined>();
  const [peerId, setPeerId] = useState("");
  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");
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
    setAdding(undefined);
  }

  function submitGroup(event: FormEvent) {
    event.preventDefault();

    if (!groupName.trim()) {
      setError("Give the group a name.");
      return;
    }

    // One id per line, each validated: a single bad paste should say which
    // entry is wrong rather than failing the whole form obscurely.
    const ids: string[] = [];
    for (const line of groupMembers.split(/\n+/)) {
      if (!line.trim()) continue;
      const normalized = normalizeAccountId(line);
      if (!normalized) {
        setError(`Not an account ID: ${line.trim().slice(0, 16)}…`);
        return;
      }
      ids.push(normalized);
    }
    if (ids.length === 0) {
      setError("Add at least one member.");
      return;
    }

    onCreateGroup(groupName.trim(), ids);
    setGroupName("");
    setGroupMembers("");
    setError(undefined);
    setAdding(undefined);
  }

  return (
    <section className="sidebar" aria-label="Conversations">
      <header className="sidebar__header">
        <h2 className="sidebar__title">Chats</h2>
        <div className="sidebar__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setAdding((v) => (v === "direct" ? undefined : "direct"))}
            aria-expanded={adding === "direct"}
          >
            {adding === "direct" ? "Cancel" : "New"}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setAdding((v) => (v === "group" ? undefined : "group"))}
            aria-expanded={adding === "group"}
          >
            {adding === "group" ? "Cancel" : "New group"}
          </button>
        </div>
      </header>

      {adding === "group" && (
        <form className="sidebar__new" onSubmit={submitGroup}>
          <label className="field">
            <span className="field__label">Group name</span>
            <input
              className="field__input"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field__label">Members, one ID per line</span>
            <textarea
              className="field__input field__input--mono"
              rows={4}
              value={groupMembers}
              onChange={(e) => setGroupMembers(e.target.value)}
            />
          </label>
          {error && (
            <p className="alert alert--inline" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button--primary">
            Create group
          </button>
        </form>
      )}

      {adding === "direct" && (
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
                    {conversation.isGroup && (
                      <span className="conversation__kind" aria-label="Group">
                        #
                      </span>
                    )}
                    {conversation.displayName ?? shortAccountId(conversation.id)}
                    {conversation.verifiedIdentityKey !== undefined &&
                      conversation.verifiedIdentityKey ===
                        conversation.peerIdentityKey && (
                        <span className="conversation__verified" title="Verified">
                          <span aria-hidden="true">✓</span>
                          <span className="visually-hidden">Verified</span>
                        </span>
                      )}
                    {conversation.identityChangedFrom && (
                      <span className="conversation__warn" title="Security key changed">
                        <span aria-hidden="true">!</span>
                        <span className="visually-hidden">
                          Security key changed
                        </span>
                      </span>
                    )}
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
