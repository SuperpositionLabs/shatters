// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatView } from "./ChatView";
import { ConversationList } from "./ConversationList";
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
