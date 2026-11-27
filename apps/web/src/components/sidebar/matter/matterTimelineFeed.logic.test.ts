import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import type { MatterChildItem } from "./matterFinalSidebar.logic";
import {
  buildTimelineSections,
  isTimelineSectionOpen,
  timelineRowState,
  shortTimelineBranchLabel,
  visibleTimelineSubagents,
} from "./matterTimelineFeed.logic";
import { toMatterThreadItem } from "./matterSidebar.logic";

// Sections follow local calendar days, so the fixtures are built in local time. "Now" is noon on
// 10 March 2026; threads start in January 2025, so their last message decides the section.
const local = (month: number, day: number, hour = 9, year = 2026) =>
  new Date(year, month - 1, day, hour).toISOString();
const NOW_ISO = local(3, 10, 12);
const NOW_MS = Date.parse(NOW_ISO);
const env = EnvironmentId.make("local");
const MATTER = { key: "local:matter", name: "Matter" };
const LILT = { key: "local:lilt", name: "Lilt" };

function item(
  id: string,
  overrides: ThreadFixtureOverrides = {},
  project: { key: string; name: string } | null = MATTER,
) {
  return toMatterThreadItem(
    makeThreadFixture({
      environmentId: env,
      id: ThreadId.make(id),
      projectId: ProjectId.make(project?.key ?? "none"),
      title: id,
      createdAt: local(1, 5, 9, 2025),
      latestUserMessageAt: local(3, 10, 11),
      ...overrides,
    }),
    project,
    NOW_ISO,
  );
}

const running = {
  runtime: {
    status: "running" as const,
    activeRunId: RunId.make("run"),
    activityStartedAt: new Date(NOW_MS - 12 * 60_000).toISOString(),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerName: "Claude",
    lastError: null,
    updatedAt: NOW_ISO,
  },
};

const options = { nowMs: NOW_MS, sort: "updated", projectFilter: null, filter: "all" } as const;
const shape = (sections: ReturnType<typeof buildTimelineSections>) =>
  sections.map((section) => [section.id, section.items.map((entry) => entry.title)]);

