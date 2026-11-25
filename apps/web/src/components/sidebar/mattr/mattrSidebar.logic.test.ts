import { ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import {
  bucketInboxThreads,
  buildSpaceSections,
  countLiveThreadsByProject,
  filterThreadsByQuery,
  resolveActiveSpaceKey,
  resolveProjectAttention,
  toMattrThreadItem,
} from "./mattrSidebar.logic";

const NOW_ISO = "2026-03-10T15:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const MATTR = { key: "env:mattr", name: "mattr" };
const LILT = { key: "env:lilt", name: "Lilt" };

function item(
  id: string,
  overrides: ThreadFixtureOverrides = {},
  project: { key: string; name: string } | null = MATTR,
) {
  return toMattrThreadItem(
    makeThreadFixture({
      id: ThreadId.make(id),
      projectId: ProjectId.make(project?.key ?? "none"),
      title: id,
      latestUserMessageAt: "2026-03-10T14:00:00.000Z",
      ...overrides,
    }),
    project,
    NOW_ISO,
  );
}

const runtime = (status: "running" | "completed") => ({
  status,
  activeRunId: status === "running" ? RunId.make("run") : null,
  activityStartedAt: status === "running" ? "2026-03-10T14:56:00.000Z" : null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW_ISO,
});

const completed = (completedAt: string) => ({
  latestRun: completedRun(completedAt),
  runtime: runtime("completed"),
});

const completedRun = (completedAt: string) => ({
  runId: RunId.make("run-done"),
  status: "completed" as const,
  requestedAt: null,
  startedAt: "2026-03-10T13:00:00.000Z",
  completedAt,
  assistantMessageId: null,
});

describe("toMattrThreadItem", () => {
  it("puts pending approvals and questions in front of everything", () => {
    expect(item("a", { hasPendingApprovals: true })).toMatchObject({
      attention: "needs",
      needsKind: "approval",
    });
    expect(item("q", { hasPendingUserInput: true })).toMatchObject({
      attention: "needs",
      needsKind: "input",
    });
  });

  it("marks running threads with when the run started", () => {
    expect(item("r", { runtime: runtime("running") })).toMatchObject({
      attention: "running",
      runningSince: "2026-03-10T14:56:00.000Z",
      providerName: "Codex",
    });
  });

  it("treats an unseen completion as ready to review and a seen one as idle", () => {
    const done = completed("2026-03-10T14:30:00.000Z");
    expect(item("unseen", { ...done, lastVisitedAt: "2026-03-10T14:00:00.000Z" })).toMatchObject({
      attention: "review",
      unread: true,
    });
    expect(item("seen", { ...done, lastVisitedAt: "2026-03-10T14:45:00.000Z" })).toMatchObject({
      attention: "idle",
      unread: false,
    });
  });

  it("keeps a thread parked on background work out of Running", () => {
    expect(item("parked", { runtime: { ...runtime("completed"), status: "idle" } }).attention).toBe(
      "idle",
    );
  });
});

describe("bucketInboxThreads", () => {
  const needs = item("needs", { hasPendingApprovals: true, settledOverride: "settled" });
  const running = item("running", { runtime: runtime("running") });
  const review = item("review", {
    ...completed("2026-03-10T14:30:00.000Z"),
    lastVisitedAt: "2026-03-10T14:00:00.000Z",
  });
  const quiet = item("quiet");
  const settled = item("settled", { settledOverride: "settled" });
  const lilt = item("lilt", {}, LILT);

  it("orders the queue by what needs attention and drops settled threads", () => {
    const buckets = bucketInboxThreads([quiet, settled, review, running, needs, lilt], null);
    expect(buckets.needsYou.map((entry) => entry.key)).toEqual([needs.key]);
    expect(buckets.running.map((entry) => entry.key)).toEqual([running.key]);
    expect(buckets.review.map((entry) => entry.key)).toEqual([review.key]);
    expect(buckets.quiet.map((entry) => entry.key).toSorted()).toEqual(
      [quiet.key, lilt.key].toSorted(),
    );
  });

  it("slices every bucket to one project", () => {
    const buckets = bucketInboxThreads([quiet, lilt, needs], LILT.key);
    expect(buckets.needsYou).toEqual([]);
    expect(buckets.quiet.map((entry) => entry.key)).toEqual([lilt.key]);
  });

  it("counts live threads per project and finds the most urgent tile dot", () => {
    const items = [quiet, settled, running, lilt];
    expect(countLiveThreadsByProject(items).get(MATTR.key)).toBe(2);
    expect(countLiveThreadsByProject(items).get(LILT.key)).toBe(1);
    expect(resolveProjectAttention(items, MATTR.key)).toBe("running");
    expect(resolveProjectAttention([...items, needs], MATTR.key)).toBe("needs");
    expect(resolveProjectAttention(items, LILT.key)).toBeNull();
  });
});

describe("buildSpaceSections", () => {
  it("keeps pinned threads up top, today in the middle, and older or settled ones folded", () => {
    const pinned = item("pinned", { pinnedAt: "2026-03-01T00:00:00.000Z" });
    const today = item("today");
    const yesterday = item("yesterday", { latestUserMessageAt: "2026-03-08T10:00:00.000Z" });
    const oldRunning = item("old-running", {
      latestUserMessageAt: "2026-03-01T10:00:00.000Z",
      runtime: runtime("running"),
    });
    const settled = item("settled", { settledOverride: "settled" });
    const elsewhere = item("elsewhere", {}, LILT);
    const sections = buildSpaceSections(
      [pinned, today, yesterday, oldRunning, settled, elsewhere],
      MATTR.key,
      NOW_MS,
    );
    expect(sections.pinned.map((entry) => entry.key)).toEqual([pinned.key]);
    expect(sections.today.map((entry) => entry.key).toSorted()).toEqual(
      [today.key, oldRunning.key].toSorted(),
    );
    expect(sections.earlier.map((entry) => entry.key)).toEqual([yesterday.key, settled.key]);
    expect(sections.liveCount).toBe(4);
  });
});

describe("resolveActiveSpaceKey", () => {
  it("keeps a stored space that still exists and otherwise falls back to the first", () => {
    expect(resolveActiveSpaceKey(LILT.key, [MATTR.key, LILT.key])).toBe(LILT.key);
    expect(resolveActiveSpaceKey("gone", [MATTR.key, LILT.key])).toBe(MATTR.key);
    expect(resolveActiveSpaceKey(null, [])).toBeNull();
  });
});

describe("filterThreadsByQuery", () => {
  it("matches every term against the title and project name", () => {
    const items = [item("Island spring morphs"), item("Onboarding copy", {}, LILT)];
    expect(filterThreadsByQuery(items, "spring mattr").map((entry) => entry.title)).toEqual([
      "Island spring morphs",
    ]);
    expect(filterThreadsByQuery(items, "lilt").map((entry) => entry.title)).toEqual([
      "Onboarding copy",
    ]);
    expect(filterThreadsByQuery(items, "  ")).toBe(items);
  });
});
