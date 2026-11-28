import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import {
  attachListedAncestors,
  buildThreadGroups,
  compactAge,
  countNeedsYou,
  countOpenPullRequests,
  formatResetLabel,
  indexChildrenByParent,
  parentsWithNeedsChild,
  pickUsageMeters,
  shortWindowLabel,
  shouldAutoExpand,
  subagentStatus,
  summarizeProjects,
  threadRowStatus,
} from "./matterFinalSidebar.logic";
import { toMatterThreadItem } from "./matterSidebar.logic";

const NOW_ISO = "2026-03-10T15:00:00.000Z";
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
      latestUserMessageAt: "2026-03-10T14:00:00.000Z",
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
    activityStartedAt: "2026-03-10T14:56:00.000Z",
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: NOW_ISO,
  },
};

const subagentOf = (parent: string) => ({
  lineage: {
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "subagent" as const,
  },
});

const pullRequest = (number: number, state: "open" | "merged" | null, isDraft = false) => ({
  pullRequests: [
    {
      host: "github.com",
      repository: "current/matter",
      number,
      url: `https://github.com/current/matter/pull/${number}`,
      source: "manual" as const,
      linkedAt: "2026-03-10T10:00:00.000Z",
      stack: null,
      snapshot:
        state === null
          ? null
          : {
              state,
              title: "A change",
              headBranch: "feature",
              baseBranch: "main",
              isDraft,
              updatedAt: null,
              syncedAt: NOW_ISO,
            },
    },
  ],
});

describe("compactAge", () => {
  it("never says just now and steps through units", () => {
    expect(compactAge(NOW_ISO, NOW_MS)).toBe("1m");
    expect(compactAge("2026-03-10T14:46:00.000Z", NOW_MS)).toBe("14m");
    expect(compactAge("2026-03-10T12:00:00.000Z", NOW_MS)).toBe("3h");
    expect(compactAge("2026-03-08T15:00:00.000Z", NOW_MS)).toBe("2d");
    expect(compactAge("2026-02-24T15:00:00.000Z", NOW_MS)).toBe("2w");
    expect(compactAge(null, NOW_MS)).toBe("");
  });
});

describe("thread item lineage and pull requests", () => {
  it("keys a subagent and a delegated task under their parent", () => {
    expect(item("child", subagentOf("parent")).parentKey).toBe("local:parent");
    expect(
      item("task", {
        delegatedFrom: {
          environmentId: EnvironmentId.make("remote"),
          threadId: ThreadId.make("p"),
          title: "Parent",
        },
      }).parentKey,
    ).toBe("remote:p");
    expect(item("plain").parentKey).toBeNull();
  });

  it("reads the PR badge state from the snapshot", () => {
    expect(item("a", pullRequest(12, null)).pullRequest).toEqual({ number: 12, state: "open" });
    expect(item("b", pullRequest(13, "open", true)).pullRequest).toEqual({
      number: 13,
      state: "draft",
    });
    expect(item("c", pullRequest(14, "merged")).pullRequest).toEqual({
      number: 14,
      state: "merged",
    });
    expect(item("d").pullRequest).toBeNull();
  });
});

