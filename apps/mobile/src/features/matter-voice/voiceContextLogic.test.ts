import { describe, expect, it } from "vite-plus/test";

import {
  MAX_VOICE_CONTEXT_THREADS,
  MAX_VOICE_HISTORY_MESSAGES,
  approvalTitle,
  buildVoiceWorkspaceContext,
  extractLatestThreadMessages,
  historyFromTurns,
  mapVoiceThreadStatus,
  trimVoiceHistory,
  type VoiceContextThreadInput,
} from "./voiceContextLogic";

const thread = (overrides: Partial<VoiceContextThreadInput> & { id: string }) =>
  ({
    environmentId: "env-1",
    title: `Thread ${overrides.id}`,
    projectId: "project-1",
    updatedAt: "2026-11-25T10:00:00.000Z",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runStatus: null,
    ...overrides,
  }) satisfies VoiceContextThreadInput;

describe("mapVoiceThreadStatus", () => {
  const base = { hasPendingApprovals: false, hasPendingUserInput: false, runStatus: null };
  it.each([
    [{ hasPendingApprovals: true, runStatus: "running" }, "approval"],
    [{ hasPendingUserInput: true, runStatus: "running" }, "input"],
    [{ limited: true, runStatus: "running" }, "limited"],
    [{ runStatus: "running" }, "running"],
    [{ runStatus: "waiting" }, "running"],
    [{ runStatus: "queued" }, "running"],
    [{ runStatus: "failed" }, "failed"],
    [{ runStatus: "completed" }, "done"],
    [{ runStatus: "interrupted" }, "idle"],
    [{ runStatus: null }, "idle"],
  ] as const)("%j → %s", (overrides, status) => {
    expect(mapVoiceThreadStatus({ ...base, ...overrides })).toBe(status);
  });
});

describe("buildVoiceWorkspaceContext", () => {
  const projects = [
    { id: "project-1", title: "mattr", workspaceRoot: "/code/mattr", archivedAt: null },
    {
      id: "project-2",
      title: "Old",
      workspaceRoot: "/code/old",
      archivedAt: "2026-01-01T00:00:00Z",
    },
  ];

  it("lists the newest unarchived threads first with project titles and status", () => {
    const context = buildVoiceWorkspaceContext({
      activeEnvironmentId: "env-1",
      activeThreadId: "b",
      activeRoute: "MattrVoiceMode",
      projects,
      threads: [
        thread({ id: "a", updatedAt: "2026-11-25T08:00:00.000Z" }),
        thread({ id: "b", updatedAt: "2026-11-25T12:00:00.000Z", runStatus: "running" }),
        thread({ id: "c", archivedAt: "2026-11-24T00:00:00Z" }),
      ],
      approvals: [],
      questions: [],
    });

    expect(context.threads.map((entry) => entry.threadId)).toEqual(["b", "a"]);
    expect(context.threads[0]).toMatchObject({
      projectTitle: "mattr",
      status: "running",
      isActive: true,
    });
    expect(context.projects.map((project) => project.archived)).toEqual([false, true]);
    expect(context.mainWindowFocused).toBe(true);
    expect(context.composerFocused).toBe(false);
  });

  it("caps the thread list", () => {
    const many = Array.from({ length: MAX_VOICE_CONTEXT_THREADS + 8 }, (_, index) =>
      thread({
        id: `t${index}`,
        updatedAt: new Date(Date.UTC(2026, 10, 25, 0, index)).toISOString(),
      }),
    );
    const context = buildVoiceWorkspaceContext({
      activeEnvironmentId: null,
      activeThreadId: null,
      activeRoute: null,
      projects,
      threads: many,
      approvals: [],
      questions: [],
    });
    expect(context.threads).toHaveLength(MAX_VOICE_CONTEXT_THREADS);
    expect(context.threads[0]?.threadId).toBe(`t${many.length - 1}`);
  });

  it("carries pending approvals and questions with their thread titles", () => {
    const context = buildVoiceWorkspaceContext({
      activeEnvironmentId: "env-1",
      activeThreadId: null,
      activeRoute: null,
      projects,
      threads: [thread({ id: "a", title: "Fix login", hasPendingApprovals: true })],
      approvals: [
        {
          environmentId: "env-1",
          threadId: "a",
          requestId: "req-1",
          requestKind: "command_execution",
          detail: "pnpm test",
        },
      ],
      questions: [
        {
          environmentId: "env-1",
          threadId: "a",
          requestId: "req-2",
          questions: [
            { id: "q1", header: "Branch", question: "Which branch?", options: [{ label: "main" }] },
          ],
        },
      ],
    });

    expect(context.pendingApprovals).toEqual([
      {
        environmentId: "env-1",
        threadId: "a",
        threadTitle: "Fix login",
        requestId: "req-1",
        requestKind: "command_execution",
        title: "Command execution",
        detail: "pnpm test",
        reason: null,
      },
    ]);
    expect(context.pendingQuestions[0]).toMatchObject({
      threadTitle: "Fix login",
      requestId: "req-2",
      questions: [{ id: "q1", options: ["main"] }],
    });
    expect(context.threads[0]?.status).toBe("approval");
  });

  it("falls back to a placeholder when a request's thread is unknown", () => {
    const context = buildVoiceWorkspaceContext({
      activeEnvironmentId: null,
      activeThreadId: null,
      activeRoute: null,
      projects: [],
      threads: [],
      approvals: [
        { environmentId: "env-9", threadId: "gone", requestId: "r", requestKind: "file_change" },
      ],
      questions: [],
    });
    expect(context.pendingApprovals[0]?.threadTitle).toBe("Untitled thread");
  });

  it("retains an older active scoped thread inside the capped thread list with its latest messages", () => {
    const newer = Array.from({ length: MAX_VOICE_CONTEXT_THREADS + 3 }, (_, index) =>
      thread({
        id: `recent-${index}`,
        updatedAt: new Date(Date.UTC(2026, 10, 25, 1, index)).toISOString(),
      }),
    );
    const activeOld = thread({
      id: "old-active",
      title: "Antimatter setup check",
      updatedAt: "2026-11-24T01:00:00.000Z",
      latestUserMessage: "Check setup",
      latestAssistantMessage: "Everything looks healthy.",
    });

    const context = buildVoiceWorkspaceContext({
      activeEnvironmentId: "env-1",
      activeThreadId: "old-active",
      activeRoute: "MattrVoiceMode",
      projects,
      threads: [...newer, activeOld],
      approvals: [],
      questions: [],
    });

    expect(context.activeThreadId).toBe("old-active");
    expect(context.threads).toHaveLength(MAX_VOICE_CONTEXT_THREADS);
    expect(context.threads[0]).toMatchObject({
      threadId: "old-active",
      title: "Antimatter setup check",
      isActive: true,
      latestUserMessage: "Check setup",
      latestAssistantMessage: "Everything looks healthy.",
    });
    expect(context.threads.slice(1).every((entry) => !entry.isActive)).toBe(true);
  });

  it("synthesizes an active thread summary when the scoped thread shell is not loaded yet", () => {
    const context = buildVoiceWorkspaceContext({
      activeEnvironmentId: "env-2",
      activeThreadId: "thread-unloaded",
      activeThreadFallbackTitle: "Voice test thread",
      activeRoute: "MattrVoiceMode",
      projects: [],
      threads: [],
      approvals: [],
      questions: [],
    });

    expect(context.threads).toHaveLength(1);
    expect(context.threads[0]).toMatchObject({
      environmentId: "env-2",
      threadId: "thread-unloaded",
      title: "Voice test thread",
      isActive: true,
    });
  });
});

