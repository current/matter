import {
  DEFAULT_ISLAND_SETTINGS,
  type IslandPendingApproval,
  type IslandSnapshot,
  type IslandThreadSummary,
} from "../../../../antimatter/island/types.ts";

export function makeIslandThread(
  overrides: Partial<IslandThreadSummary> = {},
): IslandThreadSummary {
  const key = overrides.key ?? "env:thread";
  const [environmentId = "env", threadId = "thread"] = key.split(":");
  return {
    key,
    environmentId,
    threadId,
    title: `Thread ${threadId}`,
    projectTitle: null,
    status: "idle",
    updatedAt: "2026-11-26T10:00:00.000Z",
    latestUserMessage: null,
    latestAssistantMessage: null,
    toolCallCount: 0,
    isStreaming: false,
    providerInstanceId: "claudeAgent",
    providerKind: "claudeAgent",
    providerName: "Claude",
    model: null,
    branch: null,
    runStartedAt: null,
    runCompletedAt: null,
    currentActivity: null,
    recentActivities: [],
    plan: null,
    ...overrides,
  };
}

export function makeIslandApproval(
  overrides: Partial<IslandPendingApproval> = {},
): IslandPendingApproval {
  return {
    environmentId: "env",
    threadId: "thread",
    threadTitle: "Thread thread",
    requestId: "request-1",
    requestKind: "command",
    title: "Bash",
    detail: "pnpm test",
    reason: null,
    canRespond: true,
    options: [
      { decision: "accept", label: "Allow once" },
      { decision: "decline", label: "Deny" },
    ],
    ...overrides,
  };
}

export function makeIslandSnapshot(overrides: Partial<IslandSnapshot> = {}): IslandSnapshot {
  return {
    theme: "dark",
    mainWindowFocused: false,
    settings: DEFAULT_ISLAND_SETTINGS,
    doneNotifications: [],
    pendingApprovals: [],
    pendingUserInputs: [],
    pendingPlans: [],
    recentThreads: [],
    selectedThreadKey: null,
    canStartThread: true,
    canCreateTask: true,
    localEnvironmentId: "env",
    voice: {
      phase: "idle",
      level: 0,
      previewCommitted: "",
      previewTentative: "",
      draftText: "",
      draftRevision: 0,
      error: null,
      available: true,
    },
    assistant: {
      mode: "smart",
      phase: "idle",
      handsFreeActive: false,
      muted: false,
      speaking: false,
      outputLevel: 0,
      liveTranscript: "",
      statusLabel: null,
      lastReply: null,
      lastToolResults: [],
      recentTurns: [],
      activeBriefingLabel: null,
      pendingBriefingCount: 0,
      error: null,
    },
    ...overrides,
  };
}
