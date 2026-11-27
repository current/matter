import {
  buildMatterThreadItem,
  buildTimelineSections,
  emptyTimelineSettledSection,
  isTimelineSectionOpen,
  shortTimelineBranchLabel,
  timelineRowState,
  withDescendantWork,
  withNativeSubagentWork,
  workingDescendantSince,
  workingNativeSubagentKeys,
  type MatterPullRequestState,
  type MatterThreadItem,
  type MatterTimelineNeedsKind,
  type MatterTimelineRowState,
  type MatterTimelineSection,
  type MatterTimelineSectionKind,
} from "@t3tools/client-runtime/matter/timeline-feed";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { scopedProjectKey } from "../../../lib/scopedEntities";
import {
  resolveThreadListV2RowStatus,
  threadHasUnseenCompletion,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "../../threads/threadListV2";

export interface MatterTimelineSectionListItem {
  readonly type: "matter-timeline-section";
  readonly key: string;
  readonly sectionId: string;
  readonly kind: MatterTimelineSectionKind;
  readonly monthStartMs: number | null;
  /** A month from another year names its year. */
  readonly showYear: boolean;
  readonly count: number;
  readonly open: boolean;
  readonly foldable: boolean;
  /** A folded section hides an unread row. */
  readonly hiddenUnread: boolean;
  readonly first: boolean;
}

/** What a Timeline row shows beyond its thread shell, flattened so list equality stays cheap. */
export interface MatterTimelineRowInfo {
  readonly density: MatterTimelineSection["density"];
  readonly tone: MatterTimelineRowState["tone"];
  readonly needsKind: MatterTimelineNeedsKind | null;
  /** A run's elapsed time, or the thread's age. */
  readonly timeText: string;
  readonly unread: boolean;
  /** Snoozed and archived rows step back. */
  readonly quiet: boolean;
  readonly projectName: string | null;
  readonly branchLabel: string | null;
  readonly worktree: boolean;
  readonly goal: boolean;
  readonly pullRequestNumber: number | null;
  readonly pullRequestState: MatterPullRequestState | null;
}

export type MatterTimelineThreadListItem = ThreadListV2ThreadListItem & {
  readonly matter?: MatterTimelineRowInfo;
};

export type MatterTimelineListItem =
  | Exclude<ThreadListV2ListItem, ThreadListV2ThreadListItem>
  | MatterTimelineThreadListItem
  | MatterTimelineSectionListItem;

export function isMatterTimelineSectionListItem(item: {
  readonly type: string;
}): item is MatterTimelineSectionListItem {
  return item.type === "matter-timeline-section";
}

/** Rows the keyboard jump shortcuts and other upstream helpers can read. */
export function threadListItemsOf<T extends { readonly type: string }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<Exclude<T, MatterTimelineSectionListItem>> {
  return items.filter(
    (item): item is Exclude<T, MatterTimelineSectionListItem> =>
      !isMatterTimelineSectionListItem(item),
  );
}

/**
 * Every shell as a Timeline item, keyed like the list's rows. Subagents and delegated tasks are
 * included so a thread counts as running while anything below it runs, as on desktop.
 */
export function buildMatterTimelineItems(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectNameByKey: ReadonlyMap<string, string>;
  readonly nowIso: string;
}): ReadonlyMap<string, MatterThreadItem> {
  const items = input.threads.flatMap((thread) => {
    if (thread.archivedAt !== null) return [];
    const projectKey = scopedProjectKey(thread.environmentId, thread.projectId);
    const projectName = input.projectNameByKey.get(projectKey);
    return [
      buildMatterThreadItem(
        thread,
        projectName === undefined ? null : { key: projectKey, name: projectName },
        input.nowIso,
        {
          status: resolveThreadListV2RowStatus(thread),
          unread: threadHasUnseenCompletion(thread),
        },
      ),
    ];
  });
  const withNative = withNativeSubagentWork(items, workingNativeSubagentKeys(input.threads));
  const lifted = withDescendantWork(withNative, workingDescendantSince(withNative));
  return new Map(lifted.map((item) => [item.key, item]));
}

/** Threads whose subagent or delegated task, at any depth, waits on the user. */
function parentsWithNeedsDescendant(items: ReadonlyMap<string, MatterThreadItem>): Set<string> {
  const parents = new Set<string>();
  for (const item of items.values()) {
    if (item.attention !== "needs") continue;
    const visited = new Set([item.key]);
    let ancestor = item.parentKey;
    while (ancestor !== null && !visited.has(ancestor)) {
      visited.add(ancestor);
      parents.add(ancestor);
      ancestor = items.get(ancestor)?.parentKey ?? null;
    }
  }
  return parents;
}

type TimelineRow = MatterThreadItem & { readonly row: ThreadListV2ThreadListItem };

