// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountPanel } from "./AccountPanel";
import { Composer } from "./Composer";
import { ConversationList } from "./ConversationList";
import { MessageBubble } from "./MessageBubble";
import { MIN_PASSPHRASE_LENGTH, UnlockScreen } from "./UnlockScreen";
import type { StoredMessage } from "../lib/store/types";

afterEach(cleanup);

const noop = () => undefined;
const asyncNoop = async () => undefined;

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m1",
    conversationId: "c1",
    direction: "outgoing",
    body: "hello",
    timestamp: Date.UTC(2026, 7, 27, 12, 0),
    status: "sent",
    ...overrides,
  };
}

describe("UnlockScreen", () => {
  it("refuses a short passphrase before touching the vault", async () => {
    const onCreate = vi.fn(asyncNoop);
    render(
      <UnlockScreen mode="onboarding" onCreate={onCreate} onUnlock={asyncNoop} />,
    );

    await userEvent.type(screen.getByLabelText("Passphrase"), "short");
    await userEvent.type(screen.getByLabelText("Confirm passphrase"), "short");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      String(MIN_PASSPHRASE_LENGTH),
    );
  });

  it("refuses mismatched passphrases", async () => {
    const onCreate = vi.fn(asyncNoop);
    render(
      <UnlockScreen mode="onboarding" onCreate={onCreate} onUnlock={asyncNoop} />,
    );

    await userEvent.type(screen.getByLabelText("Passphrase"), "correct horse b");
    await userEvent.type(
      screen.getByLabelText("Confirm passphrase"),
      "correct horse c",
    );
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    // There is no reset: a typo here loses the account permanently.
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/do not match/i);
  });

  it("creates an account when the passphrase is sound", async () => {
    const onCreate = vi.fn(asyncNoop);
    render(
      <UnlockScreen mode="onboarding" onCreate={onCreate} onUnlock={asyncNoop} />,
    );

    await userEvent.type(screen.getByLabelText("Passphrase"), "correct horse battery");
    await userEvent.type(
      screen.getByLabelText("Confirm passphrase"),
      "correct horse battery",
    );
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(onCreate).toHaveBeenCalledWith("correct horse battery");
  });

  it("warns that the passphrase cannot be recovered", () => {
    render(
      <UnlockScreen mode="onboarding" onCreate={asyncNoop} onUnlock={asyncNoop} />,
    );
    // The user has to know this before they choose one, not after.
    expect(screen.getByText(/no password reset/i)).toBeDefined();
  });

  it("does not ask for confirmation when unlocking", async () => {
    const onUnlock = vi.fn(asyncNoop);
    render(
      <UnlockScreen mode="unlocking" onCreate={asyncNoop} onUnlock={onUnlock} />,
    );

    expect(screen.queryByLabelText("Confirm passphrase")).toBeNull();

    await userEvent.type(screen.getByLabelText("Passphrase"), "x");
    await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
    // No minimum on unlock: the vault decides whether it is right.
    expect(onUnlock).toHaveBeenCalledWith("x");
  });

  it("surfaces an error from the caller", () => {
    render(
      <UnlockScreen
        mode="unlocking"
        error="incorrect passphrase"
        onCreate={asyncNoop}
        onUnlock={asyncNoop}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/incorrect passphrase/);
  });
});