describe("extractLatestThreadMessages", () => {
  it("picks the newest non-empty user and assistant messages and truncates long replies", () => {
    const extracted = extractLatestThreadMessages([
      { role: "user", text: "First prompt" },
      { role: "assistant", text: "First answer" },
      { role: "user", text: "  Second   prompt  " },
      { role: "assistant", text: "   " },
      { role: "assistant", text: "a".repeat(600) },
    ]);

    expect(extracted.latestUserMessage).toBe("Second prompt");
    expect(extracted.latestAssistantMessage).toHaveLength(520);
    expect(extracted.latestAssistantMessage?.endsWith("…")).toBe(true);
  });
});

describe("approvalTitle", () => {
  it("prefers the app name and humanizes the request kind otherwise", () => {
    expect(approvalTitle({ requestKind: "mcp_tool", appName: "Linear" })).toBe("Linear");
    expect(approvalTitle({ requestKind: "file-change" })).toBe("File change");
    expect(approvalTitle({ requestKind: "" })).toBe("Approval");
  });
});

describe("voice history", () => {
  const turn = (index: number, text = `message ${index}`) => ({
    id: `turn-${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text,
    toolBadges: index % 3 === 0 ? [{ id: `badge-${index}`, label: "Opened thread", ok: true }] : [],
  });

  it("keeps the newest messages in order", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      text: `m${index}`,
    }));
    const trimmed = trimVoiceHistory(history);
    expect(trimmed).toHaveLength(MAX_VOICE_HISTORY_MESSAGES);
    expect(trimmed[0]?.text).toBe("m8");
    expect(trimmed.at(-1)?.text).toBe("m19");
  });

  it("drops empty turns and summarizes tool use", () => {
    const history = historyFromTurns([turn(0), turn(1, "  "), turn(3)]);
    expect(history).toEqual([
      { role: "user", text: "message 0", toolSummary: "Opened thread" },
      { role: "assistant", text: "message 3", toolSummary: "Opened thread" },
    ]);
  });
});
