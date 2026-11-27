// @effect-diagnostics globalDate:off - Timeline sections follow the device's local calendar days, outside an Effect runtime.
import type {
  ProviderDriverKind,
  ProviderInteractionMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";
import type { EnvironmentThreadShell } from "../state/models.ts";
import { effectiveSnoozed } from "../state/threadSettled.ts";
import { resolveThreadCurrentPullRequestLink } from "../threadPullRequests.ts";

/** Where a thread sits in the attention order, most urgent first. */
export type MatterThreadAttention = "needs" | "running" | "review" | "idle";
export type MatterNeedsKind = "approval" | "input" | "request" | "limited";
export type MatterTimelineSort = "updated" | "created";
export type MatterListFilter = "all" | "needs";

export type MatterPullRequestState = "open" | "merged" | "closed" | "draft";

export interface MatterPullRequestBadge {
  readonly number: number;
  readonly state: MatterPullRequestState;
}

export interface MatterProjectRef {
  readonly key: string;
  readonly name: string;
}

export interface MatterThreadItem {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly projectKey: string | null;
  readonly projectName: string | null;
  readonly attention: MatterThreadAttention;
  readonly needsKind: MatterNeedsKind | null;
  readonly failed: boolean;
  readonly unread: boolean;
  readonly pinned: boolean;
  readonly settled: boolean;
  /** When it settled, for the Settled section's order. */
  readonly settledAt?: string | null;
  readonly snoozed: boolean;
  /** Last meaningful change, for ordering and relative ages. */
  readonly activityAt: string;
  /** When the current run started, while one is running. */
  readonly runningSince: string | null;
  /** Running only because the agent resumes when its background work ends, not mid-turn. */
  readonly waitsOnBackground: boolean;
  readonly providerName: string | null;
  /** The provider driving the thread now, for its brand mark; null when unknown. */
  readonly driver: ProviderDriverKind | null;
  /** The thread's current pull request, for the inline PR badge. */
  readonly pullRequest: MatterPullRequestBadge | null;
  /** The thread this one runs under (a subagent or delegated task), as a scoped key. */
  readonly parentKey: string | null;
  readonly createdAt: string;
  readonly branch: string | null;
  /** Set when the thread runs in its own worktree rather than the project's checkout. */
  readonly worktreePath: string | null;
  /** Goal threads carry a small target glyph. */
  readonly interactionMode?: ProviderInteractionMode;
}

/**
 * A row status as each client's thread list resolves it (web's sidebar status, mobile's list
 * status). Both fold an opened failure back to "ready"; mobile reports "preparing" as "working".
 */
export type MatterRowStatusInput =
  | "approval"
  | "input"
  | "request"
  | "limited"
  | "preparing"
  | "working"
  | "waiting"
  | "failed"
  | "ready";

/**
 * The client-neutral part of a sidebar item. Each client passes its own row status and unread
 * rule, so the Timeline reads a thread the same way that client's other lists do.
 */
export function buildMatterThreadItem(
  thread: EnvironmentThreadShell,
  project: MatterProjectRef | null,
  nowIso: string,
  options: {
    readonly status: MatterRowStatusInput;
    readonly unread: boolean;
    readonly driver?: ProviderDriverKind | null;
  },
): MatterThreadItem {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const { status, unread } = options;
  const heldByBackground = backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks);
  let attention: MatterThreadAttention;
  let needsKind: MatterNeedsKind | null = null;
  switch (status) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      attention = "needs";
      needsKind = status;
      break;
    case "preparing":
    case "working":
      attention = "running";
      break;
    case "waiting":
      // Blocked on a child thread is still this turn, and so is work the agent resumes from;
      // a dev server or monitor left running only holds when the agent marked it awaited.
      attention =
        thread.runtime?.status === "running" || heldByBackground
          ? "running"
          : unread
            ? "review"
            : "idle";
      break;
    case "failed":
      attention = "review";
      break;
    default:
      attention = heldByBackground ? "running" : unread ? "review" : "idle";
  }
  const waitsOnBackground =
    heldByBackground &&
    attention === "running" &&
    status !== "preparing" &&
    status !== "working" &&
    thread.runtime?.status !== "running";
  return {
    key: scopedThreadKey(ref),
    ref,
    title: thread.title,
    projectKey: project?.key ?? null,
    projectName: project?.name ?? null,
    attention,
    needsKind,
    failed: status === "failed",
    unread,
    pinned: thread.pinnedAt != null,
    settled: thread.settledOverride === "settled",
    settledAt: thread.settledAt,
    snoozed: effectiveSnoozed(thread, { now: nowIso }),
    activityAt: latestTimestamp([
      thread.latestRun?.completedAt ?? null,
      thread.latestUserMessageAt,
      thread.createdAt,
    ]),
    runningSince:
      attention === "running"
        ? (thread.runtime?.activityStartedAt ?? thread.latestRun?.startedAt ?? null)
        : null,
    waitsOnBackground,
    providerName: thread.runtime?.providerName ?? null,
    driver: options.driver ?? null,
    pullRequest: resolvePullRequestBadge(thread),
    parentKey: resolveParentKey(thread),
    createdAt: thread.createdAt,
    branch: thread.branch ?? null,
    worktreePath: thread.worktreePath ?? null,
    interactionMode: thread.interactionMode,
  };
}

