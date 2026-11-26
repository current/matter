import { compactAge, type MattrChildItem, type MattrListFilter } from "./mattrFinalSidebar.logic";
import type { MattrThreadItem } from "./mattrSidebar.logic";

export type MattrTimelineSort = "updated" | "created";

export interface MattrTimelineBuckets {
  /** Today's threads, plus anything running or waiting on you whatever its age. */
  readonly recent: ReadonlyArray<MattrThreadItem>;
  readonly yesterday: ReadonlyArray<MattrThreadItem>;
  readonly earlier: ReadonlyArray<MattrThreadItem>;
}

function timelineAt(item: MattrThreadItem, sort: MattrTimelineSort): number {
  const at = Date.parse(sort === "created" ? item.createdAt : item.activityAt);
  return Number.isFinite(at) ? at : 0;
}

function startOfLocalDay(nowMs: number, daysBack = 0): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

/** Same listing rule as the default rail: live, or settled/snoozed but raising a hand. */
function isListed(item: MattrThreadItem, needsChildParents: ReadonlySet<string>): boolean {
  return (
    item.attention === "needs" ||
    needsChildParents.has(item.key) ||
    (!item.settled && !item.snoozed)
  );
}

/** Top-level threads by local calendar day, newest first within each bucket. */
export function buildTimelineBuckets(
  items: ReadonlyArray<MattrThreadItem>,
  options: {
    readonly nowMs: number;
    readonly sort: MattrTimelineSort;
    readonly projectFilter: string | null;
    readonly filter: MattrListFilter;
    readonly needsChildParents?: ReadonlySet<string>;
    /** Rows with a subagent still working, kept in Recent so it stays on screen. */
    readonly activeChildParents?: ReadonlySet<string>;
  },
): MattrTimelineBuckets {
  const needsChildParents = options.needsChildParents ?? new Set<string>();
  const activeChildParents = options.activeChildParents ?? new Set<string>();
  const todayStart = startOfLocalDay(options.nowMs);
  const yesterdayStart = startOfLocalDay(options.nowMs, 1);
  const recent: MattrThreadItem[] = [];
  const yesterday: MattrThreadItem[] = [];
  const earlier: MattrThreadItem[] = [];
  for (const item of items) {
    if (!isListed(item, needsChildParents)) continue;
    if (options.projectFilter !== null && item.projectKey !== options.projectFilter) continue;
    const raisesHand = item.attention === "needs" || needsChildParents.has(item.key);
    if (options.filter === "needs" && !raisesHand) continue;
    const at = timelineAt(item, options.sort);
    if (
      item.attention === "running" ||
      raisesHand ||
      activeChildParents.has(item.key) ||
      at >= todayStart
    ) {
      recent.push(item);
    } else if (at >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }
  const newestFirst = (left: MattrThreadItem, right: MattrThreadItem) =>
    timelineAt(right, options.sort) - timelineAt(left, options.sort);
  return {
    recent: recent.toSorted(newestFirst),
    yesterday: yesterday.toSorted(newestFirst),
    earlier: earlier.toSorted(newestFirst),
  };
}

/** A subagent or delegated task that is still working or waiting on you. */
export function isActiveSubagent(child: MattrThreadItem): boolean {
  return child.attention === "running" || child.attention === "needs";
}

/**
 * Each row's active subagents, those waiting on you first, then the longest running. Finished
 * ones never appear, and nothing does while the setting is off.
 */
export function activeSubagentsByParent(
  children: ReadonlyArray<MattrChildItem>,
  enabled: boolean,
): ReadonlyMap<string, ReadonlyArray<MattrChildItem>> {
  const index = new Map<string, MattrChildItem[]>();
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

/** How long an active subagent has been running. */
export function subagentElapsed(child: MattrThreadItem, nowMs: number): string {
  return compactAge(child.runningSince ?? child.activityAt, nowMs);
}

/** Where the thread's files live: its own worktree, or the project's checkout. */
export function workspaceKind(item: MattrThreadItem): "worktree" | "local" {
  return item.worktreePath !== null ? "worktree" : "local";
}

/** The footer's compact window names: "5h", "wk", "mo". */
export function compactWindowLabel(label: string): string {
  if (label === "week") return "wk";
  if (label === "month") return "mo";
  return label;
}
