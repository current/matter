import type { MatterChildItem } from "./matterFinalSidebar.logic";
import type { MatterThreadItem } from "./matterSidebar.logic";

export type { MatterTimelineSort } from "@t3tools/client-runtime/matter/timeline-feed";

/** A subagent or delegated task that is still working or waiting on you. */
export function isActiveSubagent(child: MatterThreadItem): boolean {
  return child.attention === "running" || child.attention === "needs";
}

/**
 * Each row's active subagents, those waiting on you first, then the longest running. Finished
 * ones never appear, and nothing does while the setting is off.
 */
export function activeSubagentsByParent(
  children: ReadonlyArray<MatterChildItem>,
  enabled: boolean,
): ReadonlyMap<string, ReadonlyArray<MatterChildItem>> {
  const index = new Map<string, MatterChildItem[]>();
  if (!enabled) return index;
  for (const child of children) {
    if (child.ancestorKey === child.key || !isActiveSubagent(child)) continue;
    const bucket = index.get(child.ancestorKey) ?? [];
    bucket.push(child);
    index.set(child.ancestorKey, bucket);
  }
  for (const [key, bucket] of index) {
    index.set(
      key,
      bucket.toSorted(
        (left, right) =>
          Number(right.attention === "needs") - Number(left.attention === "needs") ||
          Date.parse(left.runningSince ?? left.activityAt) -
            Date.parse(right.runningSince ?? right.activityAt),
      ),
    );
  }
  return index;
}

/**
 * How many subagents, delegated tasks and cloud runs work or wait on you under each thread, at
 * any depth, for the row's count while they aren't nested under it.
 */
export function activeSubagentCounts(
  children: ReadonlyArray<MatterChildItem>,
  cloudRuns: ReadonlyMap<string, ReadonlyArray<unknown>>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const child of children) {
    if (child.ancestorKey === child.key || !isActiveSubagent(child)) continue;
    counts.set(child.ancestorKey, (counts.get(child.ancestorKey) ?? 0) + 1);
  }
  for (const [key, runs] of cloudRuns) {
    if (runs.length > 0) counts.set(key, (counts.get(key) ?? 0) + runs.length);
  }
  return counts;
}

/** Where the thread's files live: none when detached from a project, its own worktree, or the project's checkout. */
export function workspaceKind(item: MatterThreadItem): "none" | "worktree" | "local" {
  if (item.projectName === null) return "none";
  return item.worktreePath !== null ? "worktree" : "local";
}

export type MatterUsageMeterTone = "normal" | "warn" | "critical";

/** Severity bucket for a usage meter's used percentage. */
export function usageMeterTone(usedPercent: number): MatterUsageMeterTone {
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 75) return "warn";
  return "normal";
}

/** The footer's compact window names: "5h", "wk", "mo". */
export function compactWindowLabel(label: string): string {
  if (label === "week") return "wk";
  if (label === "month") return "mo";
  return label;
}