function resolvePullRequestBadge(thread: EnvironmentThreadShell): MatterPullRequestBadge | null {
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests ?? []);
  if (link === null) return null;
  const snapshot = link.snapshot;
  const state: MatterPullRequestState =
    snapshot === null
      ? "open"
      : snapshot.state === "open"
        ? snapshot.isDraft
          ? "draft"
          : "open"
        : snapshot.state;
  return { number: link.number, state };
}

/** A delegated task names its parent across environments; a subagent names one in its own. */
function resolveParentKey(thread: EnvironmentThreadShell): string | null {
  if (thread.delegatedFrom != null) {
    return scopedThreadKey(
      scopeThreadRef(thread.delegatedFrom.environmentId, thread.delegatedFrom.threadId),
    );
  }
  const { parentThreadId, relationshipToParent } = thread.lineage;
  if (relationshipToParent !== "subagent" || parentThreadId === null) return null;
  return scopedThreadKey(scopeThreadRef(thread.environmentId, parentThreadId));
}

function latestTimestamp(values: ReadonlyArray<string | null>): string {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null) continue;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best ?? new Date(0).toISOString();
}

/**
 * Provider-native subagent threads still working. They have no run of their own, so their shells
 * stay idle (fresh or resumed); the parent's pending background work names them by child thread.
 */
export function workingNativeSubagentKeys(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "pendingBackgroundTasks">>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const thread of threads) {
    for (const task of thread.pendingBackgroundTasks) {
      if (task.kind !== "subagent" || task.childThreadId == null) continue;
      keys.add(scopedThreadKey(scopeThreadRef(thread.environmentId, task.childThreadId)));
    }
  }
  return keys;
}

/** Shows those subagent threads as running, since their latest message (the launch or resume). */
export function withNativeSubagentWork<T extends MatterThreadItem>(
  items: ReadonlyArray<T>,
  workingKeys: ReadonlySet<string>,
): ReadonlyArray<T> {
  if (workingKeys.size === 0) return items;
  return items.map((item) =>
    !workingKeys.has(item.key) || item.attention === "needs" || item.attention === "running"
      ? item
      : { ...item, attention: "running", runningSince: item.activityAt },
  );
}

/**
 * Threads with a subagent or delegated task still running anywhere below them, keyed to when
 * the earliest of those runs started. Walks `parentKey` up from each running thread, so a
 * grandchild counts for every ancestor; a lineage cycle stops at the first repeat.
 */
export function workingDescendantSince(
  lineage: ReadonlyArray<MatterThreadItem>,
): ReadonlyMap<string, string> {
  const parentOf = new Map(lineage.map((item) => [item.key, item.parentKey]));
  const since = new Map<string, string>();
  for (const item of lineage) {
    if (item.attention !== "running") continue;
    const started = item.runningSince ?? item.activityAt;
    const visited = new Set([item.key]);
    let ancestor = item.parentKey;
    while (ancestor !== null && !visited.has(ancestor)) {
      visited.add(ancestor);
      const current = since.get(ancestor);
      if (current === undefined || Date.parse(started) < Date.parse(current)) {
        since.set(ancestor, started);
      }
      ancestor = parentOf.get(ancestor) ?? null;
    }
  }
  return since;
}

