"use client";

import { useState } from "react";

import {
  formatBytes,
  formatTime,
  statusLabel,
  statusSymbol,
} from "../lib/client/format";
import type { StoredMessage } from "../lib/store/types";

interface Props {
  message: StoredMessage;
  /** Shown above incoming group messages, where the peer is not implied. */
  senderLabel?: string;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  onDownload: (message: StoredMessage) => void;
  onReact?: (id: string, emoji: string, active: boolean) => void;
  /** This device's account, to tell your own reaction from someone else's. */
  selfId?: string;
}

export function MessageBubble({
  message,
  senderLabel,
  onRetry,
  onDelete,
  onEdit,
  onDownload,
  onReact,
  selfId,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState(message.body);

  const outgoing = message.direction === "outgoing";

  if (message.deletedAt) {
    return (
      <div className={bubbleClass(outgoing, "message--deleted")}>
        <p className="message__body message__body--muted">Message deleted</p>
        <time className="message__time">{formatTime(message.timestamp)}</time>
      </div>
    );
  }

  return (
    <div className={bubbleClass(outgoing)}>
      {senderLabel && !outgoing && (
        <p className="message__sender">{senderLabel}</p>
      )}

      {message.attachment && (
        <button
          type="button"
          className="attachment"
          onClick={() => onDownload(message)}
        >
          <span className="attachment__icon" aria-hidden="true">
            📎
          </span>
          <span className="attachment__meta">
            <span className="attachment__name">{message.attachment.name}</span>
            <span className="attachment__size">
              {formatBytes(message.attachment.size)}
            </span>
          </span>
        </button>
      )}

      {editing ? (
        <form
          className="message__edit"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = draft.trim();
            if (trimmed && trimmed !== message.body) onEdit(message.id, trimmed);
            setEditing(false);
          }}
        >
          <input
            className="field__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Edit message"
            autoFocus
          />
          <button type="submit" className="button button--ghost">
            Save
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setDraft(message.body);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        message.body && <p className="message__body">{message.body}</p>
      )}

      {message.reactions && Object.keys(message.reactions).length > 0 && (
        <div className="reactions">
          {Object.entries(message.reactions).map(([emoji, accounts]) => {
            const mine = selfId !== undefined && accounts.includes(selfId);
            return (
              <button
                key={emoji}
                type="button"
                className={"reaction" + (mine ? " reaction--mine" : "")}
                onClick={() => onReact?.(message.id, emoji, !mine)}
                aria-pressed={mine}
                aria-label={`${emoji}, ${accounts.length} ${
                  accounts.length === 1 ? "reaction" : "reactions"
                }`}
              >
                <span aria-hidden="true">{emoji}</span>
                {/* The count matters: the same emoji from two people is two
                    facts, and a bare emoji hides the second. */}
                <span className="reaction__count">{accounts.length}</span>
              </button>
            );
          })}
        </div>
      )}

      <footer className="message__meta">
        <time className="message__time">{formatTime(message.timestamp)}</time>

        {outgoing && (
          <span
            className={
              "message__status" +
              (message.status === "read" ? " message__status--read" : "") +
              (message.status === "failed" ? " message__status--failed" : "")
            }
            title={statusLabel(message.status)}
          >
            {/* The tick alone conveys nothing to a screen reader. */}
            <span aria-hidden="true">{statusSymbol(message.status)}</span>
            <span className="visually-hidden">{statusLabel(message.status)}</span>
          </span>
        )}

        {outgoing && message.status === "failed" && (
          // A failure indicator with no way to act on it is worse than none.
          <button
            type="button"
            className="button button--link"
            onClick={() => onRetry(message.id)}
          >
            Retry
          </button>
        )}

        {onReact && (
          <span className="message__react">
            <button
              type="button"
              className="button button--link"
              onClick={() => setPicking((v) => !v)}
              aria-expanded={picking}
              aria-label="Add a reaction"
            >
              +
            </button>
            {picking && (
              <span className="picker" role="group" aria-label="Reactions">
                {REACTION_CHOICES.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="picker__option"
                    onClick={() => {
                      onReact(message.id, emoji, true);
                      setPicking(false);
                    }}
                    aria-label={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}

        {outgoing && !editing && message.status !== "failed" && (
          <>
            {!message.attachment && (
              <button
                type="button"
                className="button button--link"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              className="button button--link"
              onClick={() => onDelete(message.id)}
            >
              Delete
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

/** A small, fixed set: an emoji keyboard in a message list is unusable. */
const REACTION_CHOICES = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

function bubbleClass(outgoing: boolean, extra = ""): string {
  return [
    "message",
    outgoing ? "message--out" : "message--in",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}
