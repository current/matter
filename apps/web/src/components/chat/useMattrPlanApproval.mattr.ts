import type { AtomCommand, AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationV2PlanArtifact,
  PlanId,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { use, useState } from "react";

import { newMessageId } from "~/lib/utils";
import { useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { useComposerDraftStore } from "../../composerDraftStore";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "../../proposedPlan";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { DEFAULT_INTERACTION_MODE, type ProposedPlan } from "../../types";
import { BackgroundThreadContext } from "./backgroundThread";
import { TimelineRowActivityCtx, TimelineRowCtx } from "./timelineRowContext";

/** Plans older than this on mount are treated as historical and do not auto-approve. */
export const MATTR_PLAN_AUTO_APPROVE_FRESHNESS_MS = 30_000;

export type MattrPlanApproveCommandResult = AtomCommandResult<unknown, unknown>;

export function isLatestActiveProposedPlan(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact> | undefined,
  planId: PlanId,
): boolean {
  if (!plans || plans.length === 0) return true;
  let latestActiveId: PlanId | null = null;
  for (const entry of plans) {
    if (entry.kind === "proposed_plan" && entry.status === "active") {
      latestActiveId = entry.id;
    }
  }
  return latestActiveId === null || latestActiveId === planId;
}

export function isRecentProposedPlan(
  plan: Pick<ProposedPlan, "createdAt" | "updatedAt">,
  nowMs: number = Date.now(),
): boolean {
  const updatedMs = Date.parse(plan.updatedAt);
  const createdMs = Date.parse(plan.createdAt);
  const latestMs = Number.isFinite(updatedMs)
    ? updatedMs
    : Number.isFinite(createdMs)
      ? createdMs
      : Number.NaN;
  if (!Number.isFinite(latestMs)) return false;
  return nowMs - latestMs <= MATTR_PLAN_AUTO_APPROVE_FRESHNESS_MS;
}

type CommandValue<C> = C extends AtomCommand<infer W, infer _A, infer _E> ? W : never;

/**
 * mattr: approving a proposed plan leaves plan mode and queues a turn that implements it.
 * `sourceProposedPlan` lets the server mark the plan completed, so its card stops offering
 * Approve.
 */
export async function approveMattrPlan(input: {
  readonly threadRef: ScopedThreadRef;
  readonly planId: PlanId;
  readonly planMarkdown: string;
  readonly thread: {
    readonly interactionMode: ProviderInteractionMode;
    readonly runtimeMode: RuntimeMode;
  };
  readonly setInteractionMode: (
    value: CommandValue<typeof threadEnvironment.setInteractionMode>,
  ) => Promise<MattrPlanApproveCommandResult>;
  readonly startTurn: (
    value: CommandValue<typeof threadEnvironment.startTurn>,
  ) => Promise<MattrPlanApproveCommandResult>;
}): Promise<MattrPlanApproveCommandResult> {
  const { threadRef, planId, thread } = input;
  const { environmentId, threadId } = threadRef;
  if (thread.interactionMode !== DEFAULT_INTERACTION_MODE) {
    const modeResult = await input.setInteractionMode({
      environmentId,
      input: {
        threadId,
        interactionMode: DEFAULT_INTERACTION_MODE,
        createdAt: new Date().toISOString(),
      },
    });
    if (modeResult._tag === "Failure") return modeResult;
  }
  // A Plan pick still pending in the composer would otherwise pull the next turn back to Plan.
  useComposerDraftStore.getState().setInteractionMode(threadRef, null);
  return input.startTurn({
    environmentId,
    input: {
      threadId,
      message: {
        messageId: newMessageId(),
        role: "user",
        text: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${input.planMarkdown}`,
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: DEFAULT_INTERACTION_MODE,
      sourceProposedPlan: { threadId, planId },
      dispatchMode: "queue",
    },
  });
}

/** Returns null where the thread cannot take a turn. */
function useMattrPlanApproval(threadRef: ScopedThreadRef | null, planId: PlanId) {
  const thread = useQuietThreadShell(threadRef);
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  if (!threadRef || !thread) return null;
  return (planMarkdown: string): Promise<MattrPlanApproveCommandResult> =>
    approveMattrPlan({ threadRef, planId, planMarkdown, thread, setInteractionMode, startTurn });
}

/** The timeline row's Approve: offered only while the plan is active and the thread idle. */
export function useMattrProposedPlanApprove(plan: ProposedPlan) {
  const { threadRef, canOperateThread } = use(TimelineRowCtx);
  const { isWorking, awaitingUser } = use(TimelineRowActivityCtx);
  const backgroundThread = use(BackgroundThreadContext);
  const threadProjection = useQuietThreadProjection(threadRef);
  const approve = useMattrPlanApproval(threadRef, plan.id);
  const [liveOrFresh, setLiveOrFresh] = useState(() => isWorking || isRecentProposedPlan(plan));

  if (!liveOrFresh && isWorking) {
    setLiveOrFresh(true);
  }

  const actionable =
    plan.status === "active" &&
    canOperateThread &&
    !isWorking &&
    !awaitingUser &&
    !backgroundThread;
  const autoApproveEligible =
    actionable &&
    liveOrFresh &&
    isLatestActiveProposedPlan(threadProjection?.projection.plans, plan.id);
  return {
    approve: actionable ? approve : null,
    autoApproveEligible,
  };
}
