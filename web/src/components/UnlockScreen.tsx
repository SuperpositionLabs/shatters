"use client";

import { type FormEvent, useState } from "react";

interface Props {
  mode: "onboarding" | "unlocking";
  error?: string;
  /** The error can be escaped by destroying the vault and starting over. */
  recoverable?: boolean;
  onCreate: (passphrase: string) => Promise<void>;
  onUnlock: (passphrase: string) => Promise<void>;
  onReset?: () => Promise<void>;
}

/** Shortest passphrase accepted when creating a vault. */
export const MIN_PASSPHRASE_LENGTH = 10;

/**
 * The first screen.
 *
 * The passphrase is the only thing between a stolen device and the entire
 * history, so this is not a setting tucked away somewhere - it is the door.
 */
export function UnlockScreen({
  mode,
  error,
  recoverable,
  onCreate,
  onUnlock,
  onReset,
}: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [localError, setLocalError] = useState<string>();

  const creating = mode === "onboarding";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError(undefined);

    if (creating) {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        setLocalError(
          `Use at least ${MIN_PASSPHRASE_LENGTH} characters. This is the only thing protecting your messages on this device.`,
        );
        return;
      }
      if (passphrase !== confirmation) {
        // There is no reset: a typo here loses the account permanently.
        setLocalError("The two passphrases do not match.");
        return;
      }
    }

    setBusy(true);
    try {
      await (creating ? onCreate(passphrase) : onUnlock(passphrase));
    } finally {
      setBusy(false);
      setPassphrase("");
      setConfirmation("");
    }
  }

  const message = localError ?? error;

  return (
    <main className="unlock">
      <div className="unlock__card">
        <h1 className="unlock__brand">shatters</h1>
        <p className="unlock__tagline">
          {creating ? "Create your account" : "Welcome back"}
        </p>

        <form onSubmit={submit} className="unlock__form">
          <label className="field">
            <span className="field__label">Passphrase</span>
            <input
              type="password"
              className="field__input"
              value={passphrase}
              autoFocus
              autoComplete={creating ? "new-password" : "current-password"}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={busy}
            />
          </label>

          {creating && (
            <label className="field">
              <span className="field__label">Confirm passphrase</span>
              <input
                type="password"
                className="field__input"
                value={confirmation}
                autoComplete="new-password"
                onChange={(e) => setConfirmation(e.target.value)}
                disabled={busy}
              />
            </label>
          )}

          {message && (
            <p className="alert" role="alert">
              {message}
            </p>
          )}

          {recoverable && onReset && !confirmingReset && (
            // Without a way out, this state is a dead end escapable only by
            // clearing site data, which nothing tells the user to do.
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setConfirmingReset(true)}
            >
              Start over
            </button>
          )}

          {recoverable && onReset && confirmingReset && (
            <div className="unlock__confirm">
              {/* Destructive and irreversible, so it is stated plainly and
                  requires a second, deliberate action. */}
              <p className="unlock__warning">
                This permanently deletes everything stored on this device,
                including any message history. It cannot be undone.
              </p>
              <div className="unlock__confirmrow">
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void onReset()}
                >
                  Delete and start over
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setConfirmingReset(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <button type="submit" className="button button--primary" disabled={busy}>
            {busy
              ? creating
                ? "Creating account…"
                : "Unlocking…"
              : creating
                ? "Create account"
                : "Unlock"}
          </button>
        </form>

        <p className="unlock__note">
          {creating ? (
            <>
              Your keys are generated on this device and never leave it. There
              is no password reset — if you forget this passphrase, your
              messages are unrecoverable.
            </>
          ) : (
            <>Your history is encrypted on this device. Nothing is sent anywhere to unlock it.</>
          )}
        </p>
      </div>
    </main>
  );
}
