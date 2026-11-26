import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";

const MATTR_THREAD_RIBBON_STORAGE_KEY = "mattr:thread-ribbon:v1";
/** Tests keep upstream's details card, so suites that render the chat see the structure they assert on. */
export const DEFAULT_MATTR_THREAD_RIBBON = import.meta.env.MODE !== "test";

export function writeMattrThreadRibbon(enabled: boolean): void {
  writeLocalStorageValue(
    MATTR_THREAD_RIBBON_STORAGE_KEY,
    enabled,
    DEFAULT_MATTR_THREAD_RIBBON,
    Schema.Boolean,
  );
}

/** Topbar Ribbon + Whisper Pill in place of the docked Thread Details card, per device. */
export function useMattrThreadRibbonSetting() {
  return useLocalStorage(
    MATTR_THREAD_RIBBON_STORAGE_KEY,
    DEFAULT_MATTR_THREAD_RIBBON,
    Schema.Boolean,
  );
}

export function useMattrThreadRibbonEnabled(): boolean {
  return useMattrThreadRibbonSetting()[0];
}

const ACTIVE_STATUSES = new Set(["pending", "running", "waiting"]);

export type MattrWhisperRowKind = OrchestrationV2PendingBackgroundTask["kind"];

export interface MattrWhisperRow {
  readonly key: string;
  readonly kind: MattrWhisperRowKind;
  readonly title: string;
  readonly status: "pending" | "running" | "waiting";
  readonly driver: ProviderDriverKind | null;
  readonly providerInstanceId: string | null;
  readonly childThreadId: ThreadId | null;
  readonly startedAtMs: number | null;
  /** What Stop interrupts: one subagent of its owning thread. */
  readonly stopTarget: {
    readonly threadId: ThreadId;
    readonly subagentId: OrchestrationV2Subagent["id"];
  } | null;
  /** A task delegated to a linked environment opens there, not here. */
  readonly remoteLabel: string | null;
}

type WhisperSubagent = Pick<
  OrchestrationV2Subagent,
  | "id"
  | "threadId"
  | "runId"
  | "origin"
  | "driver"
  | "providerInstanceId"
  | "childThreadId"
  | "remoteChild"
  | "nativeTaskRef"
  | "title"
  | "status"
  | "startedAt"
>;

/** Same rule the lineage panel uses: app-owned agents, and Claude tasks it can address by id. */
export function canStopMattrSubagent(agent: WhisperSubagent): boolean {
  if (agent.startedAt === null || !ACTIVE_STATUSES.has(agent.status)) return false;
  if (agent.origin === "app_owned") return true;
  return (
    agent.driver === "claudeAgent" &&
    agent.runId !== null &&
    agent.nativeTaskRef?.strength === "strong" &&
    agent.nativeTaskRef.nativeId !== null
  );
}

/**
 * Everything still working under a thread: its running subagents and the background commands it
 * waits on. Newest first, so the row that just started sits at the top of the list.
 */
export function deriveMattrWhisperRows(input: {
  readonly subagents: ReadonlyArray<WhisperSubagent>;
  readonly backgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly fallbackTitle: string;
}): ReadonlyArray<MattrWhisperRow> {
  const rows: MattrWhisperRow[] = [];
  const childThreadIds = new Set<string>();
  const nativeIds = new Set<string>();
  for (const agent of input.subagents) {
    if (!ACTIVE_STATUSES.has(agent.status)) continue;
    if (agent.childThreadId !== null) childThreadIds.add(agent.childThreadId);
    if (agent.nativeTaskRef?.nativeId) nativeIds.add(agent.nativeTaskRef.nativeId);
    rows.push({
      key: `subagent:${agent.id}`,
      kind: "subagent",
      title: formatSubagentDisplayTitle(agent.title?.trim() || input.fallbackTitle),
      status: agent.status as MattrWhisperRow["status"],
      driver: agent.driver,
      providerInstanceId: agent.providerInstanceId,
      childThreadId: agent.childThreadId,
      startedAtMs: agent.startedAt === null ? null : DateTime.toEpochMillis(agent.startedAt),
      stopTarget: canStopMattrSubagent(agent)
        ? { threadId: agent.threadId, subagentId: agent.id }
        : null,
      remoteLabel: agent.remoteChild?.label ?? null,
    });
  }
  for (const task of input.backgroundTasks) {
    const childThreadId = task.kind === "subagent" ? (task.childThreadId ?? null) : null;
    if (childThreadId !== null && childThreadIds.has(childThreadId)) continue;
    const taskNativeId = task.nativeItemId ?? task.taskId;
    if (nativeIds.has(taskNativeId) || nativeIds.has(task.taskId)) continue;
    const description = task.description?.trim();
    rows.push({
      key: `task:${task.taskId}`,
      kind: task.kind,
      title:
        description === undefined || description.length === 0
          ? input.fallbackTitle
          : task.kind === "subagent"
            ? formatSubagentDisplayTitle(description)
            : (description.split("\n")[0] ?? description),
      status: "running",
      driver: null,
      providerInstanceId:
        task.kind === "subagent" ? ((task.providerInstanceId as string | undefined) ?? null) : null,
      childThreadId,
      startedAtMs: null,
      stopTarget: null,
      remoteLabel: null,
    });
  }
  return rows.toSorted((left, right) => (right.startedAtMs ?? 0) - (left.startedAtMs ?? 0));
}

