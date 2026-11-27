import {
  isGoalClearCommand,
  nativeGoalCommand,
  providerHasNativeGoals,
  resolveComposerInteractionMode,
  resolveMatterModeSend,
  shouldClearNativeGoalOnExit,
  threadHasNativeGoal,
  type MatterPlanImplementation,
} from "@t3tools/client-runtime/matter/interaction-mode";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  ProviderDriverKind,
  ProviderInteractionMode,
  ServerProvider,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../../i18n/messages";
import type { ComposerCommandItem } from "../../threads/ComposerCommandPopover";

const MODE_SLASH_COPY = {
  plan: msg("Plan first: research and propose a plan before editing"),
  goal: msg("Work autonomously until the task is verified complete"),
  nativeGoal: msg("Set a goal and work autonomously until it is verified complete"),
  default: msg("Back to normal interactive coding"),
} as const;

export const MATTER_INTERACTION_MODE_COPY = {
  default: {
    label: msg("Default", { $context: "composer interaction mode" }),
    description: msg("Normal interactive coding"),
  },
  plan: {
    label: msg("Plan", { $context: "composer interaction mode" }),
    description: msg("Research, ask questions, and propose a step-by-step plan before editing"),
  },
  goal: {
    label: msg("Goal", { $context: "composer interaction mode" }),
    description: msg("Autonomous end-to-end execution until verified complete"),
  },
} as const;

/**
 * Shows the Matter Shelf under-tray for real projects on both new-chat drafts and active threads,
 * collapsing the outer cradle cleanly when a thread has no project (or in scratch threads).
 */
export function shouldShowMatterMobileUnderTray(input: {
  readonly hasProject: boolean;
  readonly isScratchProject: boolean;
  readonly isQueuedEdit: boolean;
}): boolean {
  return input.hasProject && !input.isScratchProject && !input.isQueuedEdit;
}

/** Concise `Local` / `Worktree` label matching the desktop Shelf under-tray. */
export function formatMatterUnderTrayWorkspaceLabel(
  input: {
    readonly workspaceMode: "local" | "worktree";
    readonly worktreePath: string | null;
  },
  resolve: MessageResolver = m,
): string {
  return input.workspaceMode === "worktree" || input.worktreePath !== null
    ? resolve(msg("Worktree"))
    : resolve(msg("Local"));
}

/** `/plan`, `/goal` and `/default` slash menu items for mobile's command popover. */
export function matterMobileInteractionModeSlashItems(
  query: string,
  nativeGoals: boolean,
  resolve: MessageResolver = m,
): ReadonlyArray<Extract<ComposerCommandItem, { readonly type: "slash-command" }>> {
  const normalized = query.toLowerCase();
  const items: Array<Extract<ComposerCommandItem, { readonly type: "slash-command" }>> = [
    {
      id: "cmd:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: resolve(MODE_SLASH_COPY.plan),
    },
    {
      id: "cmd:goal",
      type: "slash-command",
      command: "goal",
      label: "/goal",
      description: resolve(nativeGoals ? MODE_SLASH_COPY.nativeGoal : MODE_SLASH_COPY.goal),
    },
    {
      id: "cmd:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: resolve(MODE_SLASH_COPY.default),
    },
  ];
  return items.filter((item) => item.command.includes(normalized));
}

export interface MatterMobileInteractionModeState {
  readonly mode: ProviderInteractionMode;
  readonly nativeGoals: boolean;
  readonly nativeGoalStarted: boolean;
  readonly clearsNativeGoalOnExit: boolean;
}

export function deriveMatterMobileInteractionMode(input: {
  readonly draftInteractionMode: ProviderInteractionMode | null | undefined;
  readonly thread: Pick<EnvironmentThreadShell, "interactionMode" | "goal"> | undefined;
  /** An unsent draft has no provider goal yet, whatever mode its draft carries. */
  readonly isServerThread: boolean;
  readonly provider: Pick<ServerProvider, "driver" | "slashCommands" | "version"> | null;
}): MatterMobileInteractionModeState {
  const mode = resolveComposerInteractionMode(
    input.draftInteractionMode,
    input.thread?.interactionMode,
  );
  const driver: ProviderDriverKind | null = input.provider?.driver ?? null;
  const nativeGoals = providerHasNativeGoals(
    driver,
    input.provider?.slashCommands,
    input.provider?.version,
  );
  const nativeGoalStarted =
    nativeGoals && input.isServerThread && threadHasNativeGoal(input.thread);
  const clearsNativeGoalOnExit = shouldClearNativeGoalOnExit({
    mode,
    nativeGoalStarted,
    selectedProvider: driver,
  });
  return {
    mode,
    nativeGoals,
    nativeGoalStarted,
    clearsNativeGoalOnExit,
  };
}

export type MatterMobileModeSendPlan =
  | {
      readonly kind: "switch";
      readonly nextMode: ProviderInteractionMode;
      readonly clearNativeGoal: boolean;
    }
  | {
      readonly kind: "send";
      readonly text: string;
      readonly interactionMode: ProviderInteractionMode;
      readonly switchTo: ProviderInteractionMode | null;
      readonly clearNativeGoalBeforeSend: boolean;
    };

/**
 * Resolves `/plan`, `/goal`, `/default` prefixes and native-first `/goal <prompt>` shaping for
 * mobile sends (both active threads and new-task drafts).
 */
export function resolveMatterMobileModeSend(input: {
  readonly prompt: string;
  readonly bypass: boolean;
  readonly editingQueuedMessage: boolean;
  readonly modeState: MatterMobileInteractionModeState;
  readonly attachmentCount: number;
  readonly contextCount: number;
  readonly planImplementation?: MatterPlanImplementation | null;
}): MatterMobileModeSendPlan {
  const resolution = resolveMatterModeSend({
    prompt: input.prompt,
    bypass: input.bypass,
    editingQueuedMessage: input.editingQueuedMessage,
    interactionMode: input.modeState.mode,
    nativeGoals: input.modeState.nativeGoals,
    nativeGoalStarted: input.modeState.nativeGoalStarted,
    planImplementation: input.planImplementation ?? null,
    attachmentCount: input.attachmentCount,
    contextCount: input.contextCount,
  });

  if (resolution.prompt === null) {
    const nextMode = resolution.switchTo ?? resolution.interactionMode;
    return {
      kind: "switch",
      nextMode,
      clearNativeGoal: input.modeState.clearsNativeGoalOnExit && nextMode !== input.modeState.mode,
    };
  }

  const clearNativeGoalBeforeSend =
    resolution.switchTo !== null &&
    resolution.switchTo !== input.modeState.mode &&
    input.modeState.clearsNativeGoalOnExit &&
    !isGoalClearCommand(resolution.prompt);

  const text =
    resolution.startsNativeGoal && input.modeState.nativeGoals
      ? nativeGoalCommand(resolution.prompt)
      : resolution.prompt;

  return {
    kind: "send",
    text,
    interactionMode: resolution.interactionMode,
    switchTo: resolution.switchTo,
    clearNativeGoalBeforeSend,
  };
}
