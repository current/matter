import {
  deriveMatterAiStatusPhaseFrom,
  MATTER_AI_STATUS_PHASE_ICONS,
  type MatterAiStatusIcon,
  type MatterAiStatusPhase,
  type MatterAiStatusRow,
} from "@t3tools/client-runtime/matter/ai-status";
import { msg } from "gt-react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import type { ThreadFeedRow } from "../../threads/pending-thread-feed";

export const MATTER_AI_STATUS_LABELS: Record<MatterAiStatusPhase, string> = {
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

/** Native stand-ins for RareUI's drawn icons; `input` is an amber dot, not a symbol. */
export const MATTER_AI_STATUS_SYMBOLS: Record<
  Exclude<MatterAiStatusIcon, "input">,
  AppSymbolName
> = {
  thinking: "brain",
  researching: "magnifyingglass",
  analyzing: "waveform",
  writing: { ios: "pencil.line", android: "edit" },
  done: "checkmark",
};

export interface MatterAiStatusFeedState {
  /** The live turn's phase; `thinking` while nothing runs. */
  readonly phase: MatterAiStatusPhase;
  /**
   * Whether the live Working row shows the AI status. A lower thinking row that carries its own
   * label owns the status instead, so the turn never shows two of them (as on web).
   */
  readonly workingRowShowsStatus: boolean;
}

export const IDLE_MATTER_AI_STATUS: MatterAiStatusFeedState = {
  phase: "thinking",
  workingRowShowsStatus: false,
};

function toStatusRow(row: ThreadFeedRow): MatterAiStatusRow {
  switch (row.type) {
    case "run-fold":
      return row.workingSince === undefined ? null : { kind: "working", compacting: false };
    case "activity-group": {
      if (
        row.activities.some(
          (activity) =>
            activity.projectedItem.item.type === "compaction" &&
            activity.projectedItem.item.status === "running",
        )
      ) {
        return { kind: "compacting" };
      }
      const live = row.activities.findLast((activity) => activity.live === true);
      return live ? { kind: "tool", entry: live.workEntry } : null;
    }
    case "work-toggle":
      return row.live && !row.expanded
        ? { kind: "tool-group", summaryKind: row.summaryKind }
        : null;
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

function isPlainThinking(row: ThreadFeedRow): boolean {
  return (
    row.type === "thinking" && row.label === undefined && row.providerStartingLabel === undefined
  );
}

/**
 * Reads the live turn's AI status off the feed, and drops a plain "Thinking" row that sits right
 * under the Working row, which already says it.
 */
export function matterAiStatusFeed<Row extends ThreadFeedRow>(
  rows: ReadonlyArray<Row>,
  activity: { readonly preparingWorktree: boolean },
): { readonly rows: ReadonlyArray<Row>; readonly status: MatterAiStatusFeedState } {
  const workingIndex = rows.findLastIndex(
    (row) => row.type === "run-fold" && row.workingSince !== undefined,
  );
  if (workingIndex < 0) return { rows, status: IDLE_MATTER_AI_STATUS };
  const phase = deriveMatterAiStatusPhaseFrom(rows, toStatusRow, {
    awaitingUser: false,
    compacting: false,
    preparingWorktree: activity.preparingWorktree,
  });
  const thinkingIndex = rows.findLastIndex((row) => row.type === "thinking");
  if (thinkingIndex < 0 || activity.preparingWorktree || phase === "compacting") {
    return { rows, status: { phase, workingRowShowsStatus: true } };
  }
  if (thinkingIndex === workingIndex + 1 && isPlainThinking(rows[thinkingIndex]!)) {
    return {
      rows: rows.filter((_, index) => index !== thinkingIndex),
      status: { phase, workingRowShowsStatus: true },
    };
  }
  return { rows, status: { phase, workingRowShowsStatus: false } };
}

export function matterAiStatusVisual(phase: MatterAiStatusPhase) {
  return MATTER_AI_STATUS_PHASE_ICONS[phase];
}
