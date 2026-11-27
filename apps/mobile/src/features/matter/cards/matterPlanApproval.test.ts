import {
  EnvironmentId,
  MessageId,
  NodeId,
  PlanId,
  ThreadId,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  approveMatterPlanMobile,
  keyedMatterPlanSteps,
  MATTER_PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  resolveMobileProposedPlanArtifact,
} from "./matterPlanApproval";

function planArtifact(
  id: string,
  status: OrchestrationV2PlanArtifact["status"],
  markdown: string,
): OrchestrationV2PlanArtifact {
  return {
    id: PlanId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: null,
    nodeId: NodeId.make("node-1"),
    status,
    kind: "proposed_plan",
    markdown,
  };
}

describe("keyedMatterPlanSteps", () => {
  it("disambiguates repeated step text with occurrence suffixes", () => {
    const keyed = keyedMatterPlanSteps([
      { text: "Run migration", done: false },
      { text: "Verify", done: true },
      { text: "Run migration", done: false },
    ]);
    expect(keyed.map((entry) => entry.key)).toEqual(["Run migration", "Verify", "Run migration#2"]);
  });
});

describe("resolveMobileProposedPlanArtifact", () => {
  it("resolves directly by planId when provided", () => {
    const plans = [
      planArtifact("plan-1", "completed", "# Plan"),
      planArtifact("plan-2", "active", "# Plan"),
    ];
    expect(
      resolveMobileProposedPlanArtifact({
        plans,
        planId: PlanId.make("plan-1"),
        markdown: "# Plan",
      })?.id,
    ).toBe("plan-1");
  });

  it("prefers an active plan matching markdown when planId is omitted", () => {
    const plans = [
      planArtifact("plan-1", "active", "# Plan"),
      planArtifact("plan-2", "superseded", "# Plan"),
    ];
    expect(resolveMobileProposedPlanArtifact({ plans, markdown: "# Plan" })?.id).toBe("plan-1");
  });

  it("falls back to matching a projected turn item when artifact markdown is stored there", () => {
    const plans = [planArtifact("plan-3", "active", "")];
    const turnItems = [
      {
        item: {
          type: "proposed_plan",
          planId: PlanId.make("plan-3"),
          markdown: "# Detailed plan",
          streaming: false,
        },
      },
    ] as unknown as ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    expect(
      resolveMobileProposedPlanArtifact({ plans, turnItems, markdown: "# Detailed plan" })?.id,
    ).toBe("plan-3");
  });
});

describe("approveMatterPlanMobile", () => {
  it("leaves plan mode, clears pending draft mode, and starts a turn with sourceProposedPlan", async () => {
    const calls: string[] = [];
    const clearDraftInteractionMode = vi.fn(() => {
      calls.push("clearDraft");
    });
    const setInteractionMode = vi.fn(async () => {
      calls.push("setInteractionMode");
      return AsyncResult.success(undefined);
    });
    const startTurn = vi.fn(async () => {
      calls.push("startTurn");
      return AsyncResult.success(undefined);
    });

    const result = await approveMatterPlanMobile({
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      planId: PlanId.make("plan-1"),
      planMarkdown: "# Ship it\n\n- Step 1",
      thread: { interactionMode: "plan", runtimeMode: "full-access" },
      messageId: MessageId.make("msg-1"),
      createdAt: "2026-11-27T12:00:00.000Z",
      clearDraftInteractionMode,
      setInteractionMode,
      startTurn,
    });

    expect(result._tag).toBe("Success");
    expect(calls).toEqual(["setInteractionMode", "clearDraft", "startTurn"]);
    expect(setInteractionMode).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: {
        threadId: "thread-1",
        interactionMode: "default",
        createdAt: "2026-11-27T12:00:00.000Z",
      },
    });
    expect(startTurn).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: {
        creationSource: "mobile",
        threadId: "thread-1",
        message: {
          messageId: "msg-1",
          role: "user",
          text: `${MATTER_PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Ship it\n\n- Step 1`,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        sourceProposedPlan: { threadId: "thread-1", planId: "plan-1" },
        dispatchMode: "queue",
      },
    });
  });

  it("skips setInteractionMode when already in default mode and aborts startTurn if mode change fails", async () => {
    const startTurn = vi.fn(async () => AsyncResult.success(undefined));
    const setInteractionMode = vi.fn(async () => AsyncResult.fail(new Error("boom")));
    const clearDraftInteractionMode = vi.fn();

    const failed = await approveMatterPlanMobile({
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      planId: PlanId.make("plan-1"),
      planMarkdown: "# Plan",
      thread: { interactionMode: "plan", runtimeMode: "full-access" },
      messageId: MessageId.make("msg-1"),
      createdAt: "2026-11-27T12:00:00.000Z",
      clearDraftInteractionMode,
      setInteractionMode,
      startTurn,
    });
    expect(failed._tag).toBe("Failure");
    expect(clearDraftInteractionMode).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();

    setInteractionMode.mockClear();
    await approveMatterPlanMobile({
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      planId: PlanId.make("plan-1"),
      planMarkdown: "# Plan",
      thread: { interactionMode: "default", runtimeMode: "full-access" },
      messageId: MessageId.make("msg-2"),
      createdAt: "2026-11-27T12:00:00.000Z",
      clearDraftInteractionMode,
      setInteractionMode,
      startTurn,
    });
    expect(setInteractionMode).not.toHaveBeenCalled();
    expect(clearDraftInteractionMode).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
  });
});
