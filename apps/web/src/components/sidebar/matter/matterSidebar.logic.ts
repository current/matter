import {
  buildMatterThreadItem,
  type MatterProjectRef,
  type MatterThreadAttention,
  type MatterThreadItem,
} from "@t3tools/client-runtime/matter/timeline-feed";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProviderDriverKind } from "@t3tools/contracts";

import { hasUnseenCompletion, resolveSidebarRowStatus } from "../../Sidebar.logic";

export {
  workingDescendantSince,
  workingNativeSubagentKeys,
  withDescendantWork,
  withNativeSubagentWork,
} from "@t3tools/client-runtime/matter/timeline-feed";
export type {
  MatterNeedsKind,
  MatterProjectRef,
  MatterPullRequestBadge,
  MatterPullRequestState,
  MatterThreadAttention,
  MatterThreadItem,
} from "@t3tools/client-runtime/matter/timeline-feed";

export function toMatterThreadItem(
  thread: EnvironmentThreadShell,
  project: MatterProjectRef | null,
  nowIso: string,
  driver: ProviderDriverKind | null = null,
): MatterThreadItem {
  return buildMatterThreadItem(thread, project, nowIso, {
    status: resolveSidebarRowStatus(thread),
    unread: hasUnseenCompletion(thread),
    driver,
  });
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
