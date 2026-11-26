import { ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { buildThreadGroups, threadRowStatus } from "./mattrFinalSidebar.logic";
import {
  resolveProjectAttention,
  toMattrThreadItem,
  withDescendantWork,
  workingDescendantSince,
  type MattrThreadItem,
} from "./mattrSidebar.logic";
import { buildTimelineBuckets } from "./mattrTimelineSidebar.logic";

const NOW_ISO = "2026-03-10T15:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const MATTR = { key: "env:mattr", name: "mattr" };

function item(id: string, overrides: ThreadFixtureOverrides = {}) {
  return toMattrThreadItem(
    makeThreadFixture({
      id: ThreadId.make(id),
      projectId: ProjectId.make(MATTR.key),
      title: id,
      // Yesterday, so only running work keeps a row in Recent.
      latestUserMessageAt: "2026-03-09T14:00:00.000Z",
      createdAt: "2026-03-09T14:00:00.000Z",
      ...overrides,
    }),
    MATTR,
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

const lift = (items: ReadonlyArray<MattrThreadItem>, children: ReadonlyArray<MattrThreadItem>) => {
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
    expect(resolveProjectAttention(items, MATTR.key)).toBe("running");
    const groups = buildThreadGroups(items, [MATTR], {
      sort: "project",
      projectFilter: null,
      filter: "all",
    });
    expect(groups[0]!.items[0]!.attention).toBe("running");
  });
});
