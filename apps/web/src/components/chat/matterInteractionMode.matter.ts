import {
  parseGoalCommand,
  type ProviderInteractionMode,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { PlanId } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { msg } from "gt-react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import type { MessageResolver } from "../../i18n/messages";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "../../proposedPlan";
import { isLatestRunSettled } from "../../session-logic";

export const MATTER_INTERACTION_MODES = [
  "default",
  "plan",
  "goal",
] as const satisfies ReadonlyArray<ProviderInteractionMode>;

/** Shift+Tab order: Default → Plan → Goal → Default. */
export function nextInteractionMode(mode: ProviderInteractionMode): ProviderInteractionMode {
  const index = MATTER_INTERACTION_MODES.indexOf(mode);
  return MATTER_INTERACTION_MODES[(index + 1) % MATTER_INTERACTION_MODES.length] ?? "default";
}

/**
 * Mirrors the server's goal-driver check (Orchestrator `goalDriverFor`): these providers run `/goal`
 * natively, so Goal mode goes through it. OpenCode has it from 2.2.5; Antigravity-style ACP agents
 * advertise it as a slash command.
 */
export function providerHasNativeGoals(
  driver: ProviderDriverKind | null,
  slashCommands: ServerProvider["slashCommands"] | undefined,
  version?: string | null,
): boolean {
  return (
    driver === "codex" ||
    driver === "claudeAgent" ||
    (driver === "opencode" && (version == null || compareSemverVersions(version, "2.2.5") >= 0)) ||
    slashCommands?.some((command) => command.name === "goal") === true
  );
}

/**
 * Whether the thread already runs a native goal: a Goal-mode turn was sent (the server saved the
 * mode) or the provider reports an unfinished goal. Until then the first Goal prompt starts one;
 * a finished goal leaves the next Goal prompt free to start another.
 */
export function threadHasNativeGoal(
  thread: Pick<EnvironmentThreadShell, "interactionMode" | "goal"> | undefined,
): boolean {
  if (thread === undefined || thread.goal?.status === "complete") return false;
  return thread.interactionMode === "goal" || (thread.goal !== null && thread.goal !== undefined);
}

/** Whether this Goal prompt starts a native goal, on a provider that runs `/goal`. */
export function startsNativeGoal(input: {
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly nativeGoalStarted: boolean;
  readonly attachmentCount: number;
}): boolean {
  const objective = input.prompt.trim();
  // The server reads `/goal` only without attachments; commands (and `/goal …`) pass through.
  return (
    input.interactionMode === "goal" &&
    !input.nativeGoalStarted &&
    input.attachmentCount === 0 &&
    objective !== "" &&
    !objective.startsWith("/")
  );
}

export function nativeGoalCommand(prompt: string): string {
  return `/goal ${prompt.trim()}`;
}

/** On a native-goal provider the first Goal prompt starts the goal as `/goal <prompt>`. */
export function withNativeGoalCommand(
  input: Parameters<typeof startsNativeGoal>[0] & { readonly nativeGoals: boolean },
): string {
  return input.nativeGoals && startsNativeGoal(input)
    ? nativeGoalCommand(input.prompt)
    : input.prompt;
}

export function isGoalClearCommand(prompt: string): boolean {
  return parseGoalCommand({ text: prompt })?.type === "clear";
}

const GOAL_SET_PREFIX = /^\s*\/goal\s+/u;

/**
 * Puts `reference` (an inline context card) in front of `prompt`, after a leading `/goal ` that
 * sets an objective: the server only reads `/goal` at the very start of the message.
 */
export function prependKeepingGoalCommand(prompt: string, reference: string): string {
  const goal = parseGoalCommand({ text: prompt });
  const prefix = goal?.type === "set" ? GOAL_SET_PREFIX.exec(prompt) : null;
  return prefix
    ? `${prefix[0]}${reference} ${prompt.slice(prefix[0].length)}`
    : `${reference} ${prompt}`;
}

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

/** What a send does with a leading `/plan`, `/goal` or `/default`. */
export type MatterInteractionModeSend =
  /** The command alone: switch modes, clear the composer, send nothing. */
  | { readonly kind: "switch"; readonly mode: ProviderInteractionMode }
  /** Send `prompt`, switching to `mode` first when it is set. */
  | {
      readonly kind: "send";
      readonly mode: ProviderInteractionMode | null;
      readonly prompt: string;
    };

const MODE_COMMAND = /^\s*\/(plan|goal|default)(?:\s+([\s\S]*))?$/iu;

export function resolveInteractionModeSend(input: {
  readonly prompt: string;
  readonly nativeGoals: boolean;
  readonly attachmentCount: number;
}): MatterInteractionModeSend | null {
  const match = MODE_COMMAND.exec(input.prompt);
  if (match === null) return null;
  const mode = match[1]!.toLowerCase() as ProviderInteractionMode;
  const rest = (match[2] ?? "").trim();
  if (mode === "goal" && input.nativeGoals) {
    // The provider runs its own goal; only setting an objective also puts the thread in Goal mode.
    const goal = parseGoalCommand({
      text: input.prompt,
      attachments: Array.from({ length: input.attachmentCount }),
    });
    if (goal !== null) {
      const mode = goal.type === "set" ? "goal" : goal.type === "clear" ? "default" : null;
      return { kind: "send", mode, prompt: input.prompt };
    }
  }
  if (rest.length === 0) {
    return input.attachmentCount > 0
      ? { kind: "send", mode, prompt: "" }
      : { kind: "switch", mode };
  }
  return { kind: "send", mode, prompt: rest };
}

/** The newest proposed plan, and the "implement" prompt an empty Plan composer sends for it. */
export interface MatterPlanImplementation {
  readonly planId: PlanId;
  readonly prompt: string;
}

/** What one send carries after reading mode commands and the Plan "implement" shortcut. */
export interface MatterModeSendResolution {
  /** Text to send; null when the send only switched modes. */
  readonly prompt: string | null;
  readonly interactionMode: ProviderInteractionMode;
  /** The composer's new mode, when the send changes it. */
  readonly switchTo: ProviderInteractionMode | null;
  /** The send starts a native goal on a provider that runs `/goal`; each target adds it. */
  readonly startsNativeGoal: boolean;
  /** The plan this send implements, so the server marks it completed. */
  readonly sourceProposedPlanId: PlanId | null;
}

export function resolveMatterModeSend(input: {
  readonly prompt: string;
  /** Direct annotation sends and queued-message edits keep their text as typed. */
  readonly bypass: boolean;
  readonly editingQueuedMessage: boolean;
  readonly interactionMode: ProviderInteractionMode;
  /** The composer's provider runs `/goal`, so `/goal clear` and friends go to it as typed. */
  readonly nativeGoals: boolean;
  /** The thread already runs a native goal, so Goal prompts steer it instead of starting one. */
  readonly nativeGoalStarted: boolean;
  readonly planImplementation: MatterPlanImplementation | null;
  readonly attachmentCount: number;
  readonly contextCount: number;
}): MatterModeSendResolution {
  const resolution = resolveModeCommandSend(input);
  return resolution.prompt === null || input.bypass || input.editingQueuedMessage
    ? resolution
    : {
        ...resolution,
        startsNativeGoal: startsNativeGoal({ ...input, ...resolution, prompt: resolution.prompt }),
      };
}

function resolveModeCommandSend(
  input: Parameters<typeof resolveMatterModeSend>[0],
): MatterModeSendResolution {
  const unchanged = {
    prompt: input.prompt,
    interactionMode: input.interactionMode,
    switchTo: null,
    startsNativeGoal: false,
    sourceProposedPlanId: null,
  };
  if (input.bypass || input.editingQueuedMessage) return unchanged;
  const command = resolveInteractionModeSend(input);
  if (command?.kind === "switch") {
    return { ...unchanged, prompt: null, interactionMode: command.mode, switchTo: command.mode };
  }
  if (command?.kind === "send") {
    return {
      ...unchanged,
      prompt: command.prompt,
      interactionMode: command.mode ?? input.interactionMode,
      switchTo: command.mode,
    };
  }
  // An empty Plan composer under a ready plan implements it, back in Default.
  if (
    input.planImplementation !== null &&
    input.prompt.trim().length === 0 &&
    input.attachmentCount === 0 &&
    input.contextCount === 0
  ) {
    return {
      ...unchanged,
      prompt: input.planImplementation.prompt,
      interactionMode: "default",
      switchTo: "default",
      sourceProposedPlanId: input.planImplementation.planId,
    };
  }
  return unchanged;
}

/** The proposed plan from the newest run that wrote one, for the "implement" prompt. */
export function latestProposedPlan(
  projection: Pick<ThreadStructure, "plans" | "runs"> | null,
): { readonly planId: PlanId; readonly markdown: string } | null {
  if (projection === null) return null;
  const runOrder = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  let latest: {
    readonly planId: PlanId;
    readonly markdown: string;
    readonly order: number;
  } | null = null;
  for (const plan of projection.plans) {
    if (plan.kind !== "proposed_plan") continue;
    const order = plan.runId === null ? -1 : (runOrder.get(plan.runId) ?? -1);
    if (latest === null || order >= latest.order) {
      latest = { planId: plan.id, markdown: plan.markdown, order };
    }
  }
  const markdown = latest?.markdown.trim() ?? "";
  return latest !== null && markdown.length > 0 ? { planId: latest.planId, markdown } : null;
}

function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

/** The composer's pending mode wins over the thread's saved one until the next send saves it. */
export function resolveComposerInteractionMode(
  composerMode: ProviderInteractionMode | null | undefined,
  threadMode: ProviderInteractionMode | null | undefined,
): ProviderInteractionMode {
  return composerMode ?? threadMode ?? "default";
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
  // Antigravity refuses `/goal clear`; leaving Goal there only switches the composer.
  const clearsNativeGoalOnExit =
    mode === "goal" && nativeGoalStarted && input.selectedProvider !== "antigravity";
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
