import type { MatterPlanStep } from "@t3tools/client-runtime/matter/plan-parser";
import type {
  SetThreadInteractionModeInput,
  StartThreadTurnInput,
} from "@t3tools/client-runtime/operations";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProjectedTurnItem,
  PlanId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

export const MATTER_PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";
const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";

export type ProposedPlanArtifact = Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }>;

type Command<Input, E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<unknown, E>>;

/**
 * Keys parsed steps by text; repeated steps get an occurrence suffix so React keys stay stable.
 */
export function keyedMatterPlanSteps(
  steps: ReadonlyArray<MatterPlanStep>,
): ReadonlyArray<{ readonly key: string; readonly step: MatterPlanStep }> {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = (seen.get(step.text) ?? 0) + 1;
    seen.set(step.text, occurrence);
    return { key: occurrence > 1 ? `${step.text}#${occurrence}` : step.text, step };
  });
}

/**
 * Locates the proposed plan artifact for a rendered card. When the work log has not passed
 * `planId`, matches by markdown (preferring an active plan, then newest) or via turn items when
 * the artifact keeps its markdown in the turn item.
 */
export function resolveMobileProposedPlanArtifact(input: {
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact> | undefined;
  readonly turnItems?: ReadonlyArray<OrchestrationV2ProjectedTurnItem> | undefined;
  readonly planId?: PlanId | undefined;
  readonly markdown: string;
}): ProposedPlanArtifact | null {
  const proposedPlans = (input.plans ?? []).filter(
    (entry): entry is ProposedPlanArtifact => entry.kind === "proposed_plan",
  );
  if (proposedPlans.length === 0) return null;

  if (input.planId !== undefined) {
    return proposedPlans.find((entry) => entry.id === input.planId) ?? null;
  }

  let fallbackMatch: ProposedPlanArtifact | null = null;
  for (let i = proposedPlans.length - 1; i >= 0; i -= 1) {
    const entry = proposedPlans[i]!;
    if (entry.markdown !== input.markdown) continue;
    if (entry.status === "active") return entry;
    fallbackMatch ??= entry;
  }
  if (fallbackMatch !== null) return fallbackMatch;

  const turnItems = input.turnItems ?? [];
  for (let i = turnItems.length - 1; i >= 0; i -= 1) {
    const item = turnItems[i]?.item;
    if (item?.type !== "proposed_plan" || item.markdown !== input.markdown) continue;
    const match = proposedPlans.find((entry) => entry.id === item.planId);
    if (match) return match;
  }
  return null;
}

/**
 * Leaves plan mode (if active), clears any pending composer mode override, and queues a turn
 * referencing `sourceProposedPlan` so the server marks the plan completed.
 */
export async function approveMatterPlanMobile<E>(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly planId: PlanId;
  readonly planMarkdown: string;
  readonly thread: {
    readonly interactionMode: ProviderInteractionMode;
    readonly runtimeMode: RuntimeMode;
  };
  readonly messageId: MessageId;
  readonly createdAt: string;
  readonly clearDraftInteractionMode: () => void;
  readonly setInteractionMode: Command<SetThreadInteractionModeInput, E>;
  readonly startTurn: Command<StartThreadTurnInput, E>;
}): Promise<AtomCommandResult<unknown, E>> {
  const { environmentId, threadId, planId, thread } = input;
  if (thread.interactionMode !== DEFAULT_INTERACTION_MODE) {
    const modeResult = await input.setInteractionMode({
      environmentId,
      input: {
        threadId,
        interactionMode: DEFAULT_INTERACTION_MODE,
        createdAt: input.createdAt,
      },
    });
    if (modeResult._tag === "Failure") return modeResult;
  }
  input.clearDraftInteractionMode();
  return input.startTurn({
    environmentId,
    input: {
      creationSource: "mobile",
      threadId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: `${MATTER_PLAN_IMPLEMENTATION_PROMPT_PREFIX}${input.planMarkdown}`,
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: DEFAULT_INTERACTION_MODE,
      sourceProposedPlan: { threadId, planId },
      dispatchMode: "queue",
    },
  });
}
