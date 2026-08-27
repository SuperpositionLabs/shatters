import { describe, expect, it, vi } from "vitest";

import { Notifier } from "./notify";

interface Shown {
  title: string;
  body?: string;
}

/** A stand-in for the Notification constructor plus its statics. */
function fakeNotification(permission: NotificationPermission) {
  const shown: Shown[] = [];
  const requested = vi.fn(async () => "granted" as NotificationPermission);

  class Fake {
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, body: options?.body });
    }
    static permission = permission;
    static requestPermission = requested;
  }

  return { api: Fake as unknown as typeof Notification, shown, requested };
}

describe("Notifier", () => {
  it("shows nothing without permission", () => {
    const { api, shown } = fakeNotification("default");
    new Notifier({ api, isFocused: () => false }).notify("alice", "hello");
    expect(shown).toEqual([]);
  });

  it("shows nothing when the window has focus", () => {
    const { api, shown } = fakeNotification("granted");
    // The message is already on screen; notifying about it is pure noise.
    new Notifier({ api, isFocused: () => true }).notify("alice", "hello");
    expect(shown).toEqual([]);
  });

  it("hides the sender and the message by default", () => {
    const { api, shown } = fakeNotification("granted");
    new Notifier({ api, isFocused: () => false }).notify("alice", "the secret");

    // A notification outlives the app's own lock, sitting where anyone holding
    // the device can read it.
    expect(shown).toHaveLength(1);
    expect(shown[0].title).not.toContain("alice");
    expect(shown[0].body).toBe("");
    expect(JSON.stringify(shown[0])).not.toContain("the secret");
  });

  it("shows the sender when asked, and still not the message", () => {
    const { api, shown } = fakeNotification("granted");
    new Notifier({ api, detail: "sender", isFocused: () => false }).notify(
      "alice",
      "the secret",
    );

    expect(shown[0].title).toContain("alice");
    // "sender" reveals who, not what. Only "message" carries the text.
    expect(shown[0].body).toBe("");
  });

  it("asks for permission only when it has not been decided", async () => {
    const granted = fakeNotification("granted");
    await new Notifier({ api: granted.api }).request();
    expect(granted.requested).not.toHaveBeenCalled();

    const denied = fakeNotification("denied");
    expect(await new Notifier({ api: denied.api }).request()).toBe("denied");
    // Re-prompting after a denial is not possible anyway, and pretending
    // otherwise hides the real state from the caller.
    expect(denied.requested).not.toHaveBeenCalled();

    const undecided = fakeNotification("default");
    await new Notifier({ api: undecided.api }).request();
    expect(undecided.requested).toHaveBeenCalled();
  });

  it("degrades quietly where notifications do not exist", async () => {
    const notifier = new Notifier({ api: undefined, isFocused: () => false });

    expect(notifier.available).toBe(false);
    expect(notifier.permission).toBe("unavailable");
    expect(await notifier.request()).toBe("unavailable");
    // Must not throw: a browser without the API is not an error state.
    expect(() => notifier.notify("alice", "hello")).not.toThrow();
  });
});

describe("Notifier detail levels", () => {
  it("puts the message text in the notification only when asked", () => {
    const { api, shown } = fakeNotification("granted");
    new Notifier({ api, detail: "message", isFocused: () => false }).notify(
      "alice",
      "the secret",
    );

    // Offered because refusing to let someone make this trade for themselves
    // would be paternalistic - but it is never the default.
    expect(shown[0].body).toBe("the secret");
  });

  it("defaults to revealing nothing", () => {
    const { api, shown } = fakeNotification("granted");
    new Notifier({ api, isFocused: () => false }).notify("alice", "the secret");

    expect(shown[0].title).toBe("New message");
    expect(shown[0].body).toBe("");
  });
});