/**
 * Shows a thread as running while any of its descendants runs, even after its own turn ended.
 * A thread that needs you keeps that state; the rest return to their own once the work ends.
 */
export function withDescendantWork<T extends MatterThreadItem>(
  items: ReadonlyArray<T>,
  workingSince: ReadonlyMap<string, string>,
): ReadonlyArray<T> {
  return items.map((item) => {
    const since = workingSince.get(item.key);
    if (since === undefined || item.attention === "needs" || item.attention === "running") {
      return item;
    }
    return { ...item, attention: "running", runningSince: since };
  });
}

/** "12m", "3h", "2d", "1w", "4mo", "1y": the age column's compact form. */
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

export type MatterTimelineSectionKind =
  | "needs"
  | "pinned"
  | "working"
  | "today"
  | "yesterday"
  | "week"
  | "days30"
  | "month"
  | "snoozed"
  | "settled";

export interface MatterTimelineSection<T extends MatterThreadItem = MatterThreadItem> {
  /** Stable across renders, so a saved fold finds its section again: the kind, or "YYYY-MM". */
  readonly id: string;
  readonly kind: MatterTimelineSectionKind;
  /** Local midnight on the 1st, for a month section's label. */
  readonly monthStartMs: number | null;
  readonly items: ReadonlyArray<T>;
  /** Two-line rows while the context still matters, one line once a thread is history. */
  readonly density: "full" | "compact";
  readonly foldable: boolean;
  readonly openByDefault: boolean;
}

const FIXED_ORDER = [
  "needs",
  "pinned",
  "working",
  "today",
  "yesterday",
  "week",
  "days30",
] as const satisfies ReadonlyArray<MatterTimelineSectionKind>;

/** After the months: threads put away, which come back by themselves or from their row menu. */
const TAIL_ORDER = [
  "snoozed",
  "settled",
] as const satisfies ReadonlyArray<MatterTimelineSectionKind>;

const SECTION_SHAPE: Record<
  MatterTimelineSectionKind,
  Pick<MatterTimelineSection, "density" | "foldable" | "openByDefault">
> = {
  needs: { density: "full", foldable: false, openByDefault: true },
  pinned: { density: "full", foldable: true, openByDefault: true },
  working: { density: "full", foldable: true, openByDefault: true },
  today: { density: "full", foldable: true, openByDefault: true },
  yesterday: { density: "full", foldable: true, openByDefault: true },
  week: { density: "compact", foldable: true, openByDefault: true },
  days30: { density: "compact", foldable: true, openByDefault: false },
  month: { density: "compact", foldable: true, openByDefault: false },
  snoozed: { density: "compact", foldable: true, openByDefault: false },
  settled: { density: "compact", foldable: true, openByDefault: false },
};

/** `null` for a timestamp that doesn't parse, which files under Today rather than January 1970. */
function timelineAt(item: MatterThreadItem, sort: MatterTimelineSort): number | null {
  const at = Date.parse(sort === "created" ? item.createdAt : item.activityAt);
  return Number.isFinite(at) ? at : null;
}

/** How long a working row has run: the column it shows, so the section sorts by it too. */
function runningAt(item: MatterThreadItem): number {
  const at = Date.parse(item.runningSince ?? item.activityAt);
  return Number.isFinite(at) ? at : 0;
}

/**
 * Whether a thread waits on the user: its own request, a subagent's, or a failed run nobody has
 * looked at yet. Opening a failed thread reads it, which drops it back to its day.
 */
export function timelineRaisesHand(
  item: MatterThreadItem,
  needsChildParents: ReadonlySet<string>,
): boolean {
  if (item.attention === "needs" || needsChildParents.has(item.key)) return true;
  return item.failed && item.unread && !item.settled && !item.snoozed;
}

function startOfLocalDay(nowMs: number, daysBack = 0): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

function startOfLocalMonth(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
}

