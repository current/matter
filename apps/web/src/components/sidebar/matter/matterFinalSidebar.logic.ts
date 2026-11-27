import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { compactAge, type MatterListFilter } from "@t3tools/client-runtime/matter/timeline-feed";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";
import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import type { MatterProjectRef, MatterThreadItem } from "./matterSidebar.logic";

export { compactAge, type MatterListFilter };

export type MatterSortMode = "project" | "recent";

/** A thread the rail lists: live, or settled/snoozed but raising a hand itself or through a child. */
function isListed(item: MatterThreadItem, needsChildParents?: ReadonlySet<string>): boolean {
  return (
    item.attention === "needs" ||
    needsChildParents?.has(item.key) === true ||
    (!item.settled && !item.snoozed)
  );
}

function byActivityDesc(left: MatterThreadItem, right: MatterThreadItem): number {
  return Date.parse(right.activityAt) - Date.parse(left.activityAt);
}

/** Pinned threads first, then the most recent. */
function byPinThenActivity(left: MatterThreadItem, right: MatterThreadItem): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return byActivityDesc(left, right);
}

export interface MatterThreadGroup {
  /** The project key, or null for the flat Recent list and for threads with no project. */
  readonly key: string | null;
  readonly name: string | null;
  readonly items: ReadonlyArray<MatterThreadItem>;
}

/**
 * The rail's thread list: one group per project in the projects' own order, or one flat group
 * by recency. A project filter and the Needs you filter narrow both.
 */
export function buildThreadGroups(
  items: ReadonlyArray<MatterThreadItem>,
  projects: ReadonlyArray<MatterProjectRef>,
  options: {
    readonly sort: MatterSortMode;
    readonly projectFilter: string | null;
    readonly filter: MatterListFilter;
    /** Rows with a subagent that needs you, from `parentsWithNeedsChild`. */
    readonly needsChildParents?: ReadonlySet<string>;
  },
): ReadonlyArray<MatterThreadGroup> {
  const needsChildParents = options.needsChildParents;
  const listed = items.filter(
    (item) =>
      isListed(item, needsChildParents) &&
      (options.projectFilter === null || item.projectKey === options.projectFilter) &&
      (options.filter === "all" ||
        item.attention === "needs" ||
        needsChildParents?.has(item.key) === true),
  );
  if (options.sort === "recent") {
    return listed.length === 0
      ? []
      : [{ key: null, name: null, items: listed.toSorted(byActivityDesc) }];
  }
  const byProject = new Map<string | null, MatterThreadItem[]>();
  for (const item of listed) {
    const bucket = byProject.get(item.projectKey) ?? [];
    bucket.push(item);
    byProject.set(item.projectKey, bucket);
  }
  const groups: MatterThreadGroup[] = [];
  for (const project of projects) {
    const bucket = byProject.get(project.key);
    if (bucket === undefined) continue;
    groups.push({
      key: project.key,
      name: project.name,
      items: bucket.toSorted(byPinThenActivity),
    });
  }
  const orphans = byProject.get(null);
  if (orphans !== undefined) {
    groups.push({ key: null, name: null, items: orphans.toSorted(byPinThenActivity) });
  }
  return groups;
}

const CHILD_RANK: Record<MatterThreadItem["attention"], number> = {
  needs: 0,
  running: 1,
  review: 2,
  idle: 2,
};

/** A subagent or delegated task with the key of the rail row it nests under. */
export interface MatterChildItem extends MatterThreadItem {
  /** The nearest listed ancestor, so a subagent's own subagents nest under the same row. */
  readonly ancestorKey: string;
}

/** Points each child at its nearest listed ancestor, skipping subagents-of-subagents. */
export function attachListedAncestors(
  children: ReadonlyArray<MatterThreadItem>,
  threads: Parameters<typeof resolveListedAncestorThreadRef>[1],
): ReadonlyArray<MatterChildItem> {
  return children.map((child) => ({
    ...child,
    ancestorKey: scopedThreadKey(resolveListedAncestorThreadRef(child.ref, threads)),
  }));
}

/** Each row's subagents and delegated tasks: blocked and running first, then newest. */
export function indexChildrenByParent(
  children: ReadonlyArray<MatterChildItem>,
): ReadonlyMap<string, ReadonlyArray<MatterChildItem>> {
  const index = new Map<string, MatterChildItem[]>();
  for (const child of children) {
    if (child.ancestorKey === child.key) continue;
    const bucket = index.get(child.ancestorKey) ?? [];
    bucket.push(child);
    index.set(child.ancestorKey, bucket);
  }
  for (const [key, bucket] of index) {
    index.set(
      key,
      bucket.toSorted(
        (left, right) =>
          CHILD_RANK[left.attention] - CHILD_RANK[right.attention] || byActivityDesc(left, right),
      ),
    );
  }
  return index;
}

/** Rows with at least one child that needs you. */
export function parentsWithNeedsChild(
  childrenByParent: ReadonlyMap<string, ReadonlyArray<MatterThreadItem>>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, bucket] of childrenByParent) {
    if (bucket.some((child) => child.attention === "needs")) keys.add(key);
  }
  return keys;
}

/** The Needs you badge: threads and the subagents of listed threads that are waiting on you. */
export function countNeedsYou(
  items: ReadonlyArray<MatterThreadItem>,
  children: ReadonlyArray<MatterChildItem>,
): number {
  const rowKeys = new Set(items.map((item) => item.key));
  return (
    items.filter((item) => item.attention === "needs").length +
    children.filter((child) => child.attention === "needs" && rowKeys.has(child.ancestorKey)).length
  );
}

