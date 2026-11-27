import {
  compactAge,
  type MatterChildItem,
  type MatterListFilter,
} from "./matterFinalSidebar.logic";
import type { MatterNeedsKind, MatterThreadItem } from "./matterSidebar.logic";
import type { MatterTimelineSort } from "./matterTimelineSidebar.logic";

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

export interface MatterTimelineSection {
  /** Stable across renders, so a saved fold finds its section again: the kind, or "YYYY-MM". */
  readonly id: string;
  readonly kind: MatterTimelineSectionKind;
  /** Local midnight on the 1st, for a month section's label. */
  readonly monthStartMs: number | null;
  readonly items: ReadonlyArray<MatterThreadItem>;
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
export function buildTimelineSections(
  items: ReadonlyArray<MatterThreadItem>,
  options: {
    readonly nowMs: number;
    readonly sort: MatterTimelineSort;
    readonly projectFilter: string | null;
    readonly filter: MatterListFilter;
    readonly needsChildParents?: ReadonlySet<string>;
  },
): ReadonlyArray<MatterTimelineSection> {
  const needsChildParents = options.needsChildParents ?? new Set<string>();
  const todayStart = startOfLocalDay(options.nowMs);
  const yesterdayStart = startOfLocalDay(options.nowMs, 1);
  const weekStart = startOfLocalDay(options.nowMs, 7);
  const days30Start = startOfLocalDay(options.nowMs, 30);
  const fixed = new Map<MatterTimelineSectionKind, MatterThreadItem[]>();
  const months = new Map<number, MatterThreadItem[]>();
  const push = (kind: MatterTimelineSectionKind, item: MatterThreadItem) => {
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
  const newestFirst = (left: MatterThreadItem, right: MatterThreadItem) =>
    (timelineAt(right, options.sort) ?? 0) - (timelineAt(left, options.sort) ?? 0);
  const latestStartFirst = (left: MatterThreadItem, right: MatterThreadItem) =>
    runningAt(right) - runningAt(left);
  const sections: MatterTimelineSection[] = [];
  for (const kind of FIXED_ORDER) {
    const bucket = fixed.get(kind);
    if (bucket === undefined) continue;
    sections.push({
      id: kind,
      kind,
      monthStartMs: null,
      items: bucket.toSorted(kind === "working" ? latestStartFirst : newestFirst),
      ...SECTION_SHAPE[kind],
    });
  }
  for (const monthStartMs of [...months.keys()].toSorted((left, right) => right - left)) {
    sections.push({
      id: monthId(monthStartMs),
      kind: "month",
      monthStartMs,
      items: (months.get(monthStartMs) ?? []).toSorted(newestFirst),
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
      items: bucket.toSorted(
        kind === "settled" ? (left, right) => settledAtMs(right) - settledAtMs(left) : newestFirst,
      ),
      ...SECTION_SHAPE[kind],
    });
  }
  return sections;
}

/** The Settled section before any of its rows are local, when they all wait on a page read. */
export function emptyTimelineSettledSection(): MatterTimelineSection {
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

export interface MatterTimelineSubagentRows {
  readonly shown: ReadonlyArray<MatterChildItem>;
  /** Running subagents behind the "more" row. */
  readonly hiddenCount: number;
}

/**
 * Which of a thread's subagents get a row. Those waiting on you and the open one always do; the
 * rest fill up to `limit` rows, and the remainder waits behind one "more" row unless that would
 * hide a single subagent. `active` arrives waiting-first, then longest running.
 */
export function visibleTimelineSubagents(
  active: ReadonlyArray<MatterChildItem>,
  options: {
    readonly expanded: boolean;
    readonly activeThreadKey: string | null;
    readonly limit?: number;
  },
): MatterTimelineSubagentRows {
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
