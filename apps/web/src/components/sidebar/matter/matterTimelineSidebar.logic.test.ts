import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { attachListedAncestors } from "./mattrFinalSidebar.logic";
import { toMattrThreadItem } from "./mattrSidebar.logic";
import {
  activeSubagentsByParent,
  buildTimelineBuckets,
  compactWindowLabel,
  isActiveSubagent,
  subagentElapsed,
  usageMeterTone,
  workspaceKind,
} from "./mattrTimelineSidebar.logic";

// Buckets follow local calendar days, so the fixtures are built in local time. Threads start on
// the 1st, so their last message decides the bucket.
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 2, day, hour, minute).toISOString();
const NOW_ISO = local(10, 15);
const NOW_MS = Date.parse(NOW_ISO);
const env = EnvironmentId.make("local");
const MATTR = { key: "local:mattr", name: "mattr" };
const LILT = { key: "local:lilt", name: "Lilt" };

function item(
  id: string,
  overrides: ThreadFixtureOverrides = {},
  project: { key: string; name: string } | null = MATTR,
) {
  return toMattrThreadItem(
    makeThreadFixture({
      environmentId: env,
      id: ThreadId.make(id),
      projectId: ProjectId.make(project?.key ?? "none"),
      title: id,
      createdAt: local(1, 9),
      latestUserMessageAt: local(10, 14),
      ...overrides,
    }),
    project,
    NOW_ISO,
  );
}

const runtime = (status: "running" | "completed" | "failed") => ({
  runtime: {
    status,
    activeRunId: status === "running" ? RunId.make("run") : null,
    activityStartedAt: local(10, 14, 52),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerName: "Claude",
    lastError: status === "failed" ? "boom" : null,
    updatedAt: NOW_ISO,
  },
});

const subagentOf = (parent: string) => ({
  lineage: {
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "subagent" as const,
  },
});

function children(...items: ReturnType<typeof item>[]) {
  const threads = items.map((child) =>
    makeThreadFixture({
      environmentId: env,
      id: child.ref.threadId,
      projectId: ProjectId.make("local:mattr"),
      lineage: {
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
      },
    }),
  );
  threads.push(makeThreadFixture({ environmentId: env, id: ThreadId.make("parent") }));
  return attachListedAncestors(items, threads);
}

const bucketTitles = (buckets: ReturnType<typeof buildTimelineBuckets>) => ({
  pinned: buckets.pinned.map((entry) => entry.title),
  recent: buckets.recent.map((entry) => entry.title),
  yesterday: buckets.yesterday.map((entry) => entry.title),
  earlier: buckets.earlier.map((entry) => entry.title),
});

const options = {
  nowMs: NOW_MS,
  sort: "updated",
  projectFilter: null,
  filter: "all",
} as const;

describe("buildTimelineBuckets", () => {
  it("splits threads by local calendar day, newest first", () => {
    const buckets = buildTimelineBuckets(
      [
        item("today early", { latestUserMessageAt: local(10, 0, 30) }),
        item("today late", { latestUserMessageAt: local(10, 14) }),
        item("yesterday", { latestUserMessageAt: local(9, 23, 59) }),
        item("last week", { latestUserMessageAt: local(3, 12) }),
      ],
      options,
    );
    expect(bucketTitles(buckets)).toEqual({
      pinned: [],
      recent: ["today late", "today early"],
      yesterday: ["yesterday"],
      earlier: ["last week"],
    });
  });

  it("places pinned threads in their own top bucket, respecting filters and sort", () => {
    const pinnedOld = item("pinned old", {
      pinnedAt: local(1, 9),
      latestUserMessageAt: local(2, 9),
    });
    const pinnedNew = item("pinned new", {
      pinnedAt: local(1, 9),
      latestUserMessageAt: local(10, 14),
    });
    const pinnedLilt = item("pinned lilt", { pinnedAt: local(1, 9) }, LILT);
    const regular = item("regular");
    const all = [pinnedOld, pinnedNew, pinnedLilt, regular];

    expect(bucketTitles(buildTimelineBuckets(all, options))).toEqual({
      pinned: ["pinned new", "pinned lilt", "pinned old"],
      recent: ["regular"],
      yesterday: [],
      earlier: [],
    });
    expect(
      bucketTitles(buildTimelineBuckets(all, { ...options, projectFilter: LILT.key })),
    ).toEqual({
      pinned: ["pinned lilt"],
      recent: [],
      yesterday: [],
      earlier: [],
    });
  });

  it("keeps running and waiting threads in Recent whatever their age", () => {
    const buckets = buildTimelineBuckets(
      [
        item("old running", { latestUserMessageAt: local(2, 9), ...runtime("running") }),
        item("old approval", { latestUserMessageAt: local(2, 9), hasPendingApprovals: true }),
      ],
      options,
    );
    expect(buckets.recent.map((entry) => entry.title).toSorted()).toEqual([
      "old approval",
      "old running",
    ]);
    expect(buckets.earlier).toEqual([]);
  });

  it("buckets by creation time when sorted by created", () => {
    const thread = item("made yesterday", {
      createdAt: local(9, 10),
      latestUserMessageAt: local(10, 14),
    });
    expect(buildTimelineBuckets([thread], options).recent).toHaveLength(1);
    expect(buildTimelineBuckets([thread], { ...options, sort: "created" }).yesterday).toHaveLength(
      1,
    );
  });

  it("leaves out settled threads and honors the project and Needs you filters", () => {
    const quiet = item("quiet");
    const settled = item("settled", { settledOverride: "settled" });
    const lilt = item("lilt", {}, LILT);
    const waiting = item("waiting", { hasPendingApprovals: true });
    const all = [quiet, settled, lilt, waiting];
    expect(buildTimelineBuckets(all, options).recent.map((entry) => entry.title)).not.toContain(
      "settled",
    );
    expect(
      buildTimelineBuckets(all, { ...options, projectFilter: LILT.key }).recent.map(
        (entry) => entry.title,
      ),
    ).toEqual(["lilt"]);
    expect(
      buildTimelineBuckets(all, { ...options, filter: "needs" }).recent.map((entry) => entry.title),
    ).toEqual(["waiting"]);
  });

  it("keeps an older thread in Recent while a subagent of it is still working", () => {
    const parent = item("parent", { latestUserMessageAt: local(2, 9) });
    const quiet = { ...options, activeChildParents: new Set<string>() };
    expect(buildTimelineBuckets([parent], quiet).earlier).toHaveLength(1);
    const working = { ...options, activeChildParents: new Set([parent.key]) };
    expect(buildTimelineBuckets([parent], working).recent).toHaveLength(1);
    expect(buildTimelineBuckets([parent], { ...working, sort: "created" }).recent).toHaveLength(1);
  });

  it("lists a quiet parent under Needs you while its subagent waits", () => {
    const parent = item("parent");
    const buckets = buildTimelineBuckets([parent, item("other")], {
      ...options,
      filter: "needs",
      needsChildParents: new Set([parent.key]),
    });
    expect(buckets.recent.map((entry) => entry.title)).toEqual(["parent"]);
  });
});

