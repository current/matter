import {
  compactAge,
  type MatterChildItem,
  type MatterListFilter,
} from "./matterFinalSidebar.logic";
import type { MatterThreadItem } from "./matterSidebar.logic";

export type MatterTimelineSort = "updated" | "created";

export interface MatterTimelineBuckets {
  /** Pinned threads that match the current scope and filter, newest first. */
  readonly pinned: ReadonlyArray<MatterThreadItem>;
  /** Today's threads, plus anything running or waiting on you whatever its age. */
  readonly recent: ReadonlyArray<MatterThreadItem>;
  readonly yesterday: ReadonlyArray<MatterThreadItem>;
  readonly earlier: ReadonlyArray<MatterThreadItem>;
}

function timelineAt(item: MatterThreadItem, sort: MatterTimelineSort): number {
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
function isListed(item: MatterThreadItem, needsChildParents: ReadonlySet<string>): boolean {
  return (
    item.attention === "needs" ||
    needsChildParents.has(item.key) ||
    (!item.settled && !item.snoozed)
  );
}

/** Top-level threads by local calendar day, newest first within each bucket. */
export function buildTimelineBuckets(
  items: ReadonlyArray<MatterThreadItem>,
  options: {
    readonly nowMs: number;
    readonly sort: MatterTimelineSort;
    readonly projectFilter: string | null;
    readonly filter: MatterListFilter;
    readonly needsChildParents?: ReadonlySet<string>;
    /** Rows with a subagent still working, kept in Recent so it stays on screen. */
    readonly activeChildParents?: ReadonlySet<string>;
  },
): MatterTimelineBuckets {
  const needsChildParents = options.needsChildParents ?? new Set<string>();
  const activeChildParents = options.activeChildParents ?? new Set<string>();
  const todayStart = startOfLocalDay(options.nowMs);
  const yesterdayStart = startOfLocalDay(options.nowMs, 1);
  const pinned: MatterThreadItem[] = [];
  const recent: MatterThreadItem[] = [];
  const yesterday: MatterThreadItem[] = [];
  const earlier: MatterThreadItem[] = [];
  for (const item of items) {
    if (!isListed(item, needsChildParents)) continue;
    if (options.projectFilter !== null && item.projectKey !== options.projectFilter) continue;
    const raisesHand = item.attention === "needs" || needsChildParents.has(item.key);
    if (options.filter === "needs" && !raisesHand) continue;
    if (item.pinned) {
      pinned.push(item);
      continue;
    }
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
  const newestFirst = (left: MatterThreadItem, right: MatterThreadItem) =>
    timelineAt(right, options.sort) - timelineAt(left, options.sort);
  return {
    pinned: pinned.toSorted(newestFirst),
    recent: recent.toSorted(newestFirst),
    yesterday: yesterday.toSorted(newestFirst),
    earlier: earlier.toSorted(newestFirst),
  };
}

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

/** How long an active subagent has been running. */
export function subagentElapsed(child: MatterThreadItem, nowMs: number): string {
  return compactAge(child.runningSince ?? child.activityAt, nowMs);
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

const LEGACY_WORKTREE_PREFIX = /^(?:t3|t3code)\//i;

/** Formats a sidebar branch label as `repo/branch` (replacing legacy `t3/` prefixes with the repo name). */
export function formatTimelineBranchLabel(branch: string, projectName: string | null): string {
  const trimmed = branch.trim();
  if (!trimmed || !projectName) return trimmed;
  const repoSlug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!repoSlug) return trimmed;
  if (trimmed.toLowerCase().startsWith(`${repoSlug}/`)) return trimmed;
  const stripped = trimmed.replace(LEGACY_WORKTREE_PREFIX, "");
  return `${repoSlug}/${stripped}`;
}
