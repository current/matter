import {
  toolGroupAction,
  type ToolGroupSummaryKind,
  type WorkLogPresentationEntry,
} from "../work-log/presentation.ts";

/** What the agent is doing during a live turn. */
export type MatterAiStatusPhase =
  | "thinking"
  | "searching"
  | "reading"
  | "browsing"
  | "editing"
  | "running"
  | "delegating"
  | "working"
  | "writing"
  | "input"
  | "compacting"
  | "setup";

/** The RareUI icon a status draws; `done` only ends the web Settings preview. */
export type MatterAiStatusIcon =
  | "thinking"
  | "researching"
  | "analyzing"
  | "writing"
  | "input"
  | "done";

/** Each phase's icon, and whether it is live work (loops) rather than a wait on the user. */
export const MATTER_AI_STATUS_PHASE_ICONS: Record<
  MatterAiStatusPhase,
  { readonly icon: MatterAiStatusIcon; readonly active: boolean }
> = {
  thinking: { icon: "thinking", active: true },
  searching: { icon: "researching", active: true },
  reading: { icon: "researching", active: true },
  browsing: { icon: "researching", active: true },
  editing: { icon: "writing", active: true },
  running: { icon: "analyzing", active: true },
  delegating: { icon: "analyzing", active: true },
  working: { icon: "analyzing", active: true },
  writing: { icon: "writing", active: true },
  input: { icon: "input", active: false },
  compacting: { icon: "analyzing", active: true },
  setup: { icon: "analyzing", active: true },
};

/** Agents think for a beat between tool calls; holding each phase keeps the label from flickering. */
export const MATTER_AI_STATUS_PHASE_HOLD_MS = 700;

/** The phase of a tool group's kind, as a collapsed group summarizes its running call. */
function matterAiStatusKindPhase(kind: ToolGroupSummaryKind): MatterAiStatusPhase {
  switch (kind) {
    case "reasoning":
      return "thinking";
    case "read":
      return "reading";
    case "search":
    case "code-search":
      return "searching";
    case "browser":
      return "browsing";
    case "edit":
      return "editing";
    case "command":
      return "running";
    case "thread-create":
    case "agent-tool":
      return "delegating";
    default:
      return "working";
  }
}

/** The phase of a running tool call or thought. */
export function matterAiStatusToolPhase(entry: WorkLogPresentationEntry): MatterAiStatusPhase {
  if (entry.itemType === "reasoning") return "thinking";
  const action = toolGroupAction(entry);
  return action === "thread-create" ? "delegating" : matterAiStatusKindPhase(action);
}

/**
 * One timeline row as the AI status reads it. Each client maps its own rows to these; `null`
 * rows say nothing about the live turn and are skipped.
 */
export type MatterAiStatusRow =
  /** The live turn's working indicator: nothing after it is active yet. */
  | { readonly kind: "working"; readonly compacting: boolean }
  /** A tool call or thought still running. */
  | { readonly kind: "tool"; readonly entry: WorkLogPresentationEntry }
  /** A collapsed tool group whose newest call still runs. */
  | { readonly kind: "tool-group"; readonly summaryKind: ToolGroupSummaryKind }
  /** The live thinking row; `delegating` when it carries a subagent's label. */
  | { readonly kind: "thinking"; readonly delegating: boolean }
  | { readonly kind: "streaming-reply" }
  | { readonly kind: "compacting" }
  | null;

export interface MatterAiStatusActivity {
  readonly awaitingUser: boolean;
  readonly compacting: boolean;
  readonly preparingWorktree: boolean;
}

/** The live turn's phase, read from the newest rows back to its working indicator. */
export function deriveMatterAiStatusPhaseFrom<Row>(
  rows: ReadonlyArray<Row>,
  toStatusRow: (row: Row) => MatterAiStatusRow,
  activity: MatterAiStatusActivity,
): MatterAiStatusPhase {
  if (activity.awaitingUser) return "input";
  if (activity.preparingWorktree) return "setup";
  if (activity.compacting) return "compacting";
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = toStatusRow(rows[index]!);
    if (row === null) continue;
    switch (row.kind) {
      case "working":
        return row.compacting ? "compacting" : "thinking";
      case "tool":
        return matterAiStatusToolPhase(row.entry);
      case "tool-group":
        return matterAiStatusKindPhase(row.summaryKind);
      case "thinking":
        return row.delegating ? "delegating" : "thinking";
      case "streaming-reply":
        return "writing";
      case "compacting":
        return "compacting";
    }
  }
  return "thinking";
}
