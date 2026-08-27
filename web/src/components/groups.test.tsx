// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatView } from "./ChatView";
import { ConversationList } from "./ConversationList";
import { SafetyPanel } from "./SafetyPanel";
import type { StoredMessage } from "../lib/store/types";

afterEach(cleanup);

const noop = () => undefined;
const idA = "a".repeat(43);
const idB = "b".repeat(43);

function listProps(overrides = {}) {
  return {
    conversations: [],
    previews: {},
    typing: new Set<string>(),
    onOpen: noop,
    onStart: noop,
    onCreateGroup: noop,
    onDelete: noop,
    ...overrides,
  };
}

describe("group creation", () => {
  it("creates a group from a list of ids", async () => {
    const onCreateGroup = vi.fn();
    render(<ConversationList {...listProps({ onCreateGroup })} />);

    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    await userEvent.type(screen.getByLabelText("Group name"), "Team");
    await userEvent.type(
      screen.getByLabelText(/Members, one ID per line/),
      `${idA}\n${idB}`,
    );
    await userEvent.click(screen.getByRole("button", { name: /create group/i }));

    expect(onCreateGroup).toHaveBeenCalledWith("Team", [idA, idB]);
  });

  it("names the offending line when one id is malformed", async () => {
    const onCreateGroup = vi.fn();
    render(<ConversationList {...listProps({ onCreateGroup })} />);

    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    await userEvent.type(screen.getByLabelText("Group name"), "Team");
    await userEvent.type(
      screen.getByLabelText(/Members, one ID per line/),
      `${idA}\nnot-an-id`,
    );
    await userEvent.click(screen.getByRole("button", { name: /create group/i }));

    expect(onCreateGroup).not.toHaveBeenCalled();
    // Failing the whole form without saying which line is wrong makes a long
    // paste impossible to debug.
    expect(screen.getByRole("alert")).toHaveTextContent("not-an-id");
  });

  it("requires a name and at least one member", async () => {
    const onCreateGroup = vi.fn();
    render(<ConversationList {...listProps({ onCreateGroup })} />);

    await userEvent.click(screen.getByRole("button", { name: "New group" }));
    await userEvent.click(screen.getByRole("button", { name: /create group/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/name/i);

    await userEvent.type(screen.getByLabelText("Group name"), "Team");
    await userEvent.click(screen.getByRole("button", { name: /create group/i }));
    expect(onCreateGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/at least one member/i);
  });

  it("marks groups apart from direct chats in the list", () => {
    render(
      <ConversationList
        {...listProps({
          conversations: [
            { id: "g-1", displayName: "Team", lastActivity: 2, unreadCount: 0, isGroup: true },
            { id: idA, displayName: "Alice", lastActivity: 1, unreadCount: 0 },
          ],
        })}
      />,
    );

    // Otherwise a group and a person are indistinguishable at a glance.
    expect(screen.getByLabelText("Group")).toBeDefined();
  });
});

describe("group chat view", () => {
  const group = {
    id: "g-1",
    displayName: "Team",
    lastActivity: 1,
    unreadCount: 0,
    isGroup: true,
  };

  function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
    return {
      id: "m1",
      conversationId: "g-1",
      direction: "incoming",
      body: "hello",
      timestamp: Date.UTC(2026, 7, 27, 12, 0),
      status: "delivered",
      ...overrides,
    };
  }

  function viewProps(overrides = {}) {
    return {
      conversation: group,
      messages: [],
      peerTyping: false,
      onBack: noop,
      onSend: noop,
      onAttach: noop,
      onTyping: noop,
      onRetry: noop,
      onDelete: noop,
      onEdit: noop,
      onDownload: noop,
      ...overrides,
    };
  }

  it("attributes each incoming message to its sender", () => {
    render(
      <ChatView
        {...viewProps({
          messages: [
            message({ id: "m1", senderId: idA, body: "from alice" }),
            message({ id: "m2", senderId: idB, body: "from bob" }),
          ],
        })}
      />,
    );

    // In a group the conversation name says nothing about who spoke.
    expect(screen.getAllByText(/^a{6}…a{4}$/)).toHaveLength(1);
    expect(screen.getAllByText(/^b{6}…b{4}$/)).toHaveLength(1);
  });

  it("does not attribute your own messages", () => {
    render(
      <ChatView
        {...viewProps({
          messages: [message({ direction: "outgoing", senderId: idA })],
        })}
      />,
    );
    expect(screen.queryByText(/^a{6}…a{4}$/)).toBeNull();
  });

  it("does not attribute messages in a direct chat", () => {
    render(
      <ChatView
        {...viewProps({
          conversation: { ...group, isGroup: false },
          messages: [message({ senderId: idA })],
        })}
      />,
    );
    // The conversation id already identifies the other party.
    expect(screen.queryByText(/^a{6}…a{4}$/)).toBeNull();
  });

  it("offers Leave only for a group", () => {
    const onLeaveGroup = vi.fn();
    const { rerender } = render(
      <ChatView {...viewProps({ onLeaveGroup })} />,
    );
    expect(screen.getByRole("button", { name: "Leave" })).toBeDefined();

    rerender(
      <ChatView
        {...viewProps({ conversation: { ...group, isGroup: false }, onLeaveGroup })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
  });

  it("says that group messages are encrypted per member", () => {
    render(<ChatView {...viewProps()} />);
    // The fan-out cost is a real property of the design; hiding it would be
    // misleading about what the client is doing on the user's behalf.
    expect(screen.getByText(/separately for each member/i)).toBeDefined();
  });
});

describe("reactions and search in the chat view", () => {
  const conversation = {
    id: "c1",
    displayName: "Alice",
    lastActivity: 1,
    unreadCount: 0,
  };

  function msg(overrides: Partial<StoredMessage> = {}): StoredMessage {
    return {
      id: "m1",
      conversationId: "c1",
      direction: "incoming",
      body: "hello",
      timestamp: Date.UTC(2026, 7, 27, 12, 0),
      status: "delivered",
      ...overrides,
    };
  }

  function props(overrides = {}) {
    return {
      conversation,
      messages: [msg()],
      peerTyping: false,
      onBack: noop,
      onSend: noop,
      onAttach: noop,
      onTyping: noop,
      onRetry: noop,
      onDelete: noop,
      onEdit: noop,
      onDownload: noop,
      ...overrides,
    };
  }

  it("shows a reaction with its count", () => {
    render(
      <ChatView
        {...props({
          messages: [msg({ reactions: { "👍": ["alice", "bob"] } })],
          selfId: "alice",
        })}
      />,
    );

    // A bare emoji hides the second person; the count is the point.
    expect(screen.getByLabelText("👍, 2 reactions")).toBeDefined();
  });

  it("marks your own reaction as pressed", () => {
    render(
      <ChatView
        {...props({
          messages: [msg({ reactions: { "👍": ["alice"] } })],
          selfId: "alice",
        })}
      />,
    );
    expect(screen.getByLabelText("👍, 1 reaction")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("toggles your own reaction off when clicked", async () => {
    const onReact = vi.fn();
    render(
      <ChatView
        {...props({
          messages: [msg({ reactions: { "👍": ["alice"] } })],
          selfId: "alice",
          onReact,
        })}
      />,
    );

    await userEvent.click(screen.getByLabelText("👍, 1 reaction"));
    expect(onReact).toHaveBeenCalledWith("m1", "👍", false);
  });

  it("adds a reaction from the picker", async () => {
    const onReact = vi.fn();
    render(<ChatView {...props({ onReact, selfId: "alice" })} />);

    await userEvent.click(screen.getByLabelText("Add a reaction"));
    await userEvent.click(screen.getByLabelText("🎉"));

    expect(onReact).toHaveBeenCalledWith("m1", "🎉", true);
  });

  it("filters the visible messages by search", async () => {
    render(
      <ChatView
        {...props({
          messages: [
            msg({ id: "a", body: "lunch tomorrow" }),
            msg({ id: "b", body: "unrelated" }),
          ],
        })}
      />,
    );

    expect(screen.getByText("unrelated")).toBeDefined();
    await userEvent.type(
      screen.getByLabelText("Search this conversation"),
      "lunch",
    );

    expect(screen.getByText("lunch tomorrow")).toBeDefined();
    expect(screen.queryByText("unrelated")).toBeNull();
  });

  it("says so when a search matches nothing", async () => {
    render(<ChatView {...props()} />);

    await userEvent.type(
      screen.getByLabelText("Search this conversation"),
      "zzzz",
    );
    // An empty list with no explanation reads as a broken conversation.
    expect(screen.getByText(/no messages match/i)).toBeDefined();
  });
});

describe("ChatView hook stability", () => {
  const conversation = {
    id: "c1",
    displayName: "Alice",
    lastActivity: 1,
    unreadCount: 0,
  };

  function props(overrides = {}) {
    return {
      conversation: undefined,
      messages: [],
      peerTyping: false,
      onBack: noop,
      onSend: noop,
      onAttach: noop,
      onTyping: noop,
      onRetry: noop,
      onDelete: noop,
      onEdit: noop,
      onDownload: noop,
      ...overrides,
    };
  }

  it("survives going from no conversation to an open one", () => {
    // The search filter was memoised below the early return for "nothing
    // selected", so opening a conversation changed the hook count and React
    // tore the tree down. Found by driving the built app in a browser; every
    // component test passed throughout, because none of them made this
    // transition.
    const { rerender } = render(<ChatView {...props()} />);
    expect(screen.getByText(/select a conversation/i)).toBeDefined();

    rerender(
      <ChatView
        {...props({
          conversation,
          messages: [
            {
              id: "m1",
              conversationId: "c1",
              direction: "incoming" as const,
              body: "hello",
              timestamp: Date.UTC(2026, 7, 27, 12, 0),
              status: "delivered" as const,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.getByLabelText("Message")).toBeDefined();
  });

  it("survives closing a conversation again", () => {
    const { rerender } = render(
      <ChatView {...props({ conversation, messages: [] })} />,
    );
    rerender(<ChatView {...props()} />);

    expect(screen.getByText(/select a conversation/i)).toBeDefined();
  });
});

describe("SafetyPanel", () => {
  const base = {
    id: "c1",
    displayName: "Alice",
    lastActivity: 1,
    unreadCount: 0,
    peerIdentityKey: "KEY-A",
  };

  const digits = "1".repeat(60);
  const load = async () => digits;

  it("warns about a changed key without being asked", () => {
    render(
      <SafetyPanel
        conversation={{ ...base, identityChangedFrom: "KEY-OLD" }}
        loadSafetyNumber={load}
        onSetVerified={noop}
        onAcknowledgeChange={noop}
      />,
    );

    // The one thing here someone needs to see even if they never think about
    // key material.
    expect(screen.getByRole("alert")).toHaveTextContent(/security key changed/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/intercepting/i);
  });

  it("shows no warning when nothing changed", () => {
    render(
      <SafetyPanel
        conversation={base}
        loadSafetyNumber={load}
        onSetVerified={noop}
        onAcknowledgeChange={noop}
      />,
    );
    // A warning that fires on ordinary use gets dismissed without reading.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("acknowledges the warning", async () => {
    const onAcknowledgeChange = vi.fn();
    render(
      <SafetyPanel
        conversation={{ ...base, identityChangedFrom: "KEY-OLD" }}
        loadSafetyNumber={load}
        onSetVerified={noop}
        onAcknowledgeChange={onAcknowledgeChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /i understand/i }));
    expect(onAcknowledgeChange).toHaveBeenCalledWith("c1");
  });

  it("shows the number grouped once opened", async () => {
    render(
      <SafetyPanel
        conversation={base}
        loadSafetyNumber={load}
        onSetVerified={noop}
        onAcknowledgeChange={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    const shown = await screen.findByText(/1{5} 1{5}/);
    // Grouping must not change the value being compared.
    expect(shown.textContent?.replace(/ /g, "")).toBe(digits);
  });

  it("reports an already verified key", () => {
    render(
      <SafetyPanel
        conversation={{ ...base, verifiedIdentityKey: "KEY-A" }}
        loadSafetyNumber={load}
        onSetVerified={noop}
        onAcknowledgeChange={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Verified" })).toBeDefined();
  });

  it("does not call a stale verification verified", () => {
    render(
      <SafetyPanel
        conversation={{ ...base, verifiedIdentityKey: "KEY-OLD" }}
        loadSafetyNumber={load}
        onSetVerified={noop}
        onAcknowledgeChange={noop}
      />,
    );

    // Verification is per-key. A contact who reinstalled has a new key, and
    // carrying the old mark over would defeat the point.
    expect(screen.getByRole("button", { name: "Verify" })).toBeDefined();
  });

  it("marks a key verified", async () => {
    const onSetVerified = vi.fn();
    render(
      <SafetyPanel
        conversation={base}
        loadSafetyNumber={load}
        onSetVerified={onSetVerified}
        onAcknowledgeChange={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await userEvent.click(
      await screen.findByRole("button", { name: /mark as verified/i }),
    );
    expect(onSetVerified).toHaveBeenCalledWith("c1", true);
  });
});
