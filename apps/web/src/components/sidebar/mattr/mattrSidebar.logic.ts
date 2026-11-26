import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type { ProviderDriverKind, ScopedThreadRef } from "@t3tools/contracts";

import { hasUnseenCompletion, resolveSidebarRowStatus } from "../../Sidebar.logic";

/** Where a thread sits in the attention order, most urgent first. */
export type MattrThreadAttention = "needs" | "running" | "review" | "idle";
export type MattrNeedsKind = "approval" | "input" | "request" | "limited";

export interface MattrThreadItem {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly projectKey: string | null;
  readonly projectName: string | null;
  readonly attention: MattrThreadAttention;
  readonly needsKind: MattrNeedsKind | null;
  readonly failed: boolean;
  readonly unread: boolean;
  readonly pinned: boolean;
  readonly settled: boolean;
  readonly snoozed: boolean;
  /** Last meaningful change, for ordering and relative ages. */
  readonly activityAt: string;
  /** When the current run started, while one is running. */
  readonly runningSince: string | null;
  readonly providerName: string | null;
  /** The provider driving the thread now, for its brand mark; null when unknown. */
  readonly driver: ProviderDriverKind | null;
  /** The thread's current pull request, for the inline PR badge. */
  readonly pullRequest: MattrPullRequestBadge | null;
  /** The thread this one runs under (a subagent or delegated task), as a scoped key. */
  readonly parentKey: string | null;
}

export type MattrPullRequestState = "open" | "merged" | "closed" | "draft";

export interface MattrPullRequestBadge {
  readonly number: number;
  readonly state: MattrPullRequestState;
}

export interface MattrProjectRef {
  readonly key: string;
  readonly name: string;
}

export function toMattrThreadItem(
  thread: EnvironmentThreadShell,
  project: MattrProjectRef | null,
  nowIso: string,
  driver: ProviderDriverKind | null = null,
): MattrThreadItem {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const status = resolveSidebarRowStatus(thread);
  const unread = hasUnseenCompletion(thread);
  let attention: MattrThreadAttention;
  let needsKind: MattrNeedsKind | null = null;
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
      // Blocked on a child thread is still this turn; parked background work stays quiet.
      attention = thread.runtime?.status === "running" ? "running" : unread ? "review" : "idle";
      break;
    case "failed":
      attention = "review";
      break;
    default:
      attention = unread ? "review" : "idle";
  }
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
    providerName: thread.runtime?.providerName ?? null,
    driver,
    pullRequest: resolvePullRequestBadge(thread),
    parentKey: resolveParentKey(thread),
  };
}

function resolvePullRequestBadge(thread: EnvironmentThreadShell): MattrPullRequestBadge | null {
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests ?? []);
  if (link === null) return null;
  const snapshot = link.snapshot;
  const state: MattrPullRequestState =
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

function byActivityDesc(left: MattrThreadItem, right: MattrThreadItem): number {
  return Date.parse(right.activityAt) - Date.parse(left.activityAt);
}

/** Threads that belong in a live list: not settled and not snoozed. */
function isLive(item: MattrThreadItem): boolean {
  return !item.settled && !item.snoozed;
}

/** The most urgent state among a project's threads, for its tile dot. */
export function resolveProjectAttention(
  items: ReadonlyArray<MattrThreadItem>,
  projectKey: string,
): MattrThreadAttention | null {
  let best: MattrThreadAttention | null = null;
  for (const item of items) {
    if (item.projectKey !== projectKey) continue;
    if (item.attention === "needs") return "needs";
    if (!isLive(item)) continue;
    if (item.attention === "running") best = "running";
    else if (item.attention === "review" && best !== "running") best = "review";
  }
  return best;
}

export interface MattrSpaceSections {
  readonly pinned: ReadonlyArray<MattrThreadItem>;
  readonly today: ReadonlyArray<MattrThreadItem>;
  /** Older live threads, then settled ones, behind one fold. */
  readonly earlier: ReadonlyArray<MattrThreadItem>;
  readonly liveCount: number;
}

function startOfLocalDayMs(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function buildSpaceSections(
  items: ReadonlyArray<MattrThreadItem>,
  projectKey: string | null,
  nowMs: number,
): MattrSpaceSections {
  const dayStartMs = startOfLocalDayMs(nowMs);
  const pinned: MattrThreadItem[] = [];
  const today: MattrThreadItem[] = [];
  const earlierLive: MattrThreadItem[] = [];
  const settled: MattrThreadItem[] = [];
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
  items: ReadonlyArray<MattrThreadItem>,
  query: string,
): ReadonlyArray<MattrThreadItem> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;
  return items
    .filter((item) => {
      const haystack = `${item.title} ${item.projectName ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .toSorted(byActivityDesc);
}
