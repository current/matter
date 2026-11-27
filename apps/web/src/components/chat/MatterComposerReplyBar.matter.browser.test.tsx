import "~/index.css";
import "../../../../../matter/composer.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { EnvironmentId, MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { responseContextRecord } from "~/lib/composerContextRecords";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { ComposerSurface } from "./ComposerSurface";
import { MatterComposerReplyBar, MatterSentReplyHeader } from "./MatterComposerReplyBar.matter";
import { clearPendingMatterMessageRevealForTests } from "./matterMessageReply.matter";

const insertText = (text: string) => cdp().send("Input.insertText", { text });

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

describe("MatterComposerReplyBar component", () => {
  it("renders crisp non-italic reply metadata inside the composer card and invokes jump & dismiss", async () => {
    const onJump = vi.fn();
    const onDismiss = vi.fn();
    const record = responseContextRecord({
      role: "assistant",
      citation: {
        version: 1,
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("msg-a-1"),
        text: "## Plan\nUse **ResponseContextRecord** with `extractReplyExcerpt()` cleanly.",
        start: 0,
        end: 70,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-a-1"),
      subagents: [],
    });

    await using _screen = await render(
      <div style={{ width: 640 }}>
        <ComposerSurface.Shell data-matter-composer="" contextRow>
          <ComposerSurface.Host>
            <ComposerSurface.Main>
              <div data-chat-composer-surface="true">
                <MatterComposerReplyBar
                  replyTo={record}
                  onJumpToMessage={onJump}
                  onDismiss={onDismiss}
                />
                <div data-chat-composer-body="true" />
              </div>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>,
      { router: false },
    );

    const bar = document.querySelector<HTMLElement>("[data-matter-reply-bar]")!;
    expect(bar).not.toBeNull();
    expect(bar.dataset.matterReplyRole).toBe("assistant");
    expect(bar.textContent).toContain("Replying to assistant");
    expect(bar.textContent).toContain(
      "Plan Use ResponseContextRecord with extractReplyExcerpt() cleanly.",
    );
    expect(getComputedStyle(bar).fontStyle).toBe("normal");
    expect(getComputedStyle(bar.querySelector("[data-matter-reply-bar-excerpt]")!).fontStyle).toBe(
      "normal",
    );

    await act(() => bar.querySelector<HTMLButtonElement>("[data-matter-reply-bar-jump]")!.click());
    expect(onJump).toHaveBeenCalledWith(record);

    await act(() =>
      bar.querySelector<HTMLButtonElement>("[data-matter-reply-bar-dismiss]")!.click(),
    );
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it("renders a compact non-italic sent reply header above a user message", async () => {
    const onJump = vi.fn();
    const record = responseContextRecord({
      role: "user",
      citation: {
        version: 1,
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("msg-u-1"),
        text: "Can we **ship** this today?",
        start: 0,
        end: 27,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-u-1"),
      subagents: [],
    });

    await using _screen = await render(
      <MatterSentReplyHeader record={record} onJumpToMessage={onJump} />,
      { router: false },
    );

    const header = document.querySelector<HTMLButtonElement>("[data-matter-reply-header]")!;
    expect(header).not.toBeNull();
    expect(header.dataset.matterReplyRole).toBe("user");
    expect(header.textContent).toContain("you");
    expect(header.textContent).toContain("Can we ship this today?");
    expect(getComputedStyle(header).fontStyle).toBe("normal");

    await act(() => header.click());
    expect(onJump).toHaveBeenCalledWith(record);
  });
});

const replyBar = () => document.querySelector<HTMLElement>("[data-matter-reply-bar]");

/** Renders the app on thread A with commands accepted; thread B is there to switch to. */
async function openReplyThreads(prefix: string) {
  await page.viewport(1400, 900);
  clearPendingMatterMessageRevealForTests();
  const threadA = threadWithHistory(`${prefix}-a`, 2);
  const threadB = threadWithHistory(`${prefix}-b`, 1);
  const environment = installFakeEnvironment([threadA, threadB], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadA.id}`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  return {
    router,
    threadA,
    threadB,
    editor,
    assistantReplyButton: page.getByRole("button", { name: "Reply to this response" }).first(),
    userReplyButton: page.getByRole("button", { name: "Reply to this message" }).first(),
    [Symbol.asyncDispose]: async () => {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
    },
  };
}

describe("in-chat Reply end-to-end flow", () => {
  it("replies to an assistant message, swaps to a user message, and cancels with Escape or ×", async () => {
    await using screen = await openReplyThreads("reply-cancel");
    const { editor, assistantReplyButton, userReplyButton } = screen;

    // Reply on an assistant message shows the reply bar and focuses the editor.
    await expect.element(assistantReplyButton).toBeVisible();
    await assistantReplyButton.click();
    await vi.waitFor(() => expect(replyBar()).not.toBeNull());
    expect(replyBar()!.dataset.matterReplyRole).toBe("assistant");
    expect(replyBar()!.textContent).toContain("Replying to assistant");
    await vi.waitFor(() =>
      expect((editor.element() as HTMLElement).contains(document.activeElement)).toBe(true),
    );

    // Reply on a user message while already replying swaps to the user target.
    await expect.element(userReplyButton).toBeVisible();
    await userReplyButton.click();
    await vi.waitFor(() => expect(replyBar()?.dataset.matterReplyRole).toBe("user"));
    expect(replyBar()!.textContent).toContain("Replying to you");
    expect(replyBar()!.dataset.matterReplyMessageId).toBeTruthy();

    // Escape in an empty draft cancels the reply.
    await userEvent.click(editor);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(replyBar()).toBeNull());

    // So does ×.
    await userReplyButton.click();
    await vi.waitFor(() => expect(replyBar()).not.toBeNull());
    await page.getByRole("button", { name: "Cancel reply" }).click();
    await vi.waitFor(() => expect(replyBar()).toBeNull());
  });

  it("keeps a reply on its own thread", async () => {
    await using screen = await openReplyThreads("reply-scope");
    const { router, threadA, threadB, assistantReplyButton } = screen;

    await assistantReplyButton.click();
    await vi.waitFor(() => expect(replyBar()?.dataset.matterReplyRole).toBe("assistant"));
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: threadB.id },
      }),
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${threadB.id}`),
    );
    expect(replyBar()).toBeNull();

    // Thread A still has its reply when we come back.
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: threadA.id },
      }),
    );
    await vi.waitFor(() => expect(replyBar()?.dataset.matterReplyRole).toBe("assistant"));
  });

  it("sends a reply with its context and jumps back from the sent reply header", async () => {
    await using screen = await openReplyThreads("reply-send");
    const { editor, userReplyButton } = screen;

    await userReplyButton.click();
    await vi.waitFor(() => expect(replyBar()?.dataset.matterReplyRole).toBe("user"));
    const targetUserMessageId = replyBar()!.dataset.matterReplyMessageId!;

    await userEvent.click(editor);
    await insertText("Following up directly on this");
    await userEvent.keyboard("{Enter}");

    // The send carries the ResponseContextRecord and the reply bar clears.
    await vi.waitFor(() => expect(replyBar()).toBeNull());
    await vi.waitFor(() => {
      const sendCommands = dispatchedCommands().filter(
        (command) => command.type === "message.dispatch",
      );
      expect(sendCommands.length).toBeGreaterThanOrEqual(1);
      const last = sendCommands.at(-1);
      expect(last?.text).toContain("Following up directly on this");
      expect(last?.context?.records).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "response", role: "user" })]),
      );
    });

    // The sent message shows a reply header above its bubble.
    await vi.waitFor(() => {
      const sentHeader = document.querySelector<HTMLButtonElement>("[data-matter-reply-header]");
      expect(sentHeader).not.toBeNull();
      expect(sentHeader!.dataset.matterReplyRole).toBe("user");
      expect(sentHeader!.dataset.matterReplyMessageId).toBe(targetUserMessageId);
      expect(sentHeader!.textContent).toContain("you");
    });

    // Clicking it highlights the original user message.
    const sentHeader = document.querySelector<HTMLButtonElement>("[data-matter-reply-header]")!;
    await act(() => sentHeader.click());
    await vi.waitFor(() => {
      const targetRow = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(targetUserMessageId)}"][data-message-role="user"]`,
      );
      expect(targetRow?.dataset.matterReplyHighlight).toBe("true");
    });
  });
});
