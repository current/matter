import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { attachListedAncestors } from "./matterFinalSidebar.logic";
import { toMatterThreadItem } from "./matterSidebar.logic";
import {
  activeSubagentCounts,
  activeSubagentsByParent,
  compactWindowLabel,
  isActiveSubagent,
  usageMeterTone,
  workspaceKind,
} from "./matterTimelineSidebar.logic";

const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 2, day, hour, minute).toISOString();
const NOW_ISO = local(10, 15);
const env = EnvironmentId.make("local");
const MATTER = { key: "local:matter", name: "Matter" };

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
      projectId: ProjectId.make("local:matter"),
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
});

describe("activeSubagentCounts", () => {
  const running = item("running child", { ...subagentOf("parent"), ...runtime("running") });
  const waiting = item("waiting child", { ...subagentOf("parent"), hasPendingApprovals: true });
  const done = item("done child", { ...subagentOf("parent"), ...runtime("completed") });

  it("counts only running or waiting subagents", () => {
    const counts = activeSubagentCounts(children(running, waiting, done), new Map());
    expect(counts.get("local:parent")).toBe(2);
    expect(activeSubagentCounts(children(done), new Map()).size).toBe(0);
  });

  it("adds the thread's cloud runs and leaves idle threads out", () => {
    const counts = activeSubagentCounts(
      children(running, done),
      new Map([
        ["local:parent", [{}, {}]],
        ["local:quiet", []],
      ]),
    );
    expect(counts.get("local:parent")).toBe(3);
    expect(counts.has("local:quiet")).toBe(false);
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
    const thread = item("branch", { branch: "matter/sidebar" });
    expect(thread.branch).toBe("matter/sidebar");
    expect(thread.createdAt).toBe(local(1, 9));
  });

  it("shortens limit window names", () => {
    expect(compactWindowLabel("5h")).toBe("5h");
    expect(compactWindowLabel("week")).toBe("wk");
    expect(compactWindowLabel("month")).toBe("mo");
  });
});
