import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { derivePhase } from "../../session-logic";
import { offeredPromptSuggestion } from "./usePromptSuggestion";

const now = DateTime.makeUnsafe("2026-11-26T12:00:00.000Z");
const threadId = ThreadId.make("thread-parent");
const instanceId = ProviderInstanceId.make("claudeAgent");

const run = (ordinal: number, status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RunId.make(`run-${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-opus-5-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: status === "running" ? null : now,
  checkpointId: null,
  contextHandoffId: null,
});

// The parent as the sidebar and composer see it: its own turn status plus the subagents it left.
const parentShell = (
  latest: OrchestrationV2Run,
  pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"],
) =>
  presentThreadShell(EnvironmentId.make("environment-test"), {
    id: threadId,
    projectId: "project-test",
    title: "Orchestrator",
    providerInstanceId: instanceId,
    modelSelection: latest.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: latest.id,
    activeRunId: latest.status === "running" ? latest.id : null,
    activityRunStatus: latest.status === "running" ? "running" : null,
    status: latest.status,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks,
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  } as unknown as OrchestrationV2ThreadShell);

const subagents: OrchestrationV2ThreadShell["pendingBackgroundTasks"] = [
  { kind: "subagent", taskId: "task-ribbon" },
  { kind: "subagent", taskId: "task-audit" },
];

describe("offeredPromptSuggestion while subagents run", () => {
  it("offers the parent's suggestion once its turn ends, even with subagents still running", () => {
    const turn = run(1, "completed");
    const suggestion = { runId: turn.id, text: "compact, go with that" };
    const shell = parentShell(turn, subagents);

    expect(derivePhase(shell.runtime)).toBe("ready");
    expect(offeredPromptSuggestion(suggestion, shell.latestRun, [turn])).toBe(suggestion);
  });

  it("offers it for a run that ended its turn and holds as waiting on background work", () => {
    const turn = run(1, "waiting");
    const suggestion = { runId: turn.id, text: "compact, go with that" };
    const shell = parentShell(turn, subagents);

    expect(derivePhase(shell.runtime)).toBe("ready");
    expect(offeredPromptSuggestion(suggestion, shell.latestRun, [turn])).toBe(suggestion);
  });

  it("hides it while a subagent's result wakes the parent into a new turn", () => {
    const turn = run(1, "completed");
    const wake = run(2, "running");
    const suggestion = { runId: turn.id, text: "compact, go with that" };
    // The server leaves the roster out while the parent has a live run.
    const shell = parentShell(wake, []);

    expect(derivePhase(shell.runtime)).toBe("running");
    expect(offeredPromptSuggestion(suggestion, shell.latestRun, [turn, wake])).toBeNull();

    // The wake turn's own suggestion takes over once it ends.
    const woke = run(2, "completed");
    const next = { runId: woke.id, text: "ship the ribbon" };
    expect(offeredPromptSuggestion(next, parentShell(woke, []).latestRun, [turn, woke])).toBe(next);
  });
});
