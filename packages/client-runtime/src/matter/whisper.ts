import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatSubagentDisplayTitle } from "../state/subagentDisplay.ts";

const ACTIVE_STATUSES = new Set(["pending", "running", "waiting"]);

export type MatterWhisperRowKind = OrchestrationV2PendingBackgroundTask["kind"];

export interface MatterWhisperRow {
  readonly key: string;
  readonly kind: MatterWhisperRowKind;
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

export type MatterWhisperSubagent = Pick<
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
export function canStopMatterSubagent(agent: MatterWhisperSubagent): boolean {
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
export function deriveMatterWhisperRows(input: {
  readonly subagents: ReadonlyArray<MatterWhisperSubagent>;
  readonly backgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly fallbackTitle: string;
}): ReadonlyArray<MatterWhisperRow> {
  const rows: MatterWhisperRow[] = [];
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
      status: agent.status as MatterWhisperRow["status"],
      driver: agent.driver,
      providerInstanceId: agent.providerInstanceId,
      childThreadId: agent.childThreadId,
      startedAtMs: agent.startedAt === null ? null : DateTime.toEpochMillis(agent.startedAt),
      stopTarget: canStopMatterSubagent(agent)
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
  return [...rows].sort((left, right) => (right.startedAtMs ?? 0) - (left.startedAtMs ?? 0));
}

const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "idle"]);

/** Subagents this thread already finished with: desktop's Previous agents, mobile's Agents row. */
export function countMatterPreviousAgents(
  subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>,
): number {
  return subagents.filter((agent) => FINISHED_STATUSES.has(agent.status)).length;
}

/** The longest-running row's start, for the pill's one timer. */
export function oldestMatterWhisperStart(rows: ReadonlyArray<MatterWhisperRow>): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (row.startedAtMs !== null && (oldest === null || row.startedAtMs < oldest)) {
      oldest = row.startedAtMs;
    }
  }
  return oldest;
}

const MATTER_WHISPER_MAX_AVATARS = 3;

/**
 * The stacked avatars, oldest first in z-order: each overlaps the one after it, so the earlier
 * avatar draws on top and its status dot (top right) is never covered.
 */
export function stackMatterWhisperAvatars(
  rows: ReadonlyArray<MatterWhisperRow>,
  max = MATTER_WHISPER_MAX_AVATARS,
): ReadonlyArray<{ readonly row: MatterWhisperRow; readonly zIndex: number }> {
  const shown = rows.slice(0, max);
  return shown.map((row, index) => ({ row, zIndex: shown.length - index }));
}

/** The pill's avatars name who is working, not how many: one per agent kind. */
export function uniqueMatterWhisperAgents(
  rows: ReadonlyArray<MatterWhisperRow>,
  agentOf: (row: MatterWhisperRow) => string,
): ReadonlyArray<MatterWhisperRow> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const agent = agentOf(row);
    if (seen.has(agent)) return false;
    seen.add(agent);
    return true;
  });
}

export function isMatterWhisperActive(input: {
  readonly rowCount: number;
  readonly serverCount: number;
  readonly runningAutomationCount: number;
}): boolean {
  return input.rowCount > 0 || input.serverCount > 0 || input.runningAutomationCount > 0;
}

export type MatterWhisperSegmentKind = "agents" | "commands" | "servers" | "automations";

export interface MatterWhisperSegments {
  readonly agents: ReadonlyArray<MatterWhisperRow>;
  readonly commands: ReadonlyArray<MatterWhisperRow>;
  readonly serverCount: number;
  readonly runningAutomationCount: number;
  /** What the pill shows, in order; empty when nothing runs, which hides the pill. */
  readonly segments: ReadonlyArray<MatterWhisperSegmentKind>;
}

/**
 * The phone's pill splits the desktop pill's one popover into tappable segments, each opening its
 * own native sheet: running agents, background commands, servers and running automations.
 */
export function deriveMatterWhisperSegments(input: {
  readonly rows: ReadonlyArray<MatterWhisperRow>;
  readonly serverCount: number;
  readonly runningAutomationCount: number;
}): MatterWhisperSegments {
  const agents = input.rows.filter((row) => row.kind === "subagent");
  const commands = input.rows.filter((row) => row.kind !== "subagent");
  const segments: MatterWhisperSegmentKind[] = [];
  if (agents.length > 0) segments.push("agents");
  if (commands.length > 0) segments.push("commands");
  if (input.serverCount > 0) segments.push("servers");
  if (input.runningAutomationCount > 0) segments.push("automations");
  return {
    agents,
    commands,
    serverCount: input.serverCount,
    runningAutomationCount: input.runningAutomationCount,
    segments,
  };
}
