/**
 * Desktop notifications.
 *
 * The client otherwise only tells you about a message while you are looking at
 * it, which is the moment you least need telling.
 */

export type NotificationDetail = "hidden" | "sender" | "message";

export interface NotifierOptions {
  /**
   * How much to reveal.
   *
   * Defaults to `hidden`: a notification outlives the app's own lock, sitting
   * in an OS notification centre where anyone holding the device can read it,
   * with none of the vault's protections. `sender` and `message` are offered
   * because refusing to let someone make that trade for themselves would be
   * paternalistic - but neither is the default, and the cost is stated here
   * rather than buried in a settings screen.
   */
  detail?: NotificationDetail;
  /** Injected in tests. */
  api?: typeof Notification;
  isFocused?: () => boolean;
}

export class Notifier {
  private readonly detail: NotificationDetail;
  private readonly api?: typeof Notification;
  private readonly isFocused: () => boolean;

  constructor(options: NotifierOptions = {}) {
    this.detail = options.detail ?? "hidden";
    this.api =
      options.api ??
      (typeof Notification === "undefined" ? undefined : Notification);
    this.isFocused =
      options.isFocused ??
      (() => typeof document !== "undefined" && document.hasFocus());
  }

  get available(): boolean {
    return this.api !== undefined;
  }

  get permission(): NotificationPermission | "unavailable" {
    return this.api?.permission ?? "unavailable";
  }

  /**
   * Asks for permission.
   *
   * Must be called from a user action. Prompting on load is how a browser
   * teaches someone to click "block" without reading, and there is no second
   * chance once they have.
   */
  async request(): Promise<NotificationPermission | "unavailable"> {
    if (!this.api) return "unavailable";
    if (this.api.permission !== "default") return this.api.permission;
    return this.api.requestPermission();
  }

  /**
   * Shows a notification for an incoming message.
   *
   * Silent when the window has focus: the message is already on screen, and a
   * notification for something the user is looking at is pure noise.
   */
  notify(from: string, body: string): void {
    if (!this.api || this.api.permission !== "granted") return;
    if (this.isFocused()) return;

    const title =
      this.detail === "hidden" ? "New message" : `Message from ${from}`;
    // Only `message` puts message text into the OS notification centre, and
    // only because the user asked for it.
    new this.api(title, {
      body: this.detail === "message" ? body : "",
      tag: "shatters-message",
      silent: false,
    });
  }
}
