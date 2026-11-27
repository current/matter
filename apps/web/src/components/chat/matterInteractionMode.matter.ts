import type {
  PlanId,
  ProviderDriverKind,
  ProviderInteractionMode,
  ServerProvider,
} from "@t3tools/contracts";
import {
  nextInteractionMode,
  providerHasNativeGoals,
  resolveComposerInteractionMode,
  shouldClearNativeGoalOnExit,
  threadHasNativeGoal,
  type MatterPlanImplementation,
} from "@t3tools/client-runtime/matter/interaction-mode";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { msg } from "gt-react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import type { MessageResolver } from "../../i18n/messages";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "../../proposedPlan";
import { isLatestRunSettled } from "../../session-logic";

const MODE_SLASH_COPY = {
  plan: msg("Plan first: research and propose a plan before editing"),
  goal: msg("Work autonomously until the task is verified complete"),
  nativeGoal: msg("Set a goal and work autonomously until it is verified complete"),
  default: msg("Back to normal interactive coding"),
} as const;

/** `/plan`, `/goal` and `/default` for the composer's slash menu. */
export function matterInteractionModeSlashItems(resolve: MessageResolver, nativeGoals: boolean) {
  return [
    {
      id: "slash:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: resolve(MODE_SLASH_COPY.plan),
    },
    {
      id: "slash:goal",
      type: "slash-command",
      command: "goal",
      label: "/goal",
      description: resolve(nativeGoals ? MODE_SLASH_COPY.nativeGoal : MODE_SLASH_COPY.goal),
    },
    {
      id: "slash:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: resolve(MODE_SLASH_COPY.default),
    },
  ] as const;
}

function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

/** Writes the composer's mode; a local draft thread keeps it too so a new thread starts in it. */
export function setComposerInteractionMode(
  target: ComposerThreadTarget,
  mode: ProviderInteractionMode,
): void {
  const store = useComposerDraftStore.getState();
  store.setInteractionMode(target, mode);
  store.setDraftThreadContext(target, { interactionMode: mode });
}

/**
 * Drops the composer's pending mode once the server thread holds `persisted`, so later server
 * changes (plan approval, `/goal clear`, an agent) show through. A newer pick is kept.
 */
export function clearPersistedComposerInteractionMode(
  target: ComposerThreadTarget,
  persisted: ProviderInteractionMode,
): void {
  const store = useComposerDraftStore.getState();
  const pending = store.getComposerDraft(target)?.interactionMode ?? null;
  if (pending === null || pending === persisted) store.setInteractionMode(target, null);
}

/** Everything the composer needs about its interaction mode, derived from the draft and the thread. */
export function deriveMatterComposerInteractionMode(input: {
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerMode: ProviderInteractionMode | null | undefined;
  readonly thread:
    | Pick<
        EnvironmentThreadShell,
        "interactionMode" | "goal" | "hasActionableProposedPlan" | "latestRun" | "runtime"
      >
    | undefined;
  /** An unsent draft has no provider goal yet, whatever mode its draft thread carries. */
  readonly isServerThread: boolean;
  readonly selectedProvider: ProviderDriverKind | null;
  readonly providerSlashCommands: ServerProvider["slashCommands"] | undefined;
  readonly providerVersion: string | null | undefined;
  readonly pendingUserInputCount: number;
  readonly latestProposedPlanId: PlanId | null | undefined;
  readonly latestProposedPlanMarkdown: string | null | undefined;
  /** Read-only and offline threads keep their mode. */
  readonly canChangeMode: boolean;
  /** Whether `/goal clear` can go out now (the thread takes sends). */
  readonly canClearNativeGoal: boolean;
  /** Clears the provider's goal and saves `next` as the thread's mode. */
  readonly onClearNativeGoal: ((next: ProviderInteractionMode) => void) | undefined;
}) {
  const mode = resolveComposerInteractionMode(input.composerMode, input.thread?.interactionMode);
  const nativeGoals = providerHasNativeGoals(
    input.selectedProvider,
    input.providerSlashCommands,
    input.providerVersion,
  );
  const nativeGoalStarted =
    nativeGoals && input.isServerThread && threadHasNativeGoal(input.thread);
  const clearsNativeGoalOnExit = shouldClearNativeGoalOnExit({
    mode,
    nativeGoalStarted,
    selectedProvider: input.selectedProvider,
  });
  const planMarkdown = input.latestProposedPlanMarkdown ?? null;
  const planId = input.latestProposedPlanId ?? null;
  const planImplementation: MatterPlanImplementation | null =
    mode === "plan" &&
    planMarkdown !== null &&
    planId !== null &&
    input.pendingUserInputCount === 0 &&
    input.thread?.hasActionableProposedPlan === true &&
    isLatestRunSettled(input.thread.latestRun, input.thread.runtime)
      ? { planId, prompt: buildPlanImplementationPrompt(planMarkdown) }
      : null;
  // Every way out of a running native goal (×, the menu, Shift+Tab, `/default`) clears it.
  const setMode = (next: ProviderInteractionMode) => {
    if (next === mode || !input.canChangeMode) return;
    setComposerInteractionMode(input.composerDraftTarget, next);
    if (clearsNativeGoalOnExit && input.canClearNativeGoal) input.onClearNativeGoal?.(next);
  };
  return {
    mode,
    nativeGoals,
    nativeGoalStarted,
    clearsNativeGoalOnExit,
    planImplementation,
    setMode,
    cycleMode: () => setMode(nextInteractionMode(mode)),
  };
}