/** A tree opens by itself while it is on screen or still has live children. */
export function shouldAutoExpand(
  parent: MatterThreadItem,
  children: ReadonlyArray<MatterThreadItem>,
  activeThreadKey: string | null,
): boolean {
  if (parent.key === activeThreadKey) return true;
  return children.some(
    (child) =>
      child.key === activeThreadKey || child.attention === "running" || child.attention === "needs",
  );
}

export type MatterStatusTone = "running" | "needs" | "done" | "failed" | "muted";

export interface MatterRowStatus {
  readonly tone: MatterStatusTone;
  /** A compact age, or null when the label is a word ("Done", "Needs you"). */
  readonly age: string | null;
}

/** What a subagent row says on its right: live elapsed time, a raised hand, or done. */
export function subagentStatus(child: MatterThreadItem, nowMs: number): MatterRowStatus {
  if (child.attention === "needs") return { tone: "needs", age: null };
  if (child.attention === "running") {
    return { tone: "running", age: compactAge(child.runningSince ?? child.activityAt, nowMs) };
  }
  if (child.failed) return { tone: "failed", age: null };
  return { tone: "done", age: null };
}

/** What a top-level row says on its right when it has no pull request to show. */
export function threadRowStatus(item: MatterThreadItem, nowMs: number): MatterRowStatus {
  if (item.attention === "needs") return { tone: "needs", age: compactAge(item.activityAt, nowMs) };
  if (item.attention === "running") {
    return { tone: "running", age: compactAge(item.runningSince ?? item.activityAt, nowMs) };
  }
  return { tone: "muted", age: compactAge(item.activityAt, nowMs) };
}

/** Listed threads with an open or draft pull request, for the PRs count. */
export function countOpenPullRequests(items: ReadonlyArray<MatterThreadItem>): number {
  return items.filter(
    (item) =>
      isListed(item) && (item.pullRequest?.state === "open" || item.pullRequest?.state === "draft"),
  ).length;
}

/** Live threads per project, for the activity scope menu. */
export function summarizeProjects(
  items: ReadonlyArray<MatterThreadItem>,
): ReadonlyMap<string, { readonly count: number; readonly running: boolean }> {
  const summary = new Map<string, { count: number; running: boolean }>();
  for (const item of items) {
    if (item.projectKey === null || !isListed(item)) continue;
    const entry = summary.get(item.projectKey) ?? { count: 0, running: false };
    entry.count += 1;
    if (item.attention === "running") entry.running = true;
    summary.set(item.projectKey, entry);
  }
  return summary;
}

const SHORT_PROVIDER_NAME: Partial<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  grok: "Grok",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  muse: "Muse",
  kiro: "Kiro",
};

/** "5h", "week", "month", or the provider's own label for anything else. */
export function shortWindowLabel(window: ServerProviderUsageWindow): string {
  switch (window.kind) {
    case "session": {
      const minutes = window.windowDurationMins;
      if (minutes !== undefined && minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
      return window.label;
    }
    case "weekly":
      return "week";
    case "monthly":
      return "month";
    default:
      return window.label;
  }
}

export interface MatterUsageMeter {
  readonly key: string;
  readonly driver: ProviderDriverKind;
  readonly providerName: string;
  readonly accountName: string;
  readonly windowLabel: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

function mostConstrainingWindow(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProviderUsageWindow | null {
  const general = windows.filter((window) => (window.modelIds?.length ?? 0) === 0);
  const pool = general.length > 0 ? general : windows;
  let best: ServerProviderUsageWindow | null = null;
  for (const window of pool)
    if (best === null || window.usedPercent > best.usedPercent) best = window;
  return best;
}

/**
 * Footer A's two meters: each provider's most constrained limit window, one account per
 * provider (its most used), the two tightest providers first.
 */
export function pickUsageMeters(
  providers: ReadonlyArray<ServerProvider>,
  limit = 2,
): ReadonlyArray<MatterUsageMeter> {
  const byDriver = new Map<string, MatterUsageMeter>();
  for (const provider of providers) {
    const limits = provider.usageLimits;
    if (!provider.enabled || limits === undefined || limits.unavailable !== undefined) continue;
    const window = mostConstrainingWindow(limits.windows);
    if (window === null) continue;
    const meter: MatterUsageMeter = {
      key: `${provider.instanceId}:${window.id}`,
      driver: provider.driver,
      providerName: SHORT_PROVIDER_NAME[provider.driver] ?? provider.displayName ?? provider.driver,
      accountName: provider.displayName ?? provider.instanceId,
      windowLabel: shortWindowLabel(window),
      usedPercent: Math.round(Math.max(0, Math.min(100, window.usedPercent))),
      resetsAt: window.resetsAt ?? null,
    };
    const current = byDriver.get(provider.driver);
    if (current === undefined || meter.usedPercent > current.usedPercent) {
      byDriver.set(provider.driver, meter);
    }
  }
  return [...byDriver.values()]
    .toSorted((left, right) => right.usedPercent - left.usedPercent)
    .slice(0, limit);
}

/** "2h 14m" until a reset, or a weekday and time once it is a day or more away. */
export function formatResetLabel(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
  }
  return null;
}
