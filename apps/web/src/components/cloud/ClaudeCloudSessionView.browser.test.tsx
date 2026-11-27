import {
  CLAUDE_CLOUD_THREAD_ID_PREFIX,
  ClaudeCloudTranscriptResponse,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ClaudeCloudPendingRequest,
  type ClaudeCloudRemoteSession,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { closeClaudeCloudDialog, useClaudeCloudDialog } from "../../addons/claudeCloudApi";
import { SidebarProvider } from "../ui/sidebar";
import { resetClaudeCloudStoreForTests } from "./claudeCloudStore";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("../../addons/matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => config,
}));

import { ClaudeCloudSessionView } from "./ClaudeCloudSessionView";

const SESSION_ID = "cse_01CLOUDTEST1234";
const threadId = ThreadId.make(`${CLAUDE_CLOUD_THREAD_ID_PREFIX}${SESSION_ID}`);
const encodeTranscript = Schema.encodeSync(Schema.toCodecJson(ClaudeCloudTranscriptResponse));

const at = (second: number) =>
  DateTime.makeUnsafe(new Date(Date.UTC(2026, 10, 27, 9, 0, second)).toISOString());

const base = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at(ordinal),
  completedAt: at(ordinal),
  updatedAt: at(ordinal),
});

const userItem = (id: string, ordinal: number, text: string): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  type: "user_message",
  messageId: MessageId.make(`message-${id}`),
  text,
  attachments: [],
  inputIntent: "turn_start",
  createdBy: "user",
  creationSource: "web",
});

const transcriptItems: ReadonlyArray<OrchestrationV2TurnItem> = [
  userItem("user-1", 1, "Run the test suite and fix failures."),
  {
    ...base("bash-1", 2),
    type: "command_execution",
    input: "vp test run",
    output: "214 passed",
    exitCode: 0,
  },
  {
    ...base("assistant-1", 3),
    type: "assistant_message",
    messageId: MessageId.make("message-assistant-1"),
    text: "All 214 tests pass on the branch.",
    streaming: false,
  },
];

