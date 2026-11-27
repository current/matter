import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../../test-fixtures";
import { buildThreadListV2Items, buildThreadListV2ListItems } from "../../threads/threadListV2";
import {
  arrangeMatterTimelineList,
  buildMatterTimelineItems,
  isMatterTimelineSectionListItem,
  matterTimelineListItemsAreEqual,
  threadListItemsOf,
  type MatterTimelineListItem,
} from "./matterTimelineList";
import { parseMatterTimelineFolds } from "./matterTimelineFolds";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-10T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const hoursAgo = (hours: number) => new Date(NOW_MS - hours * 3_600_000).toISOString();

function thread(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    createdAt: hoursAgo(24 * 90),
    latestUserMessageAt: hoursAgo(1),
    ...overrides,
  });
}

const running = (startedHoursAgo: number): Partial<EnvironmentThreadShell> => ({
  runtime: {
    status: "running",
    activeRunId: RunId.make("run"),
    activityStartedAt: hoursAgo(startedHoursAgo),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerName: "Claude",
    lastError: null,
    updatedAt: NOW,
  },
});

/** The list as HomeScreen builds it with the Timeline's shelf overrides. */
function arrange(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: { folds?: Record<string, boolean>; selectedThreadKey?: string | null } = {},
) {
  const settledOpen = options.folds?.settled === true;
  const layout = buildThreadListV2Items({
    threads,
    environmentId: null,
    searchQuery: "",
    now: NOW,
    workingShelfEnabled: true,
    workingShelfExpanded: true,
    snoozedShelfExpanded: true,
    settledShelfExpanded: settledOpen,
    selectedThreadKey: options.selectedThreadKey ?? null,
  });
  const items = buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks: [],
    workingCount: layout.workingCount,
    workingShelfExpanded: true,
    workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded: true,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfExpanded: settledOpen,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
  });
  return arrangeMatterTimelineList({
    items,
    timelineItems: buildMatterTimelineItems({
      threads,
      projectNameByKey: new Map(),
      nowIso: NOW,
    }),
    folds: options.folds ?? {},
    nowMs: NOW_MS,
    selectedThreadKey: options.selectedThreadKey ?? null,
    snoozedCount: layout.snoozedCount,
    settledCount: layout.settledCount,
  });
}

function shape(list: ReadonlyArray<MatterTimelineListItem>) {
  return list.map((item) =>
    isMatterTimelineSectionListItem(item)
      ? `# ${item.sectionId} ${item.count}${item.open ? "" : " (folded)"}`
      : item.type === "v2-thread"
        ? `${item.item.thread.title} ${item.matter?.tone ?? "?"} ${item.matter?.timeText ?? ""}`
        : item.type,
  );
}

describe("arrangeMatterTimelineList", () => {
  it("files the list's rows into Timeline sections", () => {
    const list = arrange([
      thread("today"),
      thread("old", { latestUserMessageAt: hoursAgo(24 * 3) }),
      thread("running", running(0.5)),
      thread("asks", { hasPendingApprovals: true }),
      thread("pinned", { pinnedAt: hoursAgo(5) }),
      thread("archived", { settledOverride: "settled", settledAt: hoursAgo(2) }),
    ]);
    expect(shape(list)).toEqual([
      "# needs 1",
      "asks needs 1h",
      "# pinned 1",
      "pinned idle 1h",
      "# working 1",
      "running running 30m",
      "# today 1",
      "today idle 1h",
      "# week 1",
      "old idle 3d",
      "# settled 1 (folded)",
    ]);
  });

  it("opens Archived from its fold and keeps the open thread in a folded section", () => {
    const threads = [
      thread("archived", { settledOverride: "settled", settledAt: hoursAgo(2) }),
      thread("old", { latestUserMessageAt: hoursAgo(24 * 3) }),
    ];
    expect(shape(arrange(threads, { folds: { settled: true, week: false } }))).toEqual([
      "# week 1 (folded)",
      "# settled 1",
      "archived idle 1h",
    ]);
    expect(
      shape(arrange(threads, { selectedThreadKey: `${environmentId}:archived` })).slice(-2),
    ).toEqual(["# settled 1 (folded)", "archived idle 1h"]);
  });

  it("shows a thread as Active while a subagent below it runs", () => {
    const parent = thread("parent", { latestUserMessageAt: hoursAgo(24 * 2) });
    const child = thread("child", {
      ...running(0.25),
      lineage: {
        parentThreadId: parent.id,
        rootThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
    expect(shape(arrange([parent, child]))).toEqual(["# working 1", "parent running 15m"]);
  });

  it("leaves section headers out of the rows upstream helpers read", () => {
    expect(threadListItemsOf(arrange([thread("today")])).map((item) => item.type)).toEqual([
      "v2-thread",
    ]);
  });

  it("compares rows by what they show", () => {
    const [header, row] = arrange([thread("today")]);
    const [, laterRow] = arrange([thread("today", { latestUserMessageAt: hoursAgo(2) })]);
    expect(matterTimelineListItemsAreEqual(header!, header!)).toBe(true);
    expect(matterTimelineListItemsAreEqual(header!, row!)).toBe(false);
    expect(matterTimelineListItemsAreEqual(row!, laterRow!)).toBe(false);
  });
});

describe("parseMatterTimelineFolds", () => {
  it("keeps only boolean folds and survives a damaged file", () => {
    expect(parseMatterTimelineFolds('{"week":false,"settled":true,"x":1}')).toEqual({
      week: false,
      settled: true,
    });
    expect(parseMatterTimelineFolds("{nope")).toEqual({});
    expect(parseMatterTimelineFolds(null)).toEqual({});
  });
});
