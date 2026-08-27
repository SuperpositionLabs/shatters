"use client";

import { useEffect, useState } from "react";

import { formatSafetyNumber } from "../lib/crypto/safety";
import type { Conversation } from "../lib/store/types";

interface Props {
  conversation: Conversation;
  loadSafetyNumber: (id: string) => Promise<string | undefined>;
  onSetVerified: (id: string, verified: boolean) => void;
  onAcknowledgeChange: (id: string) => void;
}

/**
 * Safety number and key-change warning.
 *
 * The number proves the identity key is the one the peer holds; the warning is
 * what most people will actually act on, so it is shown whether or not anyone
 * ever opens this panel.
 */
export function SafetyPanel({
  conversation,
  loadSafetyNumber,
  onSetVerified,
  onAcknowledgeChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [digits, setDigits] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadSafetyNumber(conversation.id).then((value) => {
      if (!cancelled) setDigits(value);
    });
    return () => {
      cancelled = true;
    };
  }, [conversation.id, loadSafetyNumber, open]);

  const verified =
    conversation.verifiedIdentityKey !== undefined &&
    conversation.verifiedIdentityKey === conversation.peerIdentityKey;

  return (
    <div className="safety">
      {conversation.identityChangedFrom && (
        // Shown without being asked for: this is the one thing here that
        // someone needs to see even if they never think about key material.
        <div className="safety__warning" role="alert">
          <p>
            This contact&rsquo;s security key changed. They may have reinstalled
            the app, or someone may be intercepting this conversation. Compare
            the safety number before sending anything sensitive.
          </p>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onAcknowledgeChange(conversation.id)}
          >
            I understand
          </button>
        </div>
      )}

      <button
        type="button"
        className="button button--ghost safety__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {verified ? "Verified" : "Verify"}
      </button>

      {open && (
        <div className="safety__detail">
          <p className="safety__hint">
            Compare these digits with your contact over a channel you already
            trust. If they match, nobody is in the middle.
          </p>
          <code className="safety__number">
            {digits ? formatSafetyNumber(digits) : "Calculating…"}
          </code>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onSetVerified(conversation.id, !verified)}
            disabled={!digits}
          >
            {verified ? "Clear verification" : "Mark as verified"}
          </button>
        </div>
      )}
    </div>
  );
}