describe("buildTimelineSections", () => {
  it("leads with what waits on you, then pinned, then what is working", () => {
    const sections = buildTimelineSections(
      [
        item("today"),
        item("old and running", { ...running, latestUserMessageAt: local(2, 1) }),
        item("pinned", { pinnedAt: local(3, 1) }),
        item("pinned and running", { ...running, pinnedAt: local(3, 1) }),
        item("asks", { hasPendingApprovals: true, latestUserMessageAt: local(1, 20) }),
        item("pinned and asks", { hasPendingUserInput: true, pinnedAt: local(3, 1) }),
      ],
      options,
    );
    expect(shape(sections)).toEqual([
      ["needs", ["pinned and asks", "asks"]],
      ["pinned", ["pinned"]],
      ["working", ["pinned and running", "old and running"]],
      ["today", ["today"]],
    ]);
  });

  it("files the rest by day, rolling week and month, then calendar month", () => {
    const sections = buildTimelineSections(
      [
        item("this morning", { latestUserMessageAt: local(3, 10, 1) }),
        item("last night", { latestUserMessageAt: local(3, 9, 23) }),
        item("five days ago", { latestUserMessageAt: local(3, 5) }),
        item("seven days ago", { latestUserMessageAt: local(3, 3, 0) }),
        item("eight days ago", { latestUserMessageAt: local(3, 2, 23) }),
        item("thirty days ago", { latestUserMessageAt: local(2, 8, 0) }),
        item("early february", { latestUserMessageAt: local(2, 7, 23) }),
        item("late january", { latestUserMessageAt: local(1, 30) }),
        item("early january", { latestUserMessageAt: local(1, 2) }),
        item("last year", { latestUserMessageAt: local(11, 12, 9, 2025) }),
      ],
      options,
    );
    expect(shape(sections)).toEqual([
      ["today", ["this morning"]],
      ["yesterday", ["last night"]],
      ["week", ["five days ago", "seven days ago"]],
      ["days30", ["eight days ago", "thirty days ago"]],
      ["2026-02", ["early february"]],
      ["2026-01", ["late january", "early january"]],
      ["2025-11", ["last year"]],
    ]);
    expect(sections.at(-1)?.monthStartMs).toBe(new Date(2025, 10, 1).getTime());
  });

  it("keeps recent rows on two lines and opens only the last week by default", () => {
    const sections = buildTimelineSections(
      [
        item("asks", { hasPendingApprovals: true }),
        item("today"),
        item("yesterday", { latestUserMessageAt: local(3, 9) }),
        item("week", { latestUserMessageAt: local(3, 5) }),
        item("month", { latestUserMessageAt: local(2, 20) }),
        item("january", { latestUserMessageAt: local(1, 20) }),
      ],
      options,
    );
    expect(
      sections.map((section) => [section.id, section.density, isTimelineSectionOpen(section, {})]),
    ).toEqual([
      ["needs", "full", true],
      ["today", "full", true],
      ["yesterday", "full", true],
      ["week", "compact", true],
      ["days30", "compact", false],
      ["2026-01", "compact", false],
    ]);
  });

  it("follows a saved fold, except for the section that waits on you", () => {
    const [needs, today] = buildTimelineSections(
      [item("asks", { hasPendingApprovals: true }), item("today")],
      options,
    );
    expect(isTimelineSectionOpen(today!, { today: false })).toBe(false);
    expect(isTimelineSectionOpen(needs!, { needs: false })).toBe(true);
    expect(isTimelineSectionOpen({ id: "2026-01", foldable: true, openByDefault: false }, {})).toBe(
      false,
    );
    expect(
      isTimelineSectionOpen(
        { id: "2026-01", foldable: true, openByDefault: false },
        { "2026-01": true },
      ),
    ).toBe(true);
  });

  it("lists a settled thread only while it or a subagent waits on you", () => {
    const settled = item("settled", { settledOverride: "settled" });
    const settledAsks = item("settled asks", {
      settledOverride: "settled",
      hasPendingApprovals: true,
    });
    const parent = item("settled parent", { settledOverride: "settled" });
    expect(
      shape(
        buildTimelineSections([settled, settledAsks, parent], {
          ...options,
          needsChildParents: new Set([parent.key]),
        }),
      ),
    ).toEqual([["needs", ["settled asks", "settled parent"]]]);
  });

  it("narrows to a project and to the Needs you filter", () => {
    const threads = [
      item("matter"),
      item("lilt", {}, LILT),
      item("lilt asks", { hasPendingApprovals: true }, LILT),
    ];
    expect(shape(buildTimelineSections(threads, { ...options, projectFilter: LILT.key }))).toEqual([
      ["needs", ["lilt asks"]],
      ["today", ["lilt"]],
    ]);
    expect(shape(buildTimelineSections(threads, { ...options, filter: "needs" }))).toEqual([
      ["needs", ["lilt asks"]],
    ]);
  });

  it("files by creation time when sorted by created", () => {
    const sections = buildTimelineSections(
      [
        item("made today", { createdAt: local(3, 10, 8), latestUserMessageAt: local(3, 10, 9) }),
        item("made long ago, active today"),
      ],
      { ...options, sort: "created" },
    );
    expect(shape(sections)).toEqual([
      ["today", ["made today"]],
      ["2025-01", ["made long ago, active today"]],
    ]);
  });
});

