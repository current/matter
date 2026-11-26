import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { createContext } from "react";
import { toolGroupAction } from "@t3tools/client-runtime/work-log/presentation";

import type { TimelineRow } from "./components/chat/timelineRowContext";
import { readLocalStorageValue, useLocalStorage } from "./hooks/useLocalStorage";

export const MATTR_AI_STATUS_STYLE_STORAGE_KEY = "mattr:ai-status-style:v1";

export const MattrAiStatusStyle = Schema.Literals(["default", "rareui"]);
export type MattrAiStatusStyle = typeof MattrAiStatusStyle.Type;

export const DEFAULT_MATTR_AI_STATUS_STYLE: MattrAiStatusStyle = "default";

export const MATTR_AI_STATUS_STYLES: ReadonlyArray<{
  readonly id: MattrAiStatusStyle;
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

export function readMattrAiStatusStyle(): MattrAiStatusStyle {
  return readLocalStorageValue(
    MATTR_AI_STATUS_STYLE_STORAGE_KEY,
    DEFAULT_MATTR_AI_STATUS_STYLE,
    MattrAiStatusStyle,
  );
}

export function useMattrAiStatusStyle() {
  return useLocalStorage(
    MATTR_AI_STATUS_STYLE_STORAGE_KEY,
    DEFAULT_MATTR_AI_STATUS_STYLE,
    MattrAiStatusStyle,
  );
}

/** What the agent is doing during a live turn. */
export type MattrAiStatusPhase =
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

/** The RareUI icon a status draws; `done` only ends the Settings preview. */
export type MattrAiStatusIcon =
  | "thinking"
  | "researching"
  | "analyzing"
  | "writing"
  | "input"
  | "done";

export const MATTR_AI_STATUS_PHASES: Record<
  MattrAiStatusPhase,
  { readonly label: string; readonly icon: MattrAiStatusIcon; readonly active: boolean }
> = {
  thinking: { label: msg("Thinking", { $context: "AI status" }), icon: "thinking", active: true },
  searching: {
    label: msg("Searching", { $context: "AI status" }),
    icon: "researching",
    active: true,
  },
  reading: { label: msg("Reading", { $context: "AI status" }), icon: "researching", active: true },
  browsing: {
    label: msg("Browsing", { $context: "AI status" }),
    icon: "researching",
    active: true,
  },
  editing: { label: msg("Editing", { $context: "AI status" }), icon: "writing", active: true },
  running: {
    label: msg("Running command", { $context: "AI status" }),
    icon: "analyzing",
    active: true,
  },
  delegating: {
    label: msg("Delegating", { $context: "AI status" }),
    icon: "analyzing",
    active: true,
  },
  working: { label: msg("Working", { $context: "AI status" }), icon: "analyzing", active: true },
  writing: { label: msg("Writing", { $context: "AI status" }), icon: "writing", active: true },
  input: {
    label: msg("Needs your input", { $context: "AI status" }),
    icon: "input",
    active: false,
  },
  compacting: {
    label: msg("Compacting", { $context: "AI status" }),
    icon: "analyzing",
    active: true,
  },
  setup: {
    label: msg("Setting up worktree", { $context: "AI status" }),
    icon: "analyzing",
    active: true,
  },
};

type WorkLiveRow = Extract<TimelineRow, { kind: "work-live" }>;

function toolPhase(entry: WorkLiveRow["entry"]): MattrAiStatusPhase {
  if (entry.itemType === "reasoning") return "thinking";
  switch (toolGroupAction(entry)) {
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
      return "delegating";
    default:
      return "working";
  }
}

/** The live turn's phase, read from the rows after its working indicator. */
export function deriveMattrAiStatusPhase(
  rows: ReadonlyArray<TimelineRow>,
  activity: {
    readonly awaitingUser: boolean;
    readonly compacting: boolean;
    readonly preparingWorktree: boolean;
  },
): MattrAiStatusPhase {
  if (activity.awaitingUser) return "input";
  if (activity.preparingWorktree) return "setup";
  if (activity.compacting) return "compacting";
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    switch (row.kind) {
      case "working":
        return row.compacting ? "compacting" : "thinking";
      case "work-live":
        if (row.active) return toolPhase(row.entry);
        break;
      case "thinking":
        return row.label === undefined ? "thinking" : "delegating";
      case "message":
        if (row.message.role === "assistant" && row.message.streaming) return "writing";
        break;
    }
  }
  return "thinking";
}

export const MattrAiStatusPhaseCtx = createContext<MattrAiStatusPhase>("thinking");
