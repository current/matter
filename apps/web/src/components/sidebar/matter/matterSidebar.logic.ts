import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type {
  ProviderDriverKind,
  ProviderInteractionMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { hasUnseenCompletion, resolveSidebarRowStatus } from "../../Sidebar.logic";

/** Where a thread sits in the attention order, most urgent first. */
export type MatterThreadAttention = "needs" | "running" | "review" | "idle";
export type MatterNeedsKind = "approval" | "input" | "request" | "limited";

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

export type MatterPullRequestState = "open" | "merged" | "closed" | "draft";

export interface MatterPullRequestBadge {
  readonly number: number;
  readonly state: MatterPullRequestState;
}

export interface MatterProjectRef {
  readonly key: string;
  readonly name: string;
}

export function toMatterThreadItem(
  thread: EnvironmentThreadShell,
  project: MatterProjectRef | null,
  nowIso: string,
  driver: ProviderDriverKind | null = null,
): MatterThreadItem {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const status = resolveSidebarRowStatus(thread);
  const unread = hasUnseenCompletion(thread);
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
    driver,
    pullRequest: resolvePullRequestBadge(thread),
    parentKey: resolveParentKey(thread),
    createdAt: thread.createdAt,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    interactionMode: thread.interactionMode,
  };
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

function byActivityDesc(left: MatterThreadItem, right: MatterThreadItem): number {
  return Date.parse(right.activityAt) - Date.parse(left.activityAt);
}

/** Threads that belong in a live list: not settled and not snoozed. */
function isLive(item: MatterThreadItem): boolean {
  return !item.settled && !item.snoozed;
}

/** The most urgent state among a project's threads, for its tile dot. */
export function resolveProjectAttention(
  items: ReadonlyArray<MatterThreadItem>,
  projectKey: string,
): MatterThreadAttention | null {
  let best: MatterThreadAttention | null = null;
  for (const item of items) {
    if (item.projectKey !== projectKey) continue;
    if (item.attention === "needs") return "needs";
    if (!isLive(item)) continue;
    if (item.attention === "running") best = "running";
    else if (item.attention === "review" && best !== "running") best = "review";
  }
  return best;
}

export interface MatterSpaceSections {
  readonly pinned: ReadonlyArray<MatterThreadItem>;
  readonly today: ReadonlyArray<MatterThreadItem>;
  /** Older live threads, then settled ones, behind one fold. */
  readonly earlier: ReadonlyArray<MatterThreadItem>;
  readonly liveCount: number;
}

function startOfLocalDayMs(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function buildSpaceSections(
  items: ReadonlyArray<MatterThreadItem>,
  projectKey: string | null,
  nowMs: number,
): MatterSpaceSections {
  const dayStartMs = startOfLocalDayMs(nowMs);
  const pinned: MatterThreadItem[] = [];
  const today: MatterThreadItem[] = [];
  const earlierLive: MatterThreadItem[] = [];
  const settled: MatterThreadItem[] = [];
  for (const item of items) {
    if (projectKey === null || item.projectKey !== projectKey) continue;
    if (item.settled && item.attention !== "needs") {
      settled.push(item);
    } else if (item.pinned) {
      pinned.push(item);
    } else if (item.snoozed && item.attention !== "needs") {
      earlierLive.push(item);
    } else if (
      item.attention === "needs" ||
      item.attention === "running" ||
      Date.parse(item.activityAt) >= dayStartMs
    ) {
      today.push(item);
    } else {
      earlierLive.push(item);
    }
  }
  return {
    pinned: pinned.toSorted(byActivityDesc),
    today: today.toSorted(byActivityDesc),
    earlier: [...earlierLive.toSorted(byActivityDesc), ...settled.toSorted(byActivityDesc)],
    liveCount: pinned.length + today.length + earlierLive.length,
  };
}

/** The space Spaces shows: the stored one while it still exists, else the first project. */
export function resolveActiveSpaceKey(
  storedKey: string | null,
  projectKeys: ReadonlyArray<string>,
): string | null {
  if (storedKey !== null && projectKeys.includes(storedKey)) return storedKey;
  return projectKeys[0] ?? null;
}

/** Searches titles and project names; every whitespace-separated term must match. */
export function filterThreadsByQuery(
  items: ReadonlyArray<MatterThreadItem>,
  query: string,
): ReadonlyArray<MatterThreadItem> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items
    .filter((item) => {
      const haystack = `${item.title} ${item.projectName ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .toSorted(byActivityDesc);
}
