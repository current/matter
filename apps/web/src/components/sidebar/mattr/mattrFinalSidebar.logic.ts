import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";
import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import type { MattrProjectRef, MattrThreadItem } from "./mattrSidebar.logic";

/** Short age such as "4m", "2h", "1d"; never "just now", so the column stays one shape. */
export function compactAge(iso: string | null, nowMs: number): string {
  if (iso === null) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(1, Math.floor((nowMs - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export type MattrSortMode = "project" | "recent";
export type MattrListFilter = "all" | "needs";

/** A thread the rail lists: live, or settled/snoozed but raising a hand itself or through a child. */
function isListed(item: MattrThreadItem, needsChildParents?: ReadonlySet<string>): boolean {
  return (
    item.attention === "needs" ||
    needsChildParents?.has(item.key) === true ||
    (!item.settled && !item.snoozed)
  );
}

function byActivityDesc(left: MattrThreadItem, right: MattrThreadItem): number {
  return Date.parse(right.activityAt) - Date.parse(left.activityAt);
}

/** Pinned threads first, then the most recent. */
function byPinThenActivity(left: MattrThreadItem, right: MattrThreadItem): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return byActivityDesc(left, right);
}

export interface MattrThreadGroup {
  /** The project key, or null for the flat Recent list and for threads with no project. */
  readonly key: string | null;
  readonly name: string | null;
  readonly items: ReadonlyArray<MattrThreadItem>;
}

/**
 * The rail's thread list: one group per project in the projects' own order, or one flat group
 * by recency. A project filter and the Needs you filter narrow both.
 */
export function buildThreadGroups(
  items: ReadonlyArray<MattrThreadItem>,
  projects: ReadonlyArray<MattrProjectRef>,
  options: {
    readonly sort: MattrSortMode;
    readonly projectFilter: string | null;
    readonly filter: MattrListFilter;
    /** Rows with a subagent that needs you, from `parentsWithNeedsChild`. */
    readonly needsChildParents?: ReadonlySet<string>;
  },
): ReadonlyArray<MattrThreadGroup> {
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
  const byProject = new Map<string | null, MattrThreadItem[]>();
  for (const item of listed) {
    const bucket = byProject.get(item.projectKey) ?? [];
    bucket.push(item);
    byProject.set(item.projectKey, bucket);
  }
  const groups: MattrThreadGroup[] = [];
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

const CHILD_RANK: Record<MattrThreadItem["attention"], number> = {
  needs: 0,
  running: 1,
  review: 2,
  idle: 2,
};

/** A subagent or delegated task with the key of the rail row it nests under. */
export interface MattrChildItem extends MattrThreadItem {
  /** The nearest listed ancestor, so a subagent's own subagents nest under the same row. */
  readonly ancestorKey: string;
}

/** Points each child at its nearest listed ancestor, skipping subagents-of-subagents. */
export function attachListedAncestors(
  children: ReadonlyArray<MattrThreadItem>,
  threads: Parameters<typeof resolveListedAncestorThreadRef>[1],
): ReadonlyArray<MattrChildItem> {
  return children.map((child) => ({
    ...child,
    ancestorKey: scopedThreadKey(resolveListedAncestorThreadRef(child.ref, threads)),
  }));
}

/** Each row's subagents and delegated tasks: blocked and running first, then newest. */
export function indexChildrenByParent(
  children: ReadonlyArray<MattrChildItem>,
): ReadonlyMap<string, ReadonlyArray<MattrChildItem>> {
  const index = new Map<string, MattrChildItem[]>();
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
  childrenByParent: ReadonlyMap<string, ReadonlyArray<MattrThreadItem>>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, bucket] of childrenByParent) {
    if (bucket.some((child) => child.attention === "needs")) keys.add(key);
  }
  return keys;
}

/** The Needs you badge: threads and the subagents of listed threads that are waiting on you. */
export function countNeedsYou(
  items: ReadonlyArray<MattrThreadItem>,
  children: ReadonlyArray<MattrChildItem>,
): number {
  const rowKeys = new Set(items.map((item) => item.key));
  return (
    items.filter((item) => item.attention === "needs").length +
    children.filter((child) => child.attention === "needs" && rowKeys.has(child.ancestorKey)).length
  );
}

/** A tree opens by itself while it is on screen or still has live children. */
export function shouldAutoExpand(
  parent: MattrThreadItem,
  children: ReadonlyArray<MattrThreadItem>,
  activeThreadKey: string | null,
): boolean {
  if (parent.key === activeThreadKey) return true;
  return children.some(
    (child) =>
      child.key === activeThreadKey || child.attention === "running" || child.attention === "needs",
  );
}

export type MattrStatusTone = "running" | "needs" | "done" | "failed" | "muted";

export interface MattrRowStatus {
  readonly tone: MattrStatusTone;
  /** A compact age, or null when the label is a word ("Done", "Needs you"). */
  readonly age: string | null;
}

/** What a subagent row says on its right: live elapsed time, a raised hand, or done. */
export function subagentStatus(child: MattrThreadItem, nowMs: number): MattrRowStatus {
  if (child.attention === "needs") return { tone: "needs", age: null };
  if (child.attention === "running") {
    return { tone: "running", age: compactAge(child.runningSince ?? child.activityAt, nowMs) };
  }
  if (child.failed) return { tone: "failed", age: null };
  return { tone: "done", age: null };
}

/** What a top-level row says on its right when it has no pull request to show. */
export function threadRowStatus(item: MattrThreadItem, nowMs: number): MattrRowStatus {
  if (item.attention === "needs") return { tone: "needs", age: compactAge(item.activityAt, nowMs) };
  if (item.attention === "running") {
    return { tone: "running", age: compactAge(item.runningSince ?? item.activityAt, nowMs) };
  }
  return { tone: "muted", age: compactAge(item.activityAt, nowMs) };
}

/** Listed threads with an open or draft pull request, for the PRs count. */
export function countOpenPullRequests(items: ReadonlyArray<MattrThreadItem>): number {
  return items.filter(
    (item) =>
      isListed(item) && (item.pullRequest?.state === "open" || item.pullRequest?.state === "draft"),
  ).length;
}

/** Live threads per project, for the activity scope menu. */
export function summarizeProjects(
  items: ReadonlyArray<MattrThreadItem>,
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

export interface MattrUsageMeter {
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
): ReadonlyArray<MattrUsageMeter> {
  const byDriver = new Map<string, MattrUsageMeter>();
  for (const provider of providers) {
    const limits = provider.usageLimits;
    if (!provider.enabled || limits === undefined || limits.unavailable !== undefined) continue;
    const window = mostConstrainingWindow(limits.windows);
    if (window === null) continue;
    const meter: MattrUsageMeter = {
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
