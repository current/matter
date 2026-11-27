import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: Children) => <div data-reply-bar="">{children}</div> },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock("../../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-symbol={name} />,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));

import { finishThreadMessageJump, pendingThreadMessageJump } from "../../threads/threadMessageJump";
import { MatterComposerReplyBar } from "./MatterComposerReplyBar.matter";
import { MatterSentReplyHeader } from "./MatterSentReplyHeader.matter";
import {
  matterReplyFor,
  replyToMatterMessage,
  resetMatterRepliesForTests,
  takeMatterReplyForSend,
} from "./matterReplies";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const threadKey = `${environmentId}:${threadId}`;

function render(node: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

function startReply(role: "user" | "assistant", text: string) {
  act(() => {
    replyToMatterMessage({
      role,
      environmentId,
      threadId,
      messageId: MessageId.make("msg-1"),
      text,
    });
  });
}

afterEach(() => {
  act(() => resetMatterRepliesForTests());
  finishThreadMessageJump(threadKey);
});

describe("MatterComposerReplyBar", () => {
  it("appears for a reply, focuses the composer, jumps and cancels", () => {
    const onFocusComposer = vi.fn();
    const view = render(
      <MatterComposerReplyBar draftKey={threadKey} onFocusComposer={onFocusComposer} />,
    );
    expect(view.container.textContent).toBe("");

    startReply("assistant", "**Done.** Updated the router.");
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("Replying to assistant");
    expect(view.container.textContent).toContain("Done. Updated the router.");

    act(() =>
      view.container
        .querySelector<HTMLButtonElement>('[aria-label^="Jump to replied message"]')!
        .click(),
    );
    expect(pendingThreadMessageJump(threadKey)).toBe("msg-1");

    act(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="Cancel reply"]')!.click(),
    );
    expect(matterReplyFor(threadKey)).toBeNull();
    expect(view.container.textContent).toBe("");
    view.unmount();
  });

  it("names you when replying to your own message", () => {
    const view = render(<MatterComposerReplyBar draftKey={threadKey} onFocusComposer={() => {}} />);
    startReply("user", "Can we refactor this?");
    expect(view.container.textContent).toContain("Replying to you");
    view.unmount();
  });
});

describe("MatterSentReplyHeader", () => {
  it("shows the replied message above a sent bubble and jumps to it", () => {
    startReply("user", "Can we refactor this?");
    const sent = takeMatterReplyForSend(threadKey, { text: "Yes", context: undefined });
    const view = render(<MatterSentReplyHeader text={sent.text} context={sent.context} />);
    expect(view.container.textContent).toBe("you·Can we refactor this?");
    act(() => view.container.querySelector("button")!.click());
    expect(pendingThreadMessageJump(threadKey)).toBe("msg-1");
    view.unmount();
  });

  it("renders nothing for a message without a leading reply", () => {
    const view = render(<MatterSentReplyHeader text="Plain" context={undefined} />);
    expect(view.container.textContent).toBe("");
    view.unmount();
  });
});
