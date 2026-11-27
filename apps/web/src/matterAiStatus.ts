import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { createContext } from "react";
import {
  deriveMatterAiStatusPhaseFrom,
  MATTER_AI_STATUS_PHASE_ICONS,
  type MatterAiStatusActivity,
  type MatterAiStatusIcon,
  type MatterAiStatusPhase,
  type MatterAiStatusRow,
} from "@t3tools/client-runtime/matter/ai-status";

import type { TimelineRow } from "./components/chat/timelineRowContext";
import { readLocalStorageValue, useLocalStorage } from "./hooks/useLocalStorage";

export const MATTER_AI_STATUS_STYLE_STORAGE_KEY = "mattr:ai-status-style:v1";

export const MatterAiStatusStyle = Schema.Literals(["default", "rareui"]);
export type MatterAiStatusStyle = typeof MatterAiStatusStyle.Type;

export const DEFAULT_MATTER_AI_STATUS_STYLE: MatterAiStatusStyle = "default";

export const MATTER_AI_STATUS_STYLES: ReadonlyArray<{
  readonly id: MatterAiStatusStyle;
  readonly name: string;
  readonly description: string;
}> = [
  {
    id: "default",
    name: msg("Default", { $context: "AI status style" }),
    description: msg("A working timer above the reply", { $context: "AI status style" }),
  },
  {
    id: "rareui",
    name: msg("RareUI", { $context: "AI status style; a component library name" }),
    description: msg("An animated icon and label for what the agent is doing right now", {
      $context: "AI status style",
    }),
  },
];

export function readMatterAiStatusStyle(): MatterAiStatusStyle {
  return readLocalStorageValue(
    MATTER_AI_STATUS_STYLE_STORAGE_KEY,
    DEFAULT_MATTER_AI_STATUS_STYLE,
    MatterAiStatusStyle,
  );
}

export function useMatterAiStatusStyle() {
  return useLocalStorage(
    MATTER_AI_STATUS_STYLE_STORAGE_KEY,
    DEFAULT_MATTER_AI_STATUS_STYLE,
    MatterAiStatusStyle,
  );
}

export type { MatterAiStatusIcon, MatterAiStatusPhase };

const MATTER_AI_STATUS_LABELS: Record<MatterAiStatusPhase, string> = {
  thinking: msg("Thinking", { $context: "AI status" }),
  searching: msg("Searching", { $context: "AI status" }),
  reading: msg("Reading", { $context: "AI status" }),
  browsing: msg("Browsing", { $context: "AI status" }),
  editing: msg("Editing", { $context: "AI status" }),
  running: msg("Running command", { $context: "AI status" }),
  delegating: msg("Delegating", { $context: "AI status" }),
  working: msg("Working", { $context: "AI status" }),
  writing: msg("Writing", { $context: "AI status" }),
  input: msg("Needs your input", { $context: "AI status" }),
  compacting: msg("Compacting", { $context: "AI status" }),
  setup: msg("Setting up worktree", { $context: "AI status" }),
};

export const MATTER_AI_STATUS_PHASES = Object.fromEntries(
  Object.entries(MATTER_AI_STATUS_PHASE_ICONS).map(([phase, visual]) => [
    phase,
    { ...visual, label: MATTER_AI_STATUS_LABELS[phase as MatterAiStatusPhase] },
  ]),
) as Record<
  MatterAiStatusPhase,
  { readonly label: string; readonly icon: MatterAiStatusIcon; readonly active: boolean }
>;

function toStatusRow(row: TimelineRow): MatterAiStatusRow {
  switch (row.kind) {
    case "working":
      return { kind: "working", compacting: row.compacting === true };
    case "work-live":
      return row.active ? { kind: "tool", entry: row.entry } : null;
    case "thinking":
      return { kind: "thinking", delegating: row.label !== undefined };
    case "message":
      return row.message.role === "assistant" && row.message.streaming
        ? { kind: "streaming-reply" }
        : null;
    default:
      return null;
  }
}

/** The live turn's phase, read from the rows after its working indicator. */
export function deriveMatterAiStatusPhase(
  rows: ReadonlyArray<TimelineRow>,
  activity: MatterAiStatusActivity,
): MatterAiStatusPhase {
  return deriveMatterAiStatusPhaseFrom(rows, toStatusRow, activity);
}

export const MatterAiStatusPhaseCtx = createContext<MatterAiStatusPhase>("thinking");

export interface MatterThinkingCoordination {
  /** Plain thinking row sits directly under the working row, which already renders RareUI Thinking. */
  readonly suppressPlainThinkingRow: boolean;
  /** A visible thinking row owns the live status (e.g. below a reply/steer or with custom content). */
  readonly thinkingRowOwnsStatus: boolean;
}

const DEFAULT_THINKING_COORDINATION: MatterThinkingCoordination = {
  suppressPlainThinkingRow: false,
  thinkingRowOwnsStatus: false,
};

/**
 * Coordinates the top working row and bottom thinking row in RareUI mode so a turn never shows
 * duplicate "Thinking" indicators (at turn start, or above and below a reply / steer).
 */
export function deriveMatterThinkingCoordination(
  rows: ReadonlyArray<TimelineRow>,
  activity: {
    readonly awaitingUser: boolean;
    readonly isPreparingWorktree: boolean;
    readonly isCompacting: boolean;
    readonly backgroundWorktreeSetup: boolean;
    readonly providerStarting: boolean;
    readonly providerStartingLabel: boolean;
    readonly liveAnswerPreview: boolean;
  },
): MatterThinkingCoordination {
  if (activity.isPreparingWorktree || activity.isCompacting) {
    return DEFAULT_THINKING_COORDINATION;
  }
  const thinkingIndex = rows.findLastIndex((row) => row.kind === "thinking");
  if (thinkingIndex < 0) return DEFAULT_THINKING_COORDINATION;
  const thinkingRow = rows[thinkingIndex];
  if (thinkingRow?.kind !== "thinking") return DEFAULT_THINKING_COORDINATION;
  // While waiting on user input/approval, the top row shows "Needs your input", not "Thinking".
  if (activity.awaitingUser) return DEFAULT_THINKING_COORDINATION;

  const isPlainThinking =
    thinkingRow.groupId === undefined &&
    thinkingRow.label === undefined &&
    !activity.providerStarting &&
    !activity.providerStartingLabel &&
    !activity.liveAnswerPreview;

  const workingIndex = rows.findIndex((row) => row.kind === "working");
  const workingRow = workingIndex >= 0 ? rows[workingIndex] : undefined;
  const immediatelyFollowsWorking =
    workingRow?.kind === "working" &&
    !workingRow.compacting &&
    !activity.backgroundWorktreeSetup &&
    thinkingIndex === workingIndex + 1;

  if (isPlainThinking && immediatelyFollowsWorking) {
    return { suppressPlainThinkingRow: true, thinkingRowOwnsStatus: false };
  }
  return { suppressPlainThinkingRow: false, thinkingRowOwnsStatus: true };
}

export const MatterThinkingCoordinationCtx = createContext<MatterThinkingCoordination>(
  DEFAULT_THINKING_COORDINATION,
);
