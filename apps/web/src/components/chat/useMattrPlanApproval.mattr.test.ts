import { NodeId, PlanId, ThreadId, type OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isLatestActiveProposedPlan,
  isRecentProposedPlan,
  MATTR_PLAN_AUTO_APPROVE_FRESHNESS_MS,
} from "./useMattrPlanApproval.mattr";

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
    const stale = new Date(now - MATTR_PLAN_AUTO_APPROVE_FRESHNESS_MS - 1_000).toISOString();

    expect(isRecentProposedPlan({ createdAt: stale, updatedAt: fresh }, now)).toBe(true);
    expect(isRecentProposedPlan({ createdAt: stale, updatedAt: stale }, now)).toBe(false);
    expect(isRecentProposedPlan({ createdAt: fresh, updatedAt: "invalid" }, now)).toBe(true);
    expect(isRecentProposedPlan({ createdAt: "invalid", updatedAt: "invalid" }, now)).toBe(false);
  });
});