describe("activeSubagentsByParent", () => {
  const running = item("running child", { ...subagentOf("parent"), ...runtime("running") });
  const waiting = item("waiting child", { ...subagentOf("parent"), hasPendingApprovals: true });
  const done = item("done child", { ...subagentOf("parent"), ...runtime("completed") });
  const idle = item("idle child", subagentOf("parent"));
  const failed = item("failed child", { ...subagentOf("parent"), ...runtime("failed") });

  it("shows only running or waiting subagents, waiting first", () => {
    const index = activeSubagentsByParent(children(running, waiting, done, idle, failed), true);
    expect(index.get("local:parent")?.map((child) => child.title)).toEqual([
      "waiting child",
      "running child",
    ]);
  });

  it("hides finished subagents entirely", () => {
    const index = activeSubagentsByParent(children(done, idle, failed), true);
    expect(index.size).toBe(0);
    expect([done, idle, failed].some(isActiveSubagent)).toBe(false);
  });

  it("drops a subagent the moment its run finishes", () => {
    const before = activeSubagentsByParent(children(running), true);
    const after = activeSubagentsByParent(
      children(item("running child", { ...subagentOf("parent"), ...runtime("completed") })),
      true,
    );
    expect(before.get("local:parent")).toHaveLength(1);
    expect(after.get("local:parent")).toBeUndefined();
  });

  it("shows nothing while the setting is off", () => {
    expect(activeSubagentsByParent(children(running, waiting), false).size).toBe(0);
  });

  it("reports elapsed time from the run start", () => {
    expect(subagentElapsed(running, NOW_MS)).toBe("8m");
  });
});

describe("row details", () => {
  it("tells a worktree, local checkout, and detached No project thread apart", () => {
    expect(workspaceKind(item("wt", { worktreePath: "/repo/.worktrees/wt" }))).toBe("worktree");
    expect(workspaceKind(item("local", { worktreePath: null }))).toBe("local");
    expect(workspaceKind(item("scratch", { worktreePath: "/tmp/scratch" }, null))).toBe("none");
    expect(workspaceKind(item("scratch-plain", { worktreePath: null }, null))).toBe("none");
  });

  it("classifies usage meter severity thresholds", () => {
    expect(usageMeterTone(0)).toBe("normal");
    expect(usageMeterTone(74)).toBe("normal");
    expect(usageMeterTone(75)).toBe("warn");
    expect(usageMeterTone(94)).toBe("warn");
    expect(usageMeterTone(95)).toBe("critical");
    expect(usageMeterTone(100)).toBe("critical");
  });

  it("carries the branch and creation time", () => {
    const thread = item("branch", { branch: "mattr/sidebar" });
    expect(thread.branch).toBe("mattr/sidebar");
    expect(thread.createdAt).toBe(local(1, 9));
  });

  it("shortens limit window names", () => {
    expect(compactWindowLabel("5h")).toBe("5h");
    expect(compactWindowLabel("week")).toBe("wk");
    expect(compactWindowLabel("month")).toBe("mo");
  });
});
