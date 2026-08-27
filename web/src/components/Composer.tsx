"use client";

import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

interface Props {
  disabled?: boolean;
  onSend: (body: string) => void;
  onAttach: (file: File) => void;
  onTyping: () => void;
}

/** How often a typing signal may be sent while the user keeps typing. */
const TYPING_THROTTLE_MS = 3000;

export function Composer({ disabled, onSend, onAttach, onTyping }: Props) {
  const [draft, setDraft] = useState("");
  const lastTypingAt = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line - the convention everywhere.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function handleChange(value: string) {
    setDraft(value);

    // Throttled: one signal per keystroke would flood the peer with envelopes
    // for something purely cosmetic.
    const now = Date.now();
    if (value && now - lastTypingAt.current > TYPING_THROTTLE_MS) {
      lastTypingAt.current = now;
      onTyping();
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <button
        type="button"
        className="button button--ghost composer__attach"
        onClick={() => fileInput.current?.click()}
        disabled={disabled}
        aria-label="Attach a file"
        title="Attach a file"
      >
        📎
      </button>
      <input
        ref={fileInput}
        type="file"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onAttach(file);
          // Reset, or selecting the same file twice fires nothing the second
          // time.
          e.target.value = "";
        }}
      />

      <textarea
        className="composer__input"
        value={draft}
        rows={1}
        placeholder="Write a message"
        aria-label="Message"
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      <button
        type="submit"
        className="button button--primary composer__send"
        disabled={disabled || draft.trim().length === 0}
      >
        Send
      </button>
    </form>
  );
}