const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "idle"]);

/** The count on the More menu's Previous agents entry: subagents this thread already finished with. */
export function countMattrPreviousAgents(
  subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>,
): number {
  return subagents.filter((agent) => FINISHED_STATUSES.has(agent.status)).length;
}

/** The longest-running row's start, for the pill's one timer. */
export function oldestMattrWhisperStart(rows: ReadonlyArray<MattrWhisperRow>): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (row.startedAtMs !== null && (oldest === null || row.startedAtMs < oldest)) {
      oldest = row.startedAtMs;
    }
  }
  return oldest;
}

const MATTR_WHISPER_MAX_AVATARS = 3;

/**
 * The stacked avatars, oldest first in z-order: each overlaps the one after it, so the earlier
 * avatar draws on top and its status dot (top right) is never covered.
 */
export function stackMattrWhisperAvatars(
  rows: ReadonlyArray<MattrWhisperRow>,
  max = MATTR_WHISPER_MAX_AVATARS,
): ReadonlyArray<{ readonly row: MattrWhisperRow; readonly zIndex: number }> {
  const shown = rows.slice(0, max);
  return shown.map((row, index) => ({ row, zIndex: shown.length - index }));
}

export function isMattrWhisperActive(input: {
  readonly rowCount: number;
  readonly serverCount: number;
  readonly runningAutomationCount: number;
}): boolean {
  return input.rowCount > 0 || input.serverCount > 0 || input.runningAutomationCount > 0;
}

/**
 * How much of the Ribbon fits beside the title within the header's available content width
 * (excluding sidebar-collapse padding and titlebar controls): `condensed` moves the PR chip into
 * More, and `minimal` moves the diff too and drops Git to its icon.
 */
export type MattrRibbonDensity = "full" | "condensed" | "minimal";

export function resolveMattrRibbonDensity(availableWidth: number): MattrRibbonDensity {
  if (availableWidth >= 560) return "full";
  if (availableWidth >= 420) return "condensed";
  return "minimal";
}

export function mattrRibbonOverflows(density: MattrRibbonDensity, item: "pr" | "diff"): boolean {
  if (density === "full") return false;
  if (density === "condensed") return item === "pr";
  return true;
}

export type MattrLineageView = "main" | "previous" | "sideChats" | "servers" | "automations";

interface LineagePopoverState {
  readonly threadKey: string | null;
  readonly anchor: "pill" | "ribbon";
  readonly view: MattrLineageView;
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

export function readMattrLineagePopover(): LineagePopoverState {
  return lineagePopoverState;
}

/** The thread whose Lineage popover is open, where it hangs, and which list it shows. */
export function useMattrLineagePopover(): LineagePopoverState {
  return useSyncExternalStore(
    subscribeLineagePopover,
    readMattrLineagePopover,
    readMattrLineagePopover,
  );
}

export function openMattrLineagePopover(
  threadKey: string,
  anchor: LineagePopoverState["anchor"],
  view: MattrLineageView = "main",
) {
  setLineagePopoverState({ threadKey, anchor, view });
}

export function setMattrLineageView(view: MattrLineageView) {
  if (lineagePopoverState.threadKey === null) return;
  setLineagePopoverState({ ...lineagePopoverState, view });
}

export function closeMattrLineagePopover() {
  if (lineagePopoverState.threadKey === null) return;
  setLineagePopoverState({ ...lineagePopoverState, threadKey: null, view: "main" });
}

/** The thread details shortcut: the pill while it shows, else the Ribbon's agents button. */
export function toggleMattrLineagePopover(threadKey: string, pillVisible: boolean) {
  if (lineagePopoverState.threadKey === threadKey) {
    closeMattrLineagePopover();
    return;
  }
  openMattrLineagePopover(threadKey, pillVisible ? "pill" : "ribbon");
}
