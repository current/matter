import {
  emptyTimelineSettledSection,
  isTimelineSectionOpen,
} from "@t3tools/client-runtime/matter/timeline-feed";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { useThreadListV2ShelfPreferences } from "../../threads/use-thread-list-v2-shelf-preferences";
import type { ThreadListV2Layout, ThreadListV2ListItem } from "../../threads/threadListV2";
import {
  arrangeMatterTimelineList,
  buildMatterTimelineItems,
  type MatterTimelineListItem,
} from "./matterTimelineList";
import { setMatterTimelineFold, useMatterTimelineFolds } from "./matterTimelineFolds";

export interface MatterTimelineState {
  /** Off while searching: search lists matches by rank, as desktop's Timeline does. */
  readonly active: boolean;
  readonly folds: Readonly<Record<string, boolean>>;
}

/**
 * The thread list's shelf preferences with the Timeline's folds in charge. While it is active the
 * list keeps every row (Working and Snoozed expanded, so no row hides behind an upstream shelf),
 * and Archived pages its older rows in only while that section is open.
 */
export function useMatterTimelineShelfPreferences(searchQuery: string) {
  const preferences = useThreadListV2ShelfPreferences();
  const { folds, loaded } = useMatterTimelineFolds();
  const active = searchQuery.trim().length === 0;
  const matterTimeline: MatterTimelineState = { active, folds };
  if (!active) return { ...preferences, matterTimeline };
  return {
    ...preferences,
    loaded: preferences.loaded && loaded,
    workingShelfEnabled: true,
    workingShelfExpanded: true,
    snoozedShelfExpanded: true,
    settledShelfExpanded: isTimelineSectionOpen(emptyTimelineSettledSection(), folds),
    matterTimeline,
  };
}

/** The list's rows in Timeline order with section headers, or the rows untouched while off. */
export function useMatterTimelineListItems(input: {
  readonly timeline: MatterTimelineState;
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly layout: Pick<ThreadListV2Layout, "snoozedCount" | "settledCount">;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectNameByKey: ReadonlyMap<string, string>;
  readonly now: string;
  readonly selectedThreadKey: string | null;
}): ReadonlyArray<MatterTimelineListItem> {
  const { active, folds } = input.timeline;
  const timelineItems = useMemo(
    () =>
      active
        ? buildMatterTimelineItems({
            threads: input.threads,
            projectNameByKey: input.projectNameByKey,
            nowIso: input.now,
          })
        : null,
    [active, input.threads, input.projectNameByKey, input.now],
  );
  return useMemo(
    () =>
      timelineItems === null
        ? input.items
        : arrangeMatterTimelineList({
            items: input.items,
            timelineItems,
            folds,
            nowMs: Date.parse(input.now),
            selectedThreadKey: input.selectedThreadKey,
            snoozedCount: input.layout.snoozedCount,
            settledCount: input.layout.settledCount,
          }),
    [
      timelineItems,
      input.items,
      folds,
      input.now,
      input.selectedThreadKey,
      input.layout.snoozedCount,
      input.layout.settledCount,
    ],
  );
}

export function toggleMatterTimelineSection(sectionId: string, open: boolean) {
  setMatterTimelineFold(sectionId, !open);
}
