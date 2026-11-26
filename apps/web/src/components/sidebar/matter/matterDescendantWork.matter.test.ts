import { ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { buildThreadGroups, threadRowStatus } from "./matterFinalSidebar.logic";
import {
  resolveProjectAttention,
  toMatterThreadItem,
  withDescendantWork,
  withNativeSubagentWork,
  workingDescendantSince,
  workingNativeSubagentKeys,
  type MatterThreadItem,
} from "./matterSidebar.logic";
import { buildTimelineBuckets } from "./matterTimelineSidebar.logic";

const NOW_ISO = "2026-03-10T15:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const MATTER = { key: "env:matter", name: "Matter" };

function item(id: string, overrides: ThreadFixtureOverrides = {}) {
  return toMatterThreadItem(
    makeThreadFixture({
      id: ThreadId.make(id),
      projectId: ProjectId.make(MATTER.key),
      title: id,
      // Yesterday, so only running work keeps a row in Recent.
      latestUserMessageAt: "2026-03-09T14:00:00.000Z",
      createdAt: "2026-03-09T14:00:00.000Z",
      ...overrides,
    }),
    MATTER,
    NOW_ISO,
  );
}

const runtime = (
  status: "running" | "completed" | "idle",
  startedAt = "2026-03-10T14:56:00.000Z",
) => ({
  status,
  activeRunId: status === "running" ? RunId.make("run") : null,
  activityStartedAt: status === "running" ? startedAt : null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW_ISO,
});

function subagentOf(parent: string, id: string, overrides: ThreadFixtureOverrides = {}) {
  return item(id, {
    lineage: {
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
    ...overrides,
  });
}

const lift = (
  items: ReadonlyArray<MatterThreadItem>,
  children: ReadonlyArray<MatterThreadItem>,
) => {
  const since = workingDescendantSince([...items, ...children]);
  return { items: withDescendantWork(items, since), children: withDescendantWork(children, since) };
};

describe("descendant work", () => {
  const parent = item("Parent", { runtime: runtime("idle") });

  it("shows an idle parent as running while a subagent runs", () => {
    const child = subagentOf("Parent", "Child", { runtime: runtime("running") });
    expect(parent.attention).not.toBe("running");
    const [lifted] = lift([parent], [child]).items;
    expect(lifted).toMatchObject({
      attention: "running",
      runningSince: "2026-03-10T14:56:00.000Z",
    });
    expect(threadRowStatus(lifted!, NOW_MS)).toEqual({ tone: "running", age: "4m" });
  });

  it("lifts every ancestor of a running grandchild, the middle subagent too", () => {
    const child = subagentOf("Parent", "Child", { runtime: runtime("completed") });
    const grandchild = subagentOf("Child", "Grandchild", { runtime: runtime("running") });
    const lifted = lift([parent], [child, grandchild]);
    expect(lifted.items[0]!.attention).toBe("running");
    expect(lifted.children.map((entry) => entry.attention)).toEqual(["running", "running"]);
  });

  it("follows delegated tasks and takes the earliest running descendant's start", () => {
    const delegated = item("Delegated", {
      delegatedFrom: {
        environmentId: parent.ref.environmentId,
        threadId: ThreadId.make("Parent"),
        title: "Parent",
      },
      runtime: runtime("running", "2026-03-10T14:40:00.000Z"),
    });
    const child = subagentOf("Parent", "Child", { runtime: runtime("running") });
    const [lifted] = lift([parent], [delegated, child]).items;
    expect(lifted!.runningSince).toBe("2026-03-10T14:40:00.000Z");
  });

  it("returns the parent to its own state once every descendant finishes", () => {
    const child = subagentOf("Parent", "Child", { runtime: runtime("completed") });
    const [lifted] = lift([parent], [child]).items;
    expect(lifted).toBe(parent);
    expect(lifted!.attention).not.toBe("running");
  });

  it("keeps a parent that needs you over a running child", () => {
    const asking = item("Parent", { hasPendingApprovals: true });
    const child = subagentOf("Parent", "Child", { runtime: runtime("running") });
    const [lifted] = lift([asking], [child]).items;
    expect(lifted).toMatchObject({ attention: "needs", needsKind: "approval" });
  });

  it("stops at a lineage cycle", () => {
    const a = subagentOf("B", "A", { runtime: runtime("running") });
    const b = subagentOf("A", "B");
    const since = workingDescendantSince([a, b]);
    expect([...since.keys()]).toEqual([b.key]);
  });

  it("keeps the parent in Recent, in its project's running dot and in the Default list", () => {
    const child = subagentOf("Parent", "Child", { runtime: runtime("running") });
    const { items } = lift([parent], [child]);
    const buckets = buildTimelineBuckets(items, {
      nowMs: NOW_MS,
      sort: "updated",
      projectFilter: null,
      filter: "all",
    });
    expect(buckets.recent.map((entry) => entry.key)).toEqual([parent.key]);
    expect(resolveProjectAttention(items, MATTER.key)).toBe("running");
    const groups = buildThreadGroups(items, [MATTER], {
      sort: "project",
      projectFilter: null,
      filter: "all",
    });
    expect(groups[0]!.items[0]!.attention).toBe("running");
  });

  // A provider-native subagent has no run of its own, so its shell stays idle while it works,
  // fresh or resumed with SendMessage; its parent's pending background work names it.
  it("lifts a provider-native subagent its parent still waits on, and the parent with it", () => {
    const parentShell = makeThreadFixture({
      id: ThreadId.make("Parent"),
      pendingBackgroundTasks: [
        {
          taskId: "a23fce52fceecdff9",
          kind: "subagent",
          description: "Fix findings",
          childThreadId: ThreadId.make("Child"),
        },
        { taskId: "dev-server", kind: "command", description: "vite" },
      ],
    });
    const child = subagentOf("Parent", "Child", {
      latestUserMessageAt: "2026-03-10T14:50:00.000Z",
    });
    const finished = subagentOf("Parent", "Finished");
    expect(child.attention).not.toBe("running");

    const working = workingNativeSubagentKeys([parentShell]);
    const children = withNativeSubagentWork([child, finished], working);
    expect(children.map((entry) => entry.attention)).toEqual(["running", finished.attention]);
    expect(children[0]!.runningSince).toBe("2026-03-10T14:50:00.000Z");
    const [lifted] = lift([parent], children).items;
    expect(lifted).toMatchObject({
      attention: "running",
      runningSince: "2026-03-10T14:50:00.000Z",
    });

    const done = withNativeSubagentWork([child], workingNativeSubagentKeys([makeThreadFixture()]));
    expect(lift([parent], done).items[0]).toBe(parent);
  });
});
