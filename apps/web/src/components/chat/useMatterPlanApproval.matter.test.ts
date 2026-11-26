import {
  EnvironmentId,
  NodeId,
  PlanId,
  ThreadId,
  type OrchestrationV2PlanArtifact,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  approveMatterPlan,
  isLatestActiveProposedPlan,
  isRecentProposedPlan,
  MATTER_PLAN_AUTO_APPROVE_FRESHNESS_MS,
} from "./useMatterPlanApproval.matter";

function proposedPlanArtifact(
  id: string,
  status: OrchestrationV2PlanArtifact["status"],
): OrchestrationV2PlanArtifact {
  return {
    id: PlanId.make(id),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: NodeId.make("node"),
    status,
    kind: "proposed_plan",
    markdown: "# Plan",
  };
}

describe("isLatestActiveProposedPlan", () => {
  it("allows only the newest active proposed plan when multiple active plans exist", () => {
    const plans: OrchestrationV2PlanArtifact[] = [
      proposedPlanArtifact("plan-1", "active"),
      proposedPlanArtifact("plan-2", "active"),
    ];
    expect(isLatestActiveProposedPlan(plans, PlanId.make("plan-1"))).toBe(false);
    expect(isLatestActiveProposedPlan(plans, PlanId.make("plan-2"))).toBe(true);
  });

  it("ignores completed, superseded, and todo_list artifacts after the latest active plan", () => {
    const plans: OrchestrationV2PlanArtifact[] = [
      proposedPlanArtifact("plan-1", "completed"),
      proposedPlanArtifact("plan-2", "active"),
      proposedPlanArtifact("plan-3", "superseded"),
      {
        id: PlanId.make("todos-1"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: NodeId.make("node"),
        status: "active",
        kind: "todo_list",
        steps: [],
      },
    ];
    expect(isLatestActiveProposedPlan(plans, PlanId.make("plan-2"))).toBe(true);
    expect(isLatestActiveProposedPlan(plans, PlanId.make("plan-1"))).toBe(false);
  });
});

describe("isRecentProposedPlan", () => {
  it("accepts plans updated within the freshness window and rejects historical ones", () => {
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    const fresh = new Date(now - 5_000).toISOString();
    const stale = new Date(now - MATTER_PLAN_AUTO_APPROVE_FRESHNESS_MS - 1_000).toISOString();

    expect(isRecentProposedPlan({ createdAt: stale, updatedAt: fresh }, now)).toBe(true);
    expect(isRecentProposedPlan({ createdAt: stale, updatedAt: stale }, now)).toBe(false);
    expect(isRecentProposedPlan({ createdAt: fresh, updatedAt: "invalid" }, now)).toBe(true);
    expect(isRecentProposedPlan({ createdAt: "invalid", updatedAt: "invalid" }, now)).toBe(false);
  });
});

describe("approveMatterPlan", () => {
  it("leaves Plan, drops a stale composer Plan pick and cites the plan", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("env-approve"),
      threadId: ThreadId.make("thread-approve"),
    };
    useComposerDraftStore.getState().setInteractionMode(threadRef, "plan");
    const commands: Array<{ readonly kind: string; readonly value: unknown }> = [];
    const ok = AsyncResult.success(undefined);
    await approveMatterPlan({
      threadRef,
      planId: PlanId.make("plan-approve"),
      planMarkdown: "# Plan",
      thread: { interactionMode: "plan", runtimeMode: "full-access" },
      setInteractionMode: async (value) => {
        commands.push({ kind: "mode", value });
        return ok;
      },
      startTurn: async (value) => {
        commands.push({ kind: "turn", value });
        return ok;
      },
    });
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.interactionMode ?? null,
    ).toBeNull();
    expect(commands.map((command) => command.kind)).toEqual(["mode", "turn"]);
    expect(commands[1]?.value).toMatchObject({
      input: {
        interactionMode: "default",
        sourceProposedPlan: { threadId: threadRef.threadId, planId: "plan-approve" },
      },
    });
  });
});
