import { DEFAULT_SERVER_SETTINGS, ProjectId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  addMergeSettleDismissal,
  parseMergeSettleDismissals,
  resolveAutoSettleOnMerge,
  resolveMergeSettlePrompt,
} from "./matterMergeSettlePrompt.logic";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_KEY = "env:thread-1";

function pullRequest(
  number: number,
  state: "open" | "merged" | "closed",
  times: { mergedAt?: string | null; updatedAt?: string | null } = {},
) {
  return {
    host: "github.com",
    repository: "owner/repo",
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    source: "manual" as const,
    linkedAt: "2026-11-20T00:00:00.000Z",
    snapshot: {
      state,
      title: "Change",
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt:
        times.updatedAt === undefined ? new Date(NOW - HOUR).toISOString() : times.updatedAt,
      syncedAt: new Date(NOW).toISOString(),
      mergedAt: times.mergedAt === undefined ? new Date(NOW - HOUR).toISOString() : times.mergedAt,
    },
    stack: null,
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    pullRequests: [pullRequest(42, "merged")],
    settledOverride: null,
    archivedAt: null,
    latestRun: null,
    ...overrides,
  } as never;
}

function resolve(overrides: Partial<Parameters<typeof resolveMergeSettlePrompt>[0]> = {}) {
  return resolveMergeSettlePrompt({
    thread: thread(),
    threadKey: THREAD_KEY,
    autoSettleOnMerge: false,
    dismissals: [],
    nowMs: NOW,
    ...overrides,
  });
}

describe("resolveMergeSettlePrompt", () => {
  it("asks about a recently merged pull request", () => {
    expect(resolve()).toBe(42);
  });

  it("stays quiet unless the current pull request is merged", () => {
    expect(resolve({ thread: thread({ pullRequests: [] }) })).toBeNull();
    expect(resolve({ thread: thread({ pullRequests: [pullRequest(42, "open")] }) })).toBeNull();
    expect(resolve({ thread: thread({ pullRequests: [pullRequest(42, "closed")] }) })).toBeNull();
  });

  it("only asks within three days of the merge", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const merged = (ms: number) =>
      thread({ pullRequests: [pullRequest(42, "merged", { mergedAt: at(ms) })] });
    expect(resolve({ thread: merged(71 * HOUR) })).toBe(42);
    expect(resolve({ thread: merged(73 * HOUR) })).toBeNull();
  });

  it("falls back to updatedAt, and stays quiet with neither time", () => {
    const fallback = (updatedAt: string | null) =>
      thread({ pullRequests: [pullRequest(42, "merged", { mergedAt: null, updatedAt })] });
    expect(resolve({ thread: fallback(new Date(NOW - HOUR).toISOString()) })).toBe(42);
    expect(resolve({ thread: fallback(new Date(NOW - 80 * HOUR).toISOString()) })).toBeNull();
    expect(resolve({ thread: fallback(null) })).toBeNull();
  });

  it("stays quiet for settled, hidden or running threads", () => {
    expect(resolve({ thread: thread({ settledOverride: "settled" }) })).toBeNull();
    expect(resolve({ thread: thread({ archivedAt: "2026-11-26T00:00:00.000Z" }) })).toBeNull();
    const run = (status: string) => ({ runId: RunId.make("run-1"), status });
    expect(resolve({ thread: thread({ latestRun: run("running") }) })).toBeNull();
    expect(resolve({ thread: thread({ latestRun: run("waiting") }) })).toBeNull();
    expect(resolve({ thread: thread({ latestRun: run("completed") }) })).toBe(42);
    expect(resolve({ thread: thread({ settledOverride: "active" }) })).toBe(42);
  });

  it("stays quiet when the server settles merged threads itself", () => {
    expect(resolve({ autoSettleOnMerge: true })).toBeNull();
  });

  it("stays quiet after Keep for that pull request, and asks again for a later one", () => {
    const dismissals = addMergeSettleDismissal([], THREAD_KEY, 42);
    expect(resolve({ dismissals })).toBeNull();
    expect(resolve({ dismissals, threadKey: "env:other" })).toBe(42);
    expect(
      resolve({ dismissals, thread: thread({ pullRequests: [pullRequest(43, "merged")] }) }),
    ).toBe(43);
  });
});

describe("resolveAutoSettleOnMerge", () => {
  it("uses the server setting, then the project override", () => {
    expect(resolveAutoSettleOnMerge(DEFAULT_SERVER_SETTINGS, PROJECT_ID)).toBe(false);
    expect(
      resolveAutoSettleOnMerge(
        { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleOnMerge: true },
        PROJECT_ID,
      ),
    ).toBe(true);
    const overridden = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
    };
    expect(resolveAutoSettleOnMerge(overridden, PROJECT_ID)).toBe(true);
    expect(resolveAutoSettleOnMerge(overridden, ProjectId.make("project-2"))).toBe(false);
    expect(
      resolveAutoSettleOnMerge(
        {
          ...DEFAULT_SERVER_SETTINGS,
          sidebarAutoSettleOnMerge: true,
          projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: false } },
        },
        PROJECT_ID,
      ),
    ).toBe(false);
  });
});

describe("merge settle dismissals", () => {
  it("keeps one entry per thread, newest last, capped at 200", () => {
    let dismissals = addMergeSettleDismissal([], "a", 1);
    dismissals = addMergeSettleDismissal(dismissals, "a", 2);
    expect(dismissals).toEqual([["a", 2]]);
    for (let index = 0; index < 250; index += 1) {
      dismissals = addMergeSettleDismissal(dismissals, `t${index}`, index + 1);
    }
    expect(dismissals).toHaveLength(200);
    expect(dismissals.at(-1)).toEqual(["t249", 250]);
    expect(dismissals[0]).toEqual(["t50", 51]);
  });

  it("ignores unreadable storage", () => {
    expect(parseMergeSettleDismissals(null)).toEqual([]);
    expect(parseMergeSettleDismissals("{")).toEqual([]);
    expect(parseMergeSettleDismissals('{"a":1}')).toEqual([]);
    expect(parseMergeSettleDismissals('[["a",1],["b"],3]')).toEqual([["a", 1]]);
  });
});