describe("ConversationList", () => {
  const conversations = [
    { id: "a".repeat(43), displayName: "Alice", lastActivity: 2, unreadCount: 3 },
    { id: "b".repeat(43), lastActivity: 1, unreadCount: 0 },
  ];

  it("shows names, previews and unread counts", () => {
    render(
      <ConversationList
        conversations={conversations}
        previews={{ [conversations[0].id]: message({ body: "last words" }) }}
        typing={new Set()}
        onOpen={noop}
        onStart={noop}
        onCreateGroup={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByText("Alice")).toBeDefined();
    expect(screen.getByText("last words")).toBeDefined();
    expect(screen.getByLabelText("3 unread")).toBeDefined();
  });

  it("shows typing in place of the preview", () => {
    render(
      <ConversationList
        conversations={conversations}
        previews={{ [conversations[0].id]: message({ body: "last words" }) }}
        typing={new Set([conversations[0].id])}
        onOpen={noop}
        onStart={noop}
        onCreateGroup={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByText("typing…")).toBeDefined();
    expect(screen.queryByText("last words")).toBeNull();
  });

  it("rejects a malformed account id without calling out", async () => {
    const onStart = vi.fn();
    render(
      <ConversationList
        conversations={[]}
        previews={{}}
        typing={new Set()}
        onOpen={noop}
        onStart={onStart}
        onCreateGroup={noop}
        onDelete={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Account ID"), "not-an-id");
    await userEvent.click(screen.getByRole("button", { name: /start chat/i }));

    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/account ID/i);
  });

  it("starts a conversation from a pasted id with stray whitespace", async () => {
    const onStart = vi.fn();
    const id = "c".repeat(43);
    render(
      <ConversationList
        conversations={[]}
        previews={{}}
        typing={new Set()}
        onOpen={noop}
        onStart={onStart}
        onCreateGroup={noop}
        onDelete={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "New" }));
    // Copying an id out of a chat message reliably brings whitespace along.
    fireEvent.change(screen.getByLabelText("Account ID"), {
      target: { value: `  ${id}  ` },
    });
    await userEvent.type(
      screen.getByLabelText(/Name \(only on this device\)/),
      "Carol",
    );
    await userEvent.click(screen.getByRole("button", { name: /start chat/i }));

    expect(onStart).toHaveBeenCalledWith(id, "Carol");
  });

  it("says something useful when there are no conversations", () => {
    render(
      <ConversationList
        conversations={[]}
        previews={{}}
        typing={new Set()}
        onOpen={noop}
        onStart={noop}
        onCreateGroup={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText(/share your account id/i)).toBeDefined();
  });
});

describe("MessageBubble", () => {
  it("offers retry only on a failed message", () => {
    const { rerender } = render(
      <MessageBubble
        message={message({ status: "sent" })}
        onRetry={noop}
        onDelete={noop}
        onEdit={noop}
        onDownload={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    rerender(
      <MessageBubble
        message={message({ status: "failed" })}
        onRetry={noop}
        onDelete={noop}
        onEdit={noop}
        onDownload={noop}
      />,
    );
    // A failure indicator with no way to act on it is worse than none.
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("retries when asked", async () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        message={message({ status: "failed" })}
        onRetry={onRetry}
        onDelete={noop}
        onEdit={noop}
        onDownload={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("m1");
  });

  it("describes status in text, not only a glyph", () => {
    render(
      <MessageBubble
        message={message({ status: "read" })}
        onRetry={noop}
        onDelete={noop}
        onEdit={noop}
        onDownload={noop}
      />,
    );
    // ✓✓ conveys nothing to a screen reader.
    expect(screen.getByText("Read")).toBeDefined();
  });

  it("shows a tombstone rather than an empty bubble", () => {
    render(
      <MessageBubble
        message={message({ body: "", deletedAt: 5 })}
        onRetry={noop}
        onDelete={noop}
        onEdit={noop}
        onDownload={noop}
      />,
    );

    expect(screen.getByText("Message deleted")).toBeDefined();
    // Nothing to act on once it is gone.
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("edits in place and reports only a real change", async () => {
    const onEdit = vi.fn();
    render(
      <MessageBubble
        message={message()}
        onRetry={noop}
        onDelete={noop}
        onEdit={onEdit}
        onDownload={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Edit message");
    await userEvent.clear(input);
    await userEvent.type(input, "hello there");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onEdit).toHaveBeenCalledWith("m1", "hello there");
  });

  it("does not send an edit that changes nothing", async () => {
    const onEdit = vi.fn();
    render(
      <MessageBubble
        message={message()}
        onRetry={noop}
        onDelete={noop}
        onEdit={onEdit}
        onDownload={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // An edit envelope for an unchanged body is pure noise on the wire.
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("offers no edit or delete on an incoming message", () => {
    render(
      <MessageBubble
        message={message({ direction: "incoming" })}
        onRetry={noop}
        onDelete={noop}
        onEdit={noop}
        onDownload={noop}
      />,
    );

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("downloads an attachment on demand", async () => {
    const onDownload = vi.fn();
    const withFile = message({
      body: "",
      attachment: {
        name: "photo.png",
        mimeType: "image/png",
        size: 2048,
        blobRef: "r1",
      },
    });

    render(
      <MessageBubble
        message={withFile}
        onRetry={noop}
        onDelete={noop}
        onEdit={noop}
        onDownload={onDownload}
      />,
    );

    expect(screen.getByText("2.0 KB")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /photo\.png/ }));
    expect(onDownload).toHaveBeenCalledWith(withFile);
  });
});

describe("Composer", () => {
  it("sends on Enter and keeps Shift+Enter for a newline", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onAttach={noop} onTyping={noop} />);

    const input = screen.getByLabelText("Message");
    await userEvent.type(input, "hello");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("refuses to send whitespace", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onAttach={noop} onTyping={noop} />);

    await userEvent.type(screen.getByLabelText("Message"), "   ");
    await userEvent.keyboard("{Enter}");

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("clears the draft after sending", async () => {
    render(<Composer onSend={noop} onAttach={noop} onTyping={noop} />);

    const input = screen.getByLabelText("Message");
    await userEvent.type(input, "hello{Enter}");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("throttles the typing signal", async () => {
    const onTyping = vi.fn();
    render(<Composer onSend={noop} onAttach={noop} onTyping={onTyping} />);

    await userEvent.type(screen.getByLabelText("Message"), "hello world");

    // One envelope per keystroke would flood the peer for something purely
    // cosmetic.
    expect(onTyping).toHaveBeenCalledTimes(1);
  });
});

describe("AccountPanel", () => {
  it("shows the id grouped and in full", () => {
    const id = "a".repeat(43);
    render(<AccountPanel accountId={id} connection="online" onLock={noop} />);

    const code = screen.getByTitle(id);
    // Grouped for comparison, but the ungrouped value must still be present.
    expect(code.textContent).toContain(" ");
    expect(code.textContent?.replace(/ /g, "")).toBe(id);
  });

  it("copies the id without the grouping spaces", async () => {
    const id = "a".repeat(43);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<AccountPanel accountId={id} connection="online" onLock={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy ID" }));

    // Pasting the display form somewhere else would not work.
    expect(writeText).toHaveBeenCalledWith(id);
  });

  it("announces the connection state in text", () => {
    render(
      <AccountPanel accountId={"a".repeat(43)} connection="offline" onLock={noop} />,
    );
    // A coloured dot alone says nothing to a screen reader.
    expect(screen.getByText(/Connection: offline/)).toBeDefined();
  });

  it("locks when asked", async () => {
    const onLock = vi.fn();
    render(
      <AccountPanel accountId={"a".repeat(43)} connection="online" onLock={onLock} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(onLock).toHaveBeenCalled();
  });
});

describe("UnlockScreen recovery", () => {
  it("offers no way out when the error is not recoverable", () => {
    render(
      <UnlockScreen
        mode="unlocking"
        error="incorrect passphrase"
        onCreate={asyncNoop}
        onUnlock={asyncNoop}
        onReset={asyncNoop}
      />,
    );

    // A wrong passphrase is not a reason to offer to delete everything.
    expect(screen.queryByRole("button", { name: /start over/i })).toBeNull();
  });

  it("offers a way out of a vault with no account", async () => {
    render(
      <UnlockScreen
        mode="unlocking"
        error="This vault has no account on it."
        recoverable
        onCreate={asyncNoop}
        onUnlock={asyncNoop}
        onReset={asyncNoop}
      />,
    );

    // Without this the state is escapable only by clearing site data, which
    // nothing tells the user to do.
    expect(screen.getByRole("button", { name: /start over/i })).toBeDefined();
  });

  it("requires a second, informed action before destroying anything", async () => {
    const onReset = vi.fn(asyncNoop);
    render(
      <UnlockScreen
        mode="unlocking"
        error="This vault has no account on it."
        recoverable
        onCreate={asyncNoop}
        onUnlock={asyncNoop}
        onReset={onReset}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    expect(onReset).not.toHaveBeenCalled();
    // The consequence has to be stated before it happens, not after.
    expect(screen.getByText(/permanently deletes/i)).toBeDefined();
    expect(screen.getByText(/cannot be undone/i)).toBeDefined();

    await userEvent.click(
      screen.getByRole("button", { name: /delete and start over/i }),
    );
    expect(onReset).toHaveBeenCalled();
  });

  it("lets the user back out of the confirmation", async () => {
    const onReset = vi.fn(asyncNoop);
    render(
      <UnlockScreen
        mode="unlocking"
        error="This vault has no account on it."
        recoverable
        onCreate={asyncNoop}
        onUnlock={asyncNoop}
        onReset={onReset}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /start over/i }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onReset).not.toHaveBeenCalled();
    expect(screen.queryByText(/permanently deletes/i)).toBeNull();
  });
});
