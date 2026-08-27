"use client";

import { useState } from "react";

import { formatAccountId } from "../lib/client/format";

interface Props {
  accountId: string;
  connection: "offline" | "connecting" | "online";
  notifications?: NotificationPermission | "unavailable";
  onEnableNotifications?: () => void;
  onLock: () => void;
}

export function AccountPanel({
  accountId,
  connection,
  notifications,
  onEnableNotifications,
  onLock,
}: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the id is on screen and selectable,
      // so this is a convenience failing, not a dead end.
      setCopied(false);
    }
  }

  return (
    <footer className="account">
      <div className="account__row">
        <span
          className={`status-dot status-dot--${connection}`}
          title={connection}
          aria-hidden="true"
        />
        <span className="visually-hidden">Connection: {connection}</span>
        <span className="account__label">Your ID</span>
      </div>

      {/* Grouped, because 43 characters of base64url is impossible to compare
          at a glance and "looks about right" is how people accept a wrong key. */}
      <code className="account__id" title={accountId}>
        {formatAccountId(accountId)}
      </code>

      <div className="account__actions">
        <button type="button" className="button button--ghost" onClick={copy}>
          {copied ? "Copied" : "Copy ID"}
        </button>
        {notifications === "default" && onEnableNotifications && (
          // Offered as an action rather than prompted on load: a browser
          // permission dialog nobody asked for teaches people to click block.
          <button
            type="button"
            className="button button--ghost"
            onClick={onEnableNotifications}
          >
            Notify me
          </button>
        )}
        <button type="button" className="button button--ghost" onClick={onLock}>
          Lock
        </button>
      </div>
    </footer>
  );
}
