"use client";

import { type FormEvent, useState } from "react";

interface Props {
  mode: "onboarding" | "unlocking";
  error?: string;
  onCreate: (passphrase: string) => Promise<void>;
  onUnlock: (passphrase: string) => Promise<void>;
}

/** Shortest passphrase accepted when creating a vault. */
export const MIN_PASSPHRASE_LENGTH = 10;

/**
 * The first screen.
 *
 * The passphrase is the only thing between a stolen device and the entire
 * history, so this is not a setting tucked away somewhere - it is the door.
 */
export function UnlockScreen({ mode, error, onCreate, onUnlock }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
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
