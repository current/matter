import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";

const MATTER_THREAD_RIBBON_STORAGE_KEY = "mattr:thread-ribbon:v1";
/** Tests keep upstream's details card, so suites that render the chat see the structure they assert on. */
export const DEFAULT_MATTER_THREAD_RIBBON = import.meta.env.MODE !== "test";

export function writeMatterThreadRibbon(enabled: boolean): void {
  writeLocalStorageValue(
    MATTER_THREAD_RIBBON_STORAGE_KEY,
    enabled,
    DEFAULT_MATTER_THREAD_RIBBON,
    Schema.Boolean,
  );
}

/** Topbar Ribbon + Whisper Pill in place of the docked Thread Details card, per device. */
export function useMatterThreadRibbonSetting() {
  return useLocalStorage(
    MATTER_THREAD_RIBBON_STORAGE_KEY,
    DEFAULT_MATTER_THREAD_RIBBON,
    Schema.Boolean,
  );
}

export function useMatterThreadRibbonEnabled(): boolean {
  return useMatterThreadRibbonSetting()[0];
}

export {
  canStopMatterSubagent,
  countMatterPreviousAgents,
  deriveMatterWhisperRows,
  isMatterWhisperActive,
  type MatterWhisperRow,
  type MatterWhisperRowKind,
  oldestMatterWhisperStart,
  stackMatterWhisperAvatars,
  uniqueMatterWhisperAgents,
} from "@t3tools/client-runtime/matter/whisper";

/**
 * How much of the Ribbon fits beside the title within the header's available content width
 * (excluding sidebar-collapse padding and titlebar controls): `condensed` moves the PR chip into
 * More, and `minimal` moves the diff too and drops Git to its icon.
 */
export type MatterRibbonDensity = "full" | "condensed" | "minimal";

export function resolveMatterRibbonDensity(availableWidth: number): MatterRibbonDensity {
  if (availableWidth >= 560) return "full";
  if (availableWidth >= 420) return "condensed";
  return "minimal";
}

export function matterRibbonOverflows(density: MatterRibbonDensity, item: "pr" | "diff"): boolean {
  if (density === "full") return false;
  if (density === "condensed") return item === "pr";
  return true;
}

export type MatterLineageView = "main" | "previous" | "sideChats" | "servers" | "automations";

interface LineagePopoverState {
  readonly threadKey: string | null;
  readonly anchor: "pill" | "ribbon";
  readonly view: MatterLineageView;
}

let lineagePopoverState: LineagePopoverState = { threadKey: null, anchor: "pill", view: "main" };
const lineageListeners = new Set<() => void>();

function setLineagePopoverState(next: LineagePopoverState) {
  lineagePopoverState = next;
  for (const listener of lineageListeners) listener();
}

function subscribeLineagePopover(listener: () => void) {
  lineageListeners.add(listener);
  return () => lineageListeners.delete(listener);
}

export function readMatterLineagePopover(): LineagePopoverState {
  return lineagePopoverState;
}

/** The thread whose Lineage popover is open, where it hangs, and which list it shows. */
export function useMatterLineagePopover(): LineagePopoverState {
  return useSyncExternalStore(
    subscribeLineagePopover,
    readMatterLineagePopover,
    readMatterLineagePopover,
  );
}

export function openMatterLineagePopover(
  threadKey: string,
  anchor: LineagePopoverState["anchor"],
  view: MatterLineageView = "main",
) {
  setLineagePopoverState({ threadKey, anchor, view });
}

export function setMatterLineageView(view: MatterLineageView) {
  if (lineagePopoverState.threadKey === null) return;
  setLineagePopoverState({ ...lineagePopoverState, view });
}

export function closeMatterLineagePopover() {
  if (lineagePopoverState.threadKey === null) return;
  setLineagePopoverState({ ...lineagePopoverState, threadKey: null, view: "main" });
}

/** The thread details shortcut: the pill while it shows, else the Ribbon's agents button. */
export function toggleMatterLineagePopover(threadKey: string, pillVisible: boolean) {
  if (lineagePopoverState.threadKey === threadKey) {
    closeMatterLineagePopover();
    return;
  }
  openMatterLineagePopover(threadKey, pillVisible ? "pill" : "ribbon");
}