describe("buildThreadGroups", () => {
  const items = [
    item("older", { latestUserMessageAt: "2026-03-10T09:00:00.000Z" }),
    item("newer"),
    item("pinned", {
      pinnedAt: "2026-03-01T00:00:00.000Z",
      latestUserMessageAt: "2026-03-01T00:00:00.000Z",
    }),
    item("lilt-blocked", { hasPendingApprovals: true }, LILT),
    item("loose", {}, null),
    item("settled", { settledOverride: "settled" }),
  ];

  it("groups by project in project order with pinned first and orphans last", () => {
    const groups = buildThreadGroups(items, [LILT, MATTER], {
      sort: "project",
      projectFilter: null,
      filter: "all",
    });
    expect(groups.map((group) => group.name)).toEqual(["Lilt", "Matter", null]);
    expect(groups[1]!.items.map((entry) => entry.title)).toEqual(["pinned", "newer", "older"]);
  });

  it("flattens to one recency list", () => {
    const groups = buildThreadGroups(items, [MATTER, LILT], {
      sort: "recent",
      projectFilter: null,
      filter: "all",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.at(-1)!.title).toBe("pinned");
  });

  it("narrows to Needs you and to one project", () => {
    const needs = buildThreadGroups(items, [MATTER, LILT], {
      sort: "project",
      projectFilter: null,
      filter: "needs",
    });
    expect(needs.flatMap((group) => group.items.map((entry) => entry.title))).toEqual([
      "lilt-blocked",
    ]);
    const lilt = buildThreadGroups(items, [MATTER, LILT], {
      sort: "project",
      projectFilter: LILT.key,
      filter: "all",
    });
    expect(lilt.map((group) => group.name)).toEqual(["Lilt"]);
  });

  it("counts listed threads per project and open PRs", () => {
    expect(summarizeProjects(items).get(LILT.key)).toEqual({ count: 1, running: false });
    expect(
      countOpenPullRequests([
        item("a", pullRequest(1, null)),
        item("b", pullRequest(2, "open", true)),
        item("c", pullRequest(3, "merged")),
      ]),
    ).toBe(2);
  });
});

describe("subagent trees", () => {
  const parent = item("parent");
  const under = (child: ReturnType<typeof item>, ancestor = parent.key) => ({
    ...child,
    ancestorKey: ancestor,
  });
  const done = under(
    item("done", { ...subagentOf("parent"), latestUserMessageAt: "2026-03-10T14:50:00.000Z" }),
  );
  const live = under(item("live", { ...subagentOf("parent"), ...running }));
  const blocked = under(item("blocked", { ...subagentOf("parent"), hasPendingUserInput: true }));

  it("orders blocked, then running, then done children under their parent", () => {
    const unrelated = item("unrelated");
    const index = indexChildrenByParent([done, live, blocked, under(unrelated, unrelated.key)]);
    expect(index.get(parent.key)!.map((child) => child.title)).toEqual(["blocked", "live", "done"]);
    expect(index.size).toBe(1);
  });

  it("nests a subagent's own subagents under the nearest listed ancestor", () => {
    const shell = (id: string, parentId: string | null) => ({
      id: ThreadId.make(id),
      environmentId: env,
      archivedAt: null,
      delegatedFrom: null,
      lineage:
        parentId === null
          ? { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null }
          : {
              rootThreadId: ThreadId.make("parent"),
              parentThreadId: ThreadId.make(parentId),
              relationshipToParent: "subagent" as const,
            },
    });
    const threads = [
      shell("parent", null),
      shell("child", "parent"),
      { ...shell("archived-child", "parent"), archivedAt: "2026-03-10T14:00:00.000Z" },
      shell("grandchild", "child"),
      shell("great-grandchild", "archived-child"),
      shell("orphan", "missing"),
    ];
    const children = attachListedAncestors(
      [
        item("child", subagentOf("parent")),
        item("grandchild", subagentOf("child")),
        item("great-grandchild", subagentOf("archived-child")),
        item("orphan", subagentOf("missing")),
      ],
      threads,
    );
    expect(children.map((child) => child.ancestorKey)).toEqual([
      parent.key,
      parent.key,
      parent.key,
      "local:orphan",
    ]);
    const index = indexChildrenByParent(children);
    expect(
      index
        .get(parent.key)!
        .map((child) => child.title)
        .toSorted(),
    ).toEqual(["child", "grandchild", "great-grandchild"]);
    expect(index.size).toBe(1);
  });

  it("counts and keeps parents whose subagents need you", () => {
    const settled = item("settled", { settledOverride: "settled" });
    const ask = under(
      item("ask", { ...subagentOf("settled"), hasPendingUserInput: true }),
      settled.key,
    );
    const lost = under(item("lost", { hasPendingUserInput: true }), "local:archived");
    const children = [done, live, blocked, ask, lost];
    const index = indexChildrenByParent(children);
    const needsChildParents = parentsWithNeedsChild(index);
    expect([...needsChildParents].toSorted()).toEqual(["local:archived", parent.key, settled.key]);
    expect(countNeedsYou([parent, settled], children)).toBe(2);

    const needs = buildThreadGroups([parent, settled, item("quiet")], [MATTER], {
      sort: "recent",
      projectFilter: null,
      filter: "needs",
      needsChildParents,
    });
    expect(needs[0]!.items.map((entry) => entry.title).toSorted()).toEqual(["parent", "settled"]);
    const all = buildThreadGroups([parent, settled], [MATTER], {
      sort: "recent",
      projectFilter: null,
      filter: "all",
      needsChildParents: new Set(),
    });
    expect(all[0]!.items.map((entry) => entry.title)).toEqual(["parent"]);
  });

  it("opens a tree for the active thread or live children only", () => {
    expect(shouldAutoExpand(parent, [done], null)).toBe(false);
    expect(shouldAutoExpand(parent, [done], parent.key)).toBe(true);
    expect(shouldAutoExpand(parent, [done], done.key)).toBe(true);
    expect(shouldAutoExpand(parent, [done, live], null)).toBe(true);
  });

  it("labels children with elapsed time, a raised hand, or done", () => {
    expect(subagentStatus(live, NOW_MS)).toEqual({ tone: "running", age: "4m" });
    expect(subagentStatus(blocked, NOW_MS)).toEqual({ tone: "needs", age: null });
    expect(subagentStatus(done, NOW_MS)).toEqual({ tone: "done", age: null });
    expect(threadRowStatus(parent, NOW_MS)).toEqual({ tone: "muted", age: "1h" });
  });
});

describe("usage meters", () => {
  const window = (
    id: string,
    kind: ServerProviderUsageWindow["kind"],
    usedPercent: number,
    extra: Partial<ServerProviderUsageWindow> = {},
  ): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent, ...extra });
  const provider = (
    instanceId: string,
    driver: string,
    windows: ReadonlyArray<ServerProviderUsageWindow>,
  ) =>
    ({
      instanceId,
      driver,
      displayName: instanceId,
      enabled: true,
      usageLimits: { checkedAt: NOW_ISO, windows },
    }) as unknown as ServerProvider;

  it("labels windows briefly", () => {
    expect(shortWindowLabel(window("Session", "session", 1, { windowDurationMins: 300 }))).toBe(
      "5h",
    );
    expect(shortWindowLabel(window("Weekly", "weekly", 1))).toBe("week");
    expect(shortWindowLabel(window("Credits", "other", 1))).toBe("Credits");
  });

  it("shows each provider's tightest general window, one account per provider", () => {
    const meters = pickUsageMeters([
      provider("claudeAgent", "claudeAgent", [
        window("Session", "session", 40, { windowDurationMins: 300 }),
        window("Weekly", "weekly", 61.6),
        window("Fable", "weekly", 99, { modelIds: ["claude-fable-5-2"] }),
      ]),
      provider("claude-alt", "claudeAgent", [window("Weekly", "weekly", 20)]),
      provider("codex", "codex", [window("Weekly", "weekly", 12)]),
      provider("grok", "grok", [window("Weekly", "weekly", 5)]),
    ]);
    expect(
      meters.map((meter) => [meter.accountName, meter.windowLabel, meter.usedPercent]),
    ).toEqual([
      ["claudeAgent", "week", 62],
      ["codex", "week", 12],
    ]);
  });

  it("leaves out the providers hidden in Settings", () => {
    const meters = pickUsageMeters(
      [
        provider("claudeAgent", "claudeAgent", [window("Weekly", "weekly", 62)]),
        provider("codex", "codex", [window("Weekly", "weekly", 12)]),
        provider("grok", "grok", [window("Weekly", "weekly", 5)]),
      ],
      2,
      ["claudeAgent"],
    );
    expect(meters.map((meter) => meter.accountName)).toEqual(["codex", "grok"]);
  });

  it("formats near resets and drops far ones", () => {
    expect(formatResetLabel("2026-03-10T17:14:00.000Z", NOW_MS)).toBe("2h 14m");
    expect(formatResetLabel("2026-03-10T15:20:00.000Z", NOW_MS)).toBe("20m");
    expect(formatResetLabel("2026-03-12T15:00:00.000Z", NOW_MS)).toBeNull();
    expect(formatResetLabel("2026-03-10T14:59:00.000Z", NOW_MS)).toBeNull();
    expect(formatResetLabel(NOW_ISO, NOW_MS)).toBeNull();
  });
});
