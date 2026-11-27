// @effect-diagnostics globalDate:off - Fixtures are built in local calendar time, as the sections read them.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTimelineSections,
  compactAge,
  isTimelineSectionOpen,
  timelineRowState,
  withDescendantWork,
  workingDescendantSince,
  type MatterThreadItem,
} from "./timelineFeed.ts";

// Sections follow local calendar days, so fixtures are built in local time. "Now" is noon on
// 10 March 2026.
const local = (month: number, day: number, hour = 9, year = 2026) =>
  new Date(year, month - 1, day, hour).toISOString();
const NOW_MS = Date.parse(local(3, 10, 12));
const environmentId = EnvironmentId.make("local");

function item(id: string, overrides: Partial<MatterThreadItem> = {}): MatterThreadItem {
  return {
    key: `local:${id}`,
    ref: { environmentId, threadId: ThreadId.make(id) },
    title: id,
    projectKey: "local:matter",
    projectName: "Matter",
    attention: "idle",
    needsKind: null,
    failed: false,
    unread: false,
    pinned: false,
    settled: false,
    snoozed: false,
    activityAt: local(3, 10, 11),
    runningSince: null,
    waitsOnBackground: false,
    providerName: null,
    driver: null,
    pullRequest: null,
    parentKey: null,
    createdAt: local(1, 5, 9, 2025),
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const options = { nowMs: NOW_MS, sort: "updated", projectFilter: null, filter: "all" } as const;
const shape = (sections: ReturnType<typeof buildTimelineSections>) =>
  sections.map((section) => [section.id, section.items.map((entry) => entry.title)]);

describe("buildTimelineSections", () => {
  it("orders state first, then days, months and the put-away tail", () => {
    const sections = buildTimelineSections(
      [
        item("archived", { settled: true, settledAt: local(3, 9) }),
        item("snoozed", { snoozed: true }),
        item("february", { activityAt: local(2, 1) }),
        item("last week", { activityAt: local(3, 5) }),
        item("yesterday", { activityAt: local(3, 9) }),
        item("today"),
        item("running", { attention: "running", runningSince: local(3, 10, 11) }),
        item("pinned", { pinned: true }),
        item("asks", { attention: "needs", needsKind: "approval" }),
        item("failed unread", { failed: true, unread: true }),
      ],
      options,
    );
    expect(shape(sections)).toEqual([
      ["needs", ["asks", "failed unread"]],
      ["pinned", ["pinned"]],
      ["working", ["running"]],
      ["today", ["today"]],
      ["yesterday", ["yesterday"]],
      ["week", ["last week"]],
      ["2026-02", ["february"]],
      ["snoozed", ["snoozed"]],
      ["settled", ["archived"]],
    ]);
    expect(sections.find((section) => section.id === "week")?.density).toBe("compact");
  });

  it("lists the newest run first under Active", () => {
    const sections = buildTimelineSections(
      [
        item("older run", { attention: "running", runningSince: local(3, 10, 8) }),
        item("newer run", { attention: "running", runningSince: local(3, 10, 11) }),
      ],
      options,
    );
    expect(shape(sections)).toEqual([["working", ["newer run", "older run"]]]);
  });

  it("drops a read failure back to its day", () => {
    expect(shape(buildTimelineSections([item("failed", { failed: true })], options))).toEqual([
      ["today", ["failed"]],
    ]);
  });

  it("keeps generic item fields on the rows it returns", () => {
    const rows = [{ ...item("today"), extra: 1 }];
    expect(buildTimelineSections(rows, options)[0]?.items[0]?.extra).toBe(1);
  });
});

describe("isTimelineSectionOpen", () => {
  it("prefers the saved fold, else the section's default, and never folds Needs you", () => {
    const [needs, settled] = buildTimelineSections(
      [item("asks", { attention: "needs" }), item("archived", { settled: true })],
      options,
    );
    expect(isTimelineSectionOpen(needs!, { needs: false })).toBe(true);
    expect(isTimelineSectionOpen(settled!, {})).toBe(false);
    expect(isTimelineSectionOpen(settled!, { settled: true })).toBe(true);
  });
});

describe("timelineRowState", () => {
  const state = (entry: MatterThreadItem, childNeedsYou = false) =>
    timelineRowState(entry, { childNeedsYou, sort: "updated", nowMs: NOW_MS });

  it("names what the row waits on, or how long it has run", () => {
    expect(state(item("a", { attention: "needs", needsKind: "input" }))).toEqual({
      tone: "needs",
      kind: "input",
      age: "1h",
    });
    expect(state(item("b"), true)).toMatchObject({ tone: "needs", kind: "subagent" });
    expect(
      state(item("c", { attention: "running", runningSince: local(3, 10, 11, 2026) })),
    ).toEqual({ tone: "running", elapsed: "1h" });
    expect(
      state(item("d", { attention: "running", waitsOnBackground: true, runningSince: null })),
    ).toEqual({ tone: "background", elapsed: "1h" });
    expect(state(item("e", { failed: true }))).toEqual({ tone: "failed", age: "1h" });
    expect(state(item("f"))).toEqual({ tone: "idle", age: "1h" });
  });
});

describe("withDescendantWork", () => {
  it("shows every ancestor of a running subagent as running since its earliest start", () => {
    const items = [
      item("parent"),
      item("child", { parentKey: "local:parent" }),
      item("grandchild", {
        parentKey: "local:child",
        attention: "running",
        runningSince: local(3, 10, 10),
      }),
      item("asks", { attention: "needs" }),
      item("asks child", {
        parentKey: "local:asks",
        attention: "running",
        runningSince: local(3, 10, 10),
      }),
    ];
    const result = withDescendantWork(items, workingDescendantSince(items));
    expect(result.map((entry) => [entry.title, entry.attention, entry.runningSince])).toEqual([
      ["parent", "running", local(3, 10, 10)],
      ["child", "running", local(3, 10, 10)],
      ["grandchild", "running", local(3, 10, 10)],
      ["asks", "needs", null],
      ["asks child", "running", local(3, 10, 10)],
    ]);
  });
});

describe("compactAge", () => {
  it("keeps one short shape", () => {
    expect(compactAge(new Date(NOW_MS - 30_000).toISOString(), NOW_MS)).toBe("1m");
    expect(compactAge(new Date(NOW_MS - 3 * 86_400_000).toISOString(), NOW_MS)).toBe("3d");
    expect(compactAge("nope", NOW_MS)).toBe("");
  });
});