function rowInfo(
  item: TimelineRow,
  section: MatterTimelineSection<TimelineRow>,
  options: { readonly childNeedsYou: boolean; readonly nowMs: number },
): MatterTimelineRowInfo {
  const state = timelineRowState(item, {
    childNeedsYou: options.childNeedsYou,
    sort: "updated",
    nowMs: options.nowMs,
  });
  return {
    density: section.density,
    tone: state.tone,
    needsKind: state.tone === "needs" ? state.kind : null,
    timeText: state.tone === "running" || state.tone === "background" ? state.elapsed : state.age,
    unread: item.unread,
    quiet: section.kind === "snoozed" || section.kind === "settled",
    projectName: item.projectName,
    branchLabel:
      item.branch === null ? null : shortTimelineBranchLabel(item.branch, item.projectName),
    worktree: item.worktreePath !== null,
    goal: item.interactionMode === "goal",
    pullRequestNumber: item.pullRequest?.number ?? null,
    pullRequestState: item.pullRequest?.state ?? null,
  };
}

/**
 * Files the thread list's rows into Timeline sections. Membership stays the list's own (scope,
 * filters, settle and snooze support), so swipe actions match each row; only the order and the
 * section headers are the Timeline's. A folded section still shows the open thread.
 */
export function arrangeMatterTimelineList(input: {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly timelineItems: ReadonlyMap<string, MatterThreadItem>;
  readonly folds: Readonly<Record<string, boolean>>;
  readonly nowMs: number;
  readonly selectedThreadKey: string | null;
  readonly snoozedCount: number;
  readonly settledCount: number;
}): ReadonlyArray<MatterTimelineListItem> {
  const needsChildParents = parentsWithNeedsDescendant(input.timelineItems);
  const pending: MatterTimelineListItem[] = [];
  const rows: TimelineRow[] = [];
  for (const entry of input.items) {
    if (entry.type === "v2-pending") pending.push(entry);
    if (entry.type !== "v2-thread") continue;
    const { thread, pinned, snoozed, variant } = entry.item;
    const item = input.timelineItems.get(`${thread.environmentId}:${thread.id}`);
    if (item === undefined) continue;
    rows.push({ ...item, pinned, snoozed, settled: variant === "slim" && !snoozed, row: entry });
  }
  const sections = [
    ...buildTimelineSections(rows, {
      nowMs: input.nowMs,
      sort: "updated",
      projectFilter: null,
      filter: "all",
      needsChildParents,
    }),
  ];
  // A folded Archived section lists none of its rows, which load in pages only while it is open.
  if (input.settledCount > 0 && !sections.some((section) => section.kind === "settled")) {
    sections.push(emptyTimelineSettledSection<TimelineRow>());
  }
  const result: MatterTimelineListItem[] = pending.map((entry) =>
    entry.type === "v2-pending" ? { ...entry, showTrailingDivider: false } : entry,
  );
  sections.forEach((section, index) => {
    const open = isTimelineSectionOpen(section, input.folds);
    const shown = open
      ? section.items
      : section.items.filter((item) => item.key === input.selectedThreadKey);
    result.push({
      type: "matter-timeline-section",
      key: `matter-timeline-section:${section.id}`,
      sectionId: section.id,
      kind: section.kind,
      monthStartMs: section.monthStartMs,
      showYear:
        section.monthStartMs !== null &&
        new Date(section.monthStartMs).getFullYear() !== new Date(input.nowMs).getFullYear(),
      count:
        section.kind === "settled"
          ? input.settledCount
          : section.kind === "snoozed"
            ? input.snoozedCount
            : section.items.length,
      open,
      foldable: section.foldable,
      hiddenUnread: !open && section.items.some((item) => item.unread && !shown.includes(item)),
      first: index === 0 && pending.length === 0,
    });
    for (const item of shown) {
      result.push({
        ...item.row,
        showTrailingDivider: false,
        matter: rowInfo(item, section, {
          childNeedsYou: needsChildParents.has(item.key),
          nowMs: input.nowMs,
        }),
      });
    }
  });
  return result;
}

function rowInfoEqual(
  left: MatterTimelineRowInfo | undefined,
  right: MatterTimelineRowInfo | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.density === right.density &&
    left.tone === right.tone &&
    left.needsKind === right.needsKind &&
    left.timeText === right.timeText &&
    left.unread === right.unread &&
    left.quiet === right.quiet &&
    left.projectName === right.projectName &&
    left.branchLabel === right.branchLabel &&
    left.worktree === right.worktree &&
    left.goal === right.goal &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.pullRequestState === right.pullRequestState
  );
}

/** Content equality, so a minute tick re-renders only the rows whose time text changed. */
export function matterTimelineListItemsAreEqual(
  previous: MatterTimelineListItem,
  item: MatterTimelineListItem,
): boolean {
  if (isMatterTimelineSectionListItem(item) || isMatterTimelineSectionListItem(previous)) {
    return (
      isMatterTimelineSectionListItem(item) &&
      isMatterTimelineSectionListItem(previous) &&
      previous.key === item.key &&
      previous.monthStartMs === item.monthStartMs &&
      previous.showYear === item.showYear &&
      previous.count === item.count &&
      previous.open === item.open &&
      previous.foldable === item.foldable &&
      previous.hiddenUnread === item.hiddenUnread &&
      previous.first === item.first
    );
  }
  if (!threadListV2ListItemsAreEqual(previous, item)) return false;
  return (
    item.type !== "v2-thread" ||
    previous.type !== "v2-thread" ||
    rowInfoEqual(previous.matter, item.matter)
  );
}
