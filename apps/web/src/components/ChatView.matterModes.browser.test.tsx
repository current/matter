import "../../../../matter/composer.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it keeps its first transform out of the timeout.
import "~/components/ChatView";
import { setComposerInteractionMode } from "~/components/chat/matterInteractionMode.matter";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { responseContextRecord } from "~/lib/composerContextRecords";
import stylesheet from "~/index.css?inline";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  setFakeThreadInteractionMode,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const insertText = (text: string) => cdp().send("Input.insertText", { text });

/** Default draws nothing beside the composer's +; Plan and Goal show a pill. */
const expectMode = (mode: "default" | "plan" | "goal") =>
  vi.waitFor(() =>
    expect(
      document.querySelector<HTMLElement>("[data-matter-mode-control]")?.dataset.mode ?? "default",
    ).toBe(mode),
  );

/** The mode menu lives in the model picker's footer. */
async function chooseModeInModelPicker(name: RegExp) {
  await userEvent.click(document.querySelector<HTMLElement>("[data-chat-provider-model-picker]")!);
  await userEvent.click(page.getByRole("button", { name: "Interaction mode: Default" }));
  await userEvent.click(page.getByRole("menuitemradio", { name }));
  await userEvent.keyboard("{Escape}");
}

/** Renders the app on `thread` (Codex, a native-goal provider) with commands accepted. */
async function openThread(thread: FakeThread): Promise<AsyncDisposable> {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  await page.viewport(1400, 900);
  const environment = installFakeEnvironment([thread], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  return {
    [Symbol.asyncDispose]: async () => {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
      style.remove();
    },
  };
}

it("switches composer modes from the menu and the clear button", async () => {
  const thread = threadWithHistory("thread-matter-modes-menu", 1);
  await using _app = await openThread(thread);

  // Default draws no control in the bar; the model picker's footer → Plan, then × back.
  await chooseModeInModelPicker(/^Plan/);
  await expectMode("plan");
  await userEvent.click(page.getByRole("button", { name: "Leave Plan mode" }));
  await expectMode("default");

  // Menu → Goal.
  await chooseModeInModelPicker(/^Goal/);
  await expectMode("goal");
  await userEvent.click(page.getByRole("button", { name: "Leave Goal mode" }));
  await expectMode("default");
  // No Goal turn was sent, so leaving only switches the composer.
  expect(dispatchedCommands().filter((command) => command.type === "message.dispatch")).toEqual([]);
});

it("cycles composer modes with Shift+Tab", async () => {
  const thread = threadWithHistory("thread-matter-modes-shift-tab", 1);
  await using _app = await openThread(thread);

  // Default → Plan → Goal → Default.
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expectMode("plan");
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expectMode("goal");
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expectMode("default");
});

it("switches composer modes from the slash menu", async () => {
  const thread = threadWithHistory("thread-matter-modes-slash", 1);
  await using _app = await openThread(thread);
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);

  // Picking /plan from the slash menu switches and clears the text.
  await userEvent.keyboard("/pla");
  await userEvent.click(page.getByRole("option", { name: /\/plan/ }));
  await expectMode("plan");
  await vi.waitFor(() => expect(editor.element().textContent?.trim()).toBe(""));

  // /default from the slash menu leaves Plan.
  await userEvent.keyboard("/defa");
  await userEvent.click(page.getByRole("option", { name: /\/default/ }));
  await expectMode("default");

  // On a native-goal provider (Codex), picking /goal enters Goal and keeps `/goal ` for the objective.
  await userEvent.keyboard("/goa");
  await userEvent.click(page.getByRole("option", { name: /\/goal/ }));
  await expectMode("goal");
  await vi.waitFor(() => expect(editor.element().textContent).toContain("/goal"));
  await insertText("ship the release");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "message.dispatch", text: "/goal ship the release" }),
    ),
  );
  expect(dispatchedCommands()).toContainEqual(
    expect.objectContaining({ type: "thread.interaction-mode.set", interactionMode: "goal" }),
  );
});

it("switches to Plan and sends only the prompt for `/plan <prompt>`", async () => {
  const thread = threadWithHistory("thread-matter-modes-plan-prompt", 1);
  await using _app = await openThread(thread);

  await userEvent.click(page.getByTestId("composer-editor"));
  await insertText("/plan add dark mode");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "message.dispatch", text: "add dark mode" }),
    ),
  );
  expect(dispatchedCommands()).toContainEqual(
    expect.objectContaining({ type: "thread.interaction-mode.set", interactionMode: "plan" }),
  );
  await expectMode("plan");
});