const session = (overrides: Partial<ClaudeCloudRemoteSession> = {}): ClaudeCloudRemoteSession => ({
  id: SESSION_ID,
  url: `https://claude.ai/code/${SESSION_ID}`,
  title: "Fix flaky tests",
  instanceId: ProviderInstanceId.make("claudeAgent"),
  state: "running",
  unread: false,
  origin: "cli",
  repository: "current/matter",
  branch: "fix/flaky",
  model: "claude-opus-5-5",
  createdAt: "2026-11-27T09:00:00.000Z",
  updatedAt: "2026-11-27T09:00:03.000Z",
  summary: null,
  needsAction: null,
  contextUsage: null,
  tracked: null,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function useCloudServer(options: {
  readonly session: ClaudeCloudRemoteSession;
  readonly pendingRequest?: ClaudeCloudPendingRequest | null;
  readonly onFollowUp?: (prompt: string) => Promise<Response> | Response;
}) {
  resetClaudeCloudStoreForTests();
  let rev = 1;
  let delta: ReadonlyArray<OrchestrationV2TurnItem> = [];
  const followUps: Array<string> = [];
  const transcript = (full: boolean, turnItems: ReadonlyArray<OrchestrationV2TurnItem>) =>
    json(
      encodeTranscript({
        session: options.session,
        rev,
        full,
        turnItems,
        pendingRequest: options.pendingRequest ?? null,
        canInterrupt: true,
      }),
    );
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mattr/claude-cloud/remote-sessions") {
      return json({ sessions: [options.session], problems: [] });
    }
    if (url.pathname === `/api/mattr/claude-cloud/remote-sessions/${SESSION_ID}/transcript`) {
      if (!url.searchParams.has("sinceRev")) return transcript(true, transcriptItems);
      const items = delta;
      delta = [];
      return transcript(false, items);
    }
    if (url.pathname === "/api/mattr/claude-cloud/followup") {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      followUps.push(body.prompt);
      return options.onFollowUp
        ? options.onFollowUp(body.prompt)
        : json({ sessionId: SESSION_ID, reply: null });
    }
    return json({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    followUps,
    /** The next delta read returns these items. */
    deliver: (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
      rev += 1;
      delta = items;
    },
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      resetClaudeCloudStoreForTests();
    },
  };
}

const renderView = () => {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1000px; display: flex; flex-direction: column;";
  return render(
    <SidebarProvider>
      <ClaudeCloudSessionView sessionId={SESSION_ID} instanceId={null} />
    </SidebarProvider>,
    { container },
  );
};

describe("ClaudeCloudSessionView", () => {
  it("draws the transcript through the chat timeline with the session's state", async () => {
    using _server = useCloudServer({ session: session() });
    await using screen = await renderView();

    await expect.element(page.getByText("Run the test suite and fix failures.")).toBeVisible();
    await expect.element(page.getByText("All 214 tests pass on the branch.")).toBeVisible();
    await expect.element(page.getByText("vp test run")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Fix flaky tests" })).toBeVisible();
    const chip = screen.container.querySelector("[data-claude-cloud-header-state]");
    expect(chip?.getAttribute("data-claude-cloud-header-state")).toBe("running");
    await expect.element(page.getByText("Working", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText("current/matter", { exact: true })).toBeVisible();
    await expect.element(page.getByText("fix/flaky", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  });

  it("echoes a sent message until the transcript shows it, then shows it once", async () => {
    let release: (() => void) | null = null;
    using server = useCloudServer({
      session: session({ state: "idle" }),
      onFollowUp: () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ sessionId: SESSION_ID, reply: null }));
        }),
    });
    await using _screen = await renderView();
    await expect.element(page.getByText("All 214 tests pass on the branch.")).toBeVisible();
    await expect.element(page.getByText("Idle", { exact: true })).toBeVisible();

    const composer = page.getByRole("textbox", { name: "Reply to Claude Cloud" });
    await userEvent.fill(composer, "Ship it");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByText("Ship it", { exact: true })).toBeVisible();
    expect(document.querySelector('[data-message-id^="claude-cloud-echo-"]')).not.toBeNull();
    await expect.element(composer).toHaveValue("");
    expect(server.followUps).toEqual(["Ship it"]);

    server.deliver([userItem("user-2", 4, "Ship it")]);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-message-id="message-user-2"]')).not.toBeNull();
      expect(document.querySelector('[data-message-id^="claude-cloud-echo-"]')).toBeNull();
    });
    await expect.element(page.getByText("Ship it", { exact: true })).toBeVisible();
    expect(page.getByText("Ship it", { exact: true }).elements()).toHaveLength(1);
  });

  it("drops the echo and shows the error when a send fails", async () => {
    using _server = useCloudServer({
      session: session({ state: "idle" }),
      onFollowUp: () => json({ error: "cli_failed", detail: "The CLI exited." }, 502),
    });
    await using _screen = await renderView();
    await expect.element(page.getByText("All 214 tests pass on the branch.")).toBeVisible();

    const composer = page.getByRole("textbox", { name: "Reply to Claude Cloud" });
    await userEvent.fill(composer, "Try again please");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByText("Couldn't send your message")).toBeVisible();
    await expect.element(page.getByText("The CLI exited.", { exact: true })).toBeInTheDocument();
    await expect.element(composer).toHaveValue("Try again please");
  });

  it("explains a pending request and links to claude.ai to answer it", async () => {
    using _server = useCloudServer({
      session: session({ state: "needs_input", needsAction: "Approve running migrations." }),
      pendingRequest: {
        kind: "permission",
        title: "Allow Bash: vp run migrate",
        detail: "Claude wants to run database migrations.",
      },
    });
    await using screen = await renderView();

    await expect.element(page.getByText("Allow Bash: vp run migrate")).toBeVisible();
    await expect.element(page.getByText("Claude wants to run database migrations.")).toBeVisible();
    await expect.element(page.getByText("Approve running migrations.")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Answer on claude.ai" }))
      .toHaveAttribute("href", `https://claude.ai/code/${SESSION_ID}`);
    expect(
      screen.container
        .querySelector("[data-claude-cloud-header-state]")
        ?.getAttribute("data-claude-cloud-header-state"),
    ).toBe("needs_input");
  });

  it("lets a plain reply answer a turn that ended on a question", async () => {
    using _server = useCloudServer({
      session: session({ state: "needs_input", needsAction: "Check the settings page." }),
    });
    await using _screen = await renderView();
    await expect
      .element(page.getByRole("textbox", { name: "Reply to Claude Cloud" }))
      .toBeEnabled();
    await expect.element(page.getByText("Answer on claude.ai")).not.toBeInTheDocument();
  });

  it("disables the composer for an archived session", async () => {
    using _server = useCloudServer({ session: session({ state: "archived" }) });
    await using _screen = await renderView();
    await expect.element(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Reply to Claude Cloud" }))
      .toBeDisabled();
  });

  it("opens the teleport dialog prefilled from the Bring it back header button", async () => {
    const projectId = ProjectId.make("project-1");
    function DialogObserver() {
      return (
        <output data-testid="dialog-observer">{JSON.stringify(useClaudeCloudDialog())}</output>
      );
    }
    using _server = useCloudServer({
      session: session({
        tracked: {
          id: SESSION_ID,
          url: `https://claude.ai/code/${SESSION_ID}`,
          title: "Fix flaky tests",
          promptPreview: "Run tests",
          instanceId: ProviderInstanceId.make("claudeAgent"),
          projectId,
          cwd: "/repo",
          branch: "fix/flaky",
          createdBy: "user",
          sourceThreadId: null,
          reason: null,
          createdAt: "2026-11-27T09:00:00.000Z",
          lastMessageAt: null,
          lastReplyPreview: null,
          teleportedThreadId: null,
          teleportedWorktreePath: null,
        },
      }),
    });
    const container = document.createElement("div");
    container.style.cssText =
      "height: 900px; width: 1000px; display: flex; flex-direction: column;";
    await using _screen = await render(
      <SidebarProvider>
        <DialogObserver />
        <ClaudeCloudSessionView sessionId={SESSION_ID} instanceId={null} />
      </SidebarProvider>,
      { container },
    );

    const button = page.getByRole("button", { name: "Bring it back" });
    await expect.element(button).toBeVisible();
    await userEvent.click(button);

    expect(JSON.parse(page.getByTestId("dialog-observer").element().textContent ?? "null")).toEqual(
      {
        mode: "teleport",
        sessionId: SESSION_ID,
        projectId,
        threadId: null,
        instanceId: ProviderInstanceId.make("claudeAgent"),
      },
    );
    closeClaudeCloudDialog();
  });
});