function monthId(monthStartMs: number): string {
  const date = new Date(monthStartMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function settledAtMs(item: MatterThreadItem): number {
  const at = Date.parse(item.settledAt ?? item.activityAt);
  return Number.isFinite(at) ? at : 0;
}

/**
 * The feed in reading order. State leads: everything waiting on you, then pinned (which keeps its
 * place while it runs), then everything else working, whatever its age. The rest follows by local
 * day, then by rolling week and month, then by calendar month, and snoozed and settled threads
 * close the list, so nothing put away vanishes. Empty sections are left out.
 */
export function buildTimelineSections<T extends MatterThreadItem>(
  items: ReadonlyArray<T>,
  options: {
    readonly nowMs: number;
    readonly sort: MatterTimelineSort;
    readonly projectFilter: string | null;
    readonly filter: MatterListFilter;
    readonly needsChildParents?: ReadonlySet<string>;
  },
): ReadonlyArray<MatterTimelineSection<T>> {
  const needsChildParents = options.needsChildParents ?? new Set<string>();
  const todayStart = startOfLocalDay(options.nowMs);
  const yesterdayStart = startOfLocalDay(options.nowMs, 1);
  const weekStart = startOfLocalDay(options.nowMs, 7);
  const days30Start = startOfLocalDay(options.nowMs, 30);
  const fixed = new Map<MatterTimelineSectionKind, T[]>();
  const months = new Map<number, T[]>();
  const push = (kind: MatterTimelineSectionKind, item: T) => {
    const bucket = fixed.get(kind);
    if (bucket === undefined) fixed.set(kind, [item]);
    else bucket.push(item);
  };
  for (const item of items) {
    const raisesHand = timelineRaisesHand(item, needsChildParents);
    if (options.projectFilter !== null && item.projectKey !== options.projectFilter) continue;
    if (options.filter === "needs" && !raisesHand) continue;
    if (raisesHand) push("needs", item);
    else if (item.settled) push("settled", item);
    else if (item.snoozed) push("snoozed", item);
    else if (item.pinned) push("pinned", item);
    else if (item.attention === "running") push("working", item);
    else {
      const at = timelineAt(item, options.sort);
      if (at === null || at >= todayStart) push("today", item);
      else if (at >= yesterdayStart) push("yesterday", item);
      else if (at >= weekStart) push("week", item);
      else if (at >= days30Start) push("days30", item);
      else {
        const monthStart = startOfLocalMonth(at);
        const bucket = months.get(monthStart);
        if (bucket === undefined) months.set(monthStart, [item]);
        else bucket.push(item);
      }
    }
  }
  const newestFirst = (left: T, right: T) =>
    (timelineAt(right, options.sort) ?? 0) - (timelineAt(left, options.sort) ?? 0);
  const latestStartFirst = (left: T, right: T) => runningAt(right) - runningAt(left);
  const sections: MatterTimelineSection<T>[] = [];
  for (const kind of FIXED_ORDER) {
    const bucket = fixed.get(kind);
    if (bucket === undefined) continue;
    sections.push({
      id: kind,
      kind,
      monthStartMs: null,
      items: [...bucket].sort(kind === "working" ? latestStartFirst : newestFirst),
      ...SECTION_SHAPE[kind],
    });
  }
  for (const monthStartMs of [...months.keys()].sort((left, right) => right - left)) {
    sections.push({
      id: monthId(monthStartMs),
      kind: "month",
      monthStartMs,
      items: [...(months.get(monthStartMs) ?? [])].sort(newestFirst),
      ...SECTION_SHAPE.month,
    });
  }
  for (const kind of TAIL_ORDER) {
    const bucket = fixed.get(kind);
    if (bucket === undefined) continue;
    sections.push({
      id: kind,
      kind,
      monthStartMs: null,
      items: [...bucket].sort(
        kind === "settled" ? (left, right) => settledAtMs(right) - settledAtMs(left) : newestFirst,
      ),
      ...SECTION_SHAPE[kind],
    });
  }
  return sections;
}

/** The Settled section before any of its rows are local, when they all wait on a page read. */
export function emptyTimelineSettledSection<
  T extends MatterThreadItem = MatterThreadItem,
>(): MatterTimelineSection<T> {
  return {
    id: "settled",
    kind: "settled",
    monthStartMs: null,
    items: [],
    ...SECTION_SHAPE.settled,
  };
}

/** Whether a section shows its rows: the saved choice, else the section's own default. */
export function isTimelineSectionOpen(
  section: Pick<MatterTimelineSection, "id" | "foldable" | "openByDefault">,
  folds: Readonly<Record<string, boolean>>,
): boolean {
  if (!section.foldable) return true;
  return folds[section.id] ?? section.openByDefault;
}

export type MatterTimelineNeedsKind = MatterNeedsKind | "subagent";

export type MatterTimelineRowState =
  | { readonly tone: "needs"; readonly kind: MatterTimelineNeedsKind; readonly age: string }
  | { readonly tone: "running"; readonly elapsed: string }
  | { readonly tone: "background"; readonly elapsed: string }
  | { readonly tone: "failed"; readonly age: string }
  | { readonly tone: "idle"; readonly age: string };

/** What a row says at its right edge: what it waits on, how long it has run, or how old it is. */
export function timelineRowState(
  item: MatterThreadItem,
  options: {
    readonly childNeedsYou: boolean;
    readonly sort: MatterTimelineSort;
    readonly nowMs: number;
  },
): MatterTimelineRowState {
  // How long a request has waited, from the thread's last activity.
  const waited = compactAge(item.activityAt, options.nowMs);
  if (item.attention === "needs") {
    return { tone: "needs", kind: item.needsKind ?? "request", age: waited };
  }
  if (options.childNeedsYou) return { tone: "needs", kind: "subagent", age: waited };
  if (item.attention === "running") {
    return {
      tone: item.waitsOnBackground ? "background" : "running",
      elapsed: compactAge(item.runningSince ?? item.activityAt, options.nowMs),
    };
  }
  if (item.failed) return { tone: "failed", age: compactAge(item.activityAt, options.nowMs) };
  return {
    tone: "idle",
    age: compactAge(options.sort === "created" ? item.createdAt : item.activityAt, options.nowMs),
  };
}

export interface MatterTimelineSubagentRows<T> {
  readonly shown: ReadonlyArray<T>;
  /** Running subagents behind the "more" row. */
  readonly hiddenCount: number;
}

/**
 * Which of a thread's subagents get a row. Those waiting on you and the open one always do; the
 * rest fill up to `limit` rows, and the remainder waits behind one "more" row unless that would
 * hide a single subagent. `active` arrives waiting-first, then longest running.
 */
export function visibleTimelineSubagents<T extends Pick<MatterThreadItem, "key" | "attention">>(
  active: ReadonlyArray<T>,
  options: {
    readonly expanded: boolean;
    readonly activeThreadKey: string | null;
    readonly limit?: number;
  },
): MatterTimelineSubagentRows<T> {
  const limit = options.limit ?? 3;
  if (options.expanded || active.length <= limit + 1) return { shown: active, hiddenCount: 0 };
  const forced = active.filter(
    (child) => child.attention === "needs" || child.key === options.activeThreadKey,
  ).length;
  let optional = Math.max(0, limit - forced);
  const shown = active.filter((child) => {
    if (child.attention === "needs" || child.key === options.activeThreadKey) return true;
    if (optional === 0) return false;
    optional -= 1;
    return true;
  });
  const hiddenCount = active.length - shown.length;
  return hiddenCount <= 1 ? { shown: active, hiddenCount: 0 } : { shown, hiddenCount };
}

const WORKTREE_PREFIX = /^(?:t3|t3code)\//i;

/**
 * The branch without the worktree prefix or a leading `<project>/`, which would only repeat the
 * project icon that leads the row.
 */
export function shortTimelineBranchLabel(branch: string, projectName: string | null): string {
  const trimmed = branch.trim();
  const withoutWorktree = trimmed.replace(WORKTREE_PREFIX, "");
  if (projectName === null) return withoutWorktree || trimmed;
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug !== "" && withoutWorktree.toLowerCase().startsWith(`${slug}/`)) {
    return withoutWorktree.slice(slug.length + 1) || trimmed;
  }
  return withoutWorktree || trimmed;
}