describe("timelineRowState", () => {
  const stateOptions = { childNeedsYou: false, sort: "updated", nowMs: NOW_MS } as const;

  it("names what a thread waits on, its own request before a subagent's", () => {
    expect(timelineRowState(item("a", { hasPendingApprovals: true }), stateOptions)).toEqual({
      tone: "needs",
      kind: "approval",
    });
    expect(
      timelineRowState(item("b", { hasPendingUserInput: true }), {
        ...stateOptions,
        childNeedsYou: true,
      }),
    ).toEqual({ tone: "needs", kind: "input" });
    expect(timelineRowState(item("c", running), { ...stateOptions, childNeedsYou: true })).toEqual({
      tone: "needs",
      kind: "subagent",
    });
  });

  it("shows how long a run has gone, and an idle thread's age", () => {
    expect(timelineRowState(item("a", running), stateOptions)).toEqual({
      tone: "running",
      elapsed: "12m",
    });
    expect(timelineRowState(item("b"), stateOptions)).toEqual({ tone: "idle", age: "1h" });
    expect(
      timelineRowState(item("c", { createdAt: local(3, 8, 12) }), {
        ...stateOptions,
        sort: "created",
      }),
    ).toEqual({ tone: "idle", age: "2d" });
  });

  it("lists a thread waiting on awaited background work under Working, without the spinner", () => {
    const waiting = item("waiting", {
      runtime: { ...running.runtime, status: "idle", activeRunId: null },
      pendingBackgroundTasks: [{ taskId: "replay", kind: "command", awaited: true }],
    });
    expect(timelineRowState(waiting, stateOptions)).toEqual({ tone: "background", elapsed: "12m" });
    expect(shape(buildTimelineSections([waiting], options))).toEqual([["working", ["waiting"]]]);
  });
});

describe("visibleTimelineSubagents", () => {
  const child = (id: string, overrides: ThreadFixtureOverrides = running): MatterChildItem => ({
    ...item(id, overrides),
    ancestorKey: "parent",
  });
  const titles = (rows: ReadonlyArray<MatterChildItem>) => rows.map((row) => row.title);

  it("shows every subagent while there are only a few", () => {
    const active = [child("a"), child("b"), child("c"), child("d")];
    expect(visibleTimelineSubagents(active, { expanded: false, activeThreadKey: null })).toEqual({
      shown: active,
      hiddenCount: 0,
    });
  });

  it("keeps three rows and counts the rest", () => {
    const active = ["a", "b", "c", "d", "e", "f"].map((id) => child(id));
    const rows = visibleTimelineSubagents(active, { expanded: false, activeThreadKey: null });
    expect(titles(rows.shown)).toEqual(["a", "b", "c"]);
    expect(rows.hiddenCount).toBe(3);
    expect(visibleTimelineSubagents(active, { expanded: true, activeThreadKey: null })).toEqual({
      shown: active,
      hiddenCount: 0,
    });
  });

  it("always shows the ones waiting on you and the open one", () => {
    const active = [
      child("asks 1", { hasPendingApprovals: true }),
      child("asks 2", { hasPendingApprovals: true }),
      child("a"),
      child("b"),
      child("c"),
      child("open"),
    ];
    const rows = visibleTimelineSubagents(active, {
      expanded: false,
      activeThreadKey: active[5]!.key,
    });
    expect(titles(rows.shown)).toEqual(["asks 1", "asks 2", "open"]);
    expect(rows.hiddenCount).toBe(3);
  });

  it("never hides a single subagent behind the more row", () => {
    const active = [
      child("asks 1", { hasPendingApprovals: true }),
      child("asks 2", { hasPendingApprovals: true }),
      child("asks 3", { hasPendingApprovals: true }),
      child("asks 4", { hasPendingApprovals: true }),
      child("a"),
    ];
    expect(visibleTimelineSubagents(active, { expanded: false, activeThreadKey: null })).toEqual({
      shown: active,
      hiddenCount: 0,
    });
  });
});

describe("shortTimelineBranchLabel", () => {
  it("drops the worktree prefix and a repeat of the project name", () => {
    expect(shortTimelineBranchLabel("t3/timeline-sidebar-fable", "Matter")).toBe(
      "timeline-sidebar-fable",
    );
    expect(shortTimelineBranchLabel("matter/feature-x", "Matter")).toBe("feature-x");
    expect(shortTimelineBranchLabel("T3Code/fix", null)).toBe("fix");
  });

  it("keeps every other branch as it is", () => {
    expect(shortTimelineBranchLabel("main", "Matter")).toBe("main");
    expect(shortTimelineBranchLabel("feat/composer", "Matter")).toBe("feat/composer");
    expect(shortTimelineBranchLabel("matter/", "Matter")).toBe("matter/");
  });
});