it("starts a native goal with /goal from the first Goal prompt and steers it after", async () => {
  const thread = threadWithHistory("thread-matter-native-goal", 1);
  await using _app = await openThread(thread);
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Shift>}{Tab}{/Shift}");
  await expectMode("goal");
  await insertText("ship the release");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "message.dispatch", text: "/goal ship the release" }),
    ),
  );
});

it("clears a running native goal when leaving Goal mode", async () => {
  const thread: FakeThread = {
    ...threadWithHistory("thread-matter-goal-running", 1),
    interactionMode: "goal",
  };
  await using _app = await openThread(thread);
  await expectMode("goal");

  // A prompt in a thread already running its goal steers it as typed.
  await userEvent.click(page.getByTestId("composer-editor"));
  await insertText("also update the docs");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "message.dispatch", text: "also update the docs" }),
    ),
  );

  await userEvent.click(page.getByRole("button", { name: "Leave Goal mode" }));
  await expectMode("default");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ type: "message.dispatch", text: "/goal clear" }),
    ),
  );
  expect(dispatchedCommands()).toContainEqual(
    expect.objectContaining({ type: "thread.interaction-mode.set", interactionMode: "default" }),
  );
});

const dispatchedTexts = () =>
  dispatchedCommands().flatMap((command) =>
    command.type === "message.dispatch" ? [command.text] : [],
  );

it("starts a native goal from a brand-new draft thread left in Goal", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-matter-goal");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-matter-draft-goal"),
    });
  // The draft thread itself carries Goal, as a mode picked before the first send leaves it.
  setComposerInteractionMode(draftId, "goal");
  const launches: unknown[] = [];
  using _launch = answerRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, (input: never) => {
    launches.push(input);
    return Effect.never;
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expectMode("goal");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(page.getByTestId("composer-editor"));
  await insertText("ship the release");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(JSON.stringify(launches)).toContain('"text":"/goal ship the release"'),
  );
});

it("lets a server-side mode change show through after a Plan send", async () => {
  const thread = threadWithHistory("thread-matter-stale-plan", 1);
  await using _app = await openThread(thread);
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expectMode("plan");
  await insertText("add dark mode");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(dispatchedTexts()).toContain("add dark mode"));
  // The send saved Plan on the thread, so the composer's pending pick is gone.
  await vi.waitFor(() =>
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.interactionMode ?? null,
    ).toBeNull(),
  );
  await expectMode("plan");

  // Approving the plan (or an agent) moves the thread back to Default.
  await setFakeThreadInteractionMode(thread.id, "default");
  await expectMode("default");
});

it("keeps /goal first when the first Goal prompt replies to a message", async () => {
  const thread = threadWithHistory("thread-matter-goal-reply", 1);
  await using _app = await openThread(thread);
  const record = responseContextRecord({
    role: "assistant",
    citation: {
      version: 1,
      environmentId: EnvironmentId.make(ENVIRONMENT_ID),
      threadId: ThreadId.make(thread.id),
      messageId: MessageId.make("message-matter-reply"),
      text: "Answer to reply to",
      start: 0,
      end: 18,
      prefix: "",
      suffix: "",
    },
    itemId: TurnItemId.make("item-matter-reply"),
    subagents: [],
  });
  useComposerDraftStore.getState().setReplyTo(scopeThreadRef(ENVIRONMENT_ID, thread.id), record);
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Shift>}{Tab}{/Shift}");
  await expectMode("goal");
  await insertText("ship the release");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(dispatchedTexts().length).toBeGreaterThan(0));
  const [text] = dispatchedTexts();
  expect(text?.startsWith("/goal ")).toBe(true);
  expect(text).toContain(record.contextId);
  expect(text?.endsWith("ship the release")).toBe(true);
});

it("clears a running native goal when Shift+Tab leaves Goal mode", async () => {
  const thread: FakeThread = {
    ...threadWithHistory("thread-matter-goal-cycle", 1),
    interactionMode: "goal",
  };
  await using _app = await openThread(thread);
  await expectMode("goal");
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expectMode("default");
  await vi.waitFor(() => expect(dispatchedTexts()).toContain("/goal clear"));
  expect(dispatchedTexts().filter((text) => text === "/goal clear")).toHaveLength(1);
});
