import { render } from "../../../../test/render";
import {
  EnvironmentId,
  MATTR_ADDON_MANIFESTS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AddonEntry,
  type ServerProvider,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../../index.css";
// The rail's look, and the hit areas its rows click through, live in the fork stylesheets.
import "../../../../../../antimatter/sidebar.css";
import "../../../../../../antimatter/timeline-sidebar.css";
import { resetAddonStoreForTests } from "../../../addons/addonStore";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { resetBotsStoreForTests } from "../../bots/botsStore";
import { SidebarProvider } from "../../ui/sidebar";

const harness = vi.hoisted(() => ({
  config: { baseUrl: "http://server.test", headers: {} },
  providers: [] as ReadonlyArray<unknown>,
}));

vi.mock(import("../../../addons/mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => harness.config,
}));

vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
  useEnvironmentProviders: (() =>
    new Map([[EnvironmentId.make("local"), harness.providers]])) as never,
}));

import { MattrBrandMenu } from "./MattrDefaultSidebarParts";
import type { MattrChildItem } from "./mattrFinalSidebar.logic";
import { toMattrThreadItem } from "./mattrSidebar.logic";
import { MattrSidebarLayoutSetting } from "./MattrSidebarLayoutSetting";
import {
  MATTR_SIDEBAR_LAYOUT_STORAGE_KEY,
  MATTR_TIMELINE_SUBAGENTS_STORAGE_KEY,
} from "./mattrSidebarStore";
import { MattrTimelineSidebar } from "./MattrTimelineSidebar";
import type { MattrSidebarModel, MattrSidebarProject } from "./useMattrSidebarModel";

const TIMELINE_SORT_STORAGE_KEY = "mattr:sidebar:timeline-sort:v1";

// Buckets follow local calendar days, so every fixture time is a local wall-clock time.
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 2, day, hour, minute).toISOString();
const NOW_ISO = local(10, 12);
const NOW_MS = Date.parse(NOW_ISO);
const environmentId = EnvironmentId.make("local");

function project(id: string, name: string): MattrSidebarProject {
  const group = {
    environmentId,
    id: ProjectId.make(id),
    title: name,
    workspaceRoot: `/repo/${id}`,
    faviconPath: null,
    projectIcon: { kind: "monogram", text: name.slice(0, 1), color: "blue" },
  } as unknown as SidebarProjectSnapshot;
  return { key: `${environmentId}:${id}`, name, group };
}

const MATTR = project("mattr", "mattr");

function thread(title: string, overrides: ThreadFixtureOverrides = {}) {
  return toMattrThreadItem(
    makeThreadFixture({
      environmentId,
      id: ThreadId.make(title),
      projectId: ProjectId.make(MATTR.key),
      title,
      latestUserMessageAt: local(10, 9),
      ...overrides,
    }),
    MATTR,
    NOW_ISO,
  );
}

const runtime = (status: "running" | "completed" | "failed") => ({
  status,
  activeRunId: status === "running" ? RunId.make("run") : null,
  activityStartedAt: local(10, 11, 56),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: status === "failed" ? "boom" : null,
  updatedAt: NOW_ISO,
});

const pullRequest = (number: number, state: "open" | "merged"): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "current/mattr",
  number,
  url: `https://github.com/current/mattr/pull/${number}`,
  source: "manual",
  linkedAt: local(10, 8),
  stack: null,
  snapshot: {
    state,
    title: `PR ${number}`,
    headBranch: "mattr/feature-x",
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: local(10, 8),
  },
});

const today = thread("Timeline rail", {
  branch: "mattr/feature-x",
  worktreePath: "/worktrees/mattr/feature-x",
  pullRequests: [pullRequest(1271, "open")],
});
const yesterday = thread("Yesterday notes", {
  latestUserMessageAt: local(9, 15),
  pullRequests: [pullRequest(1270, "merged")],
});
const older = thread("Old audit", { latestUserMessageAt: local(1, 10) });
const items = [today, yesterday, older];

const subagent = (title: string, overrides: ThreadFixtureOverrides = {}): MattrChildItem => ({
  ...thread(title, {
    lineage: {
      rootThreadId: ThreadId.make(today.title),
      parentThreadId: ThreadId.make(today.title),
      relationshipToParent: "subagent",
    },
    ...overrides,
  }),
  ancestorKey: today.key,
});

const children = [
  subagent("Audit adapters", { runtime: runtime("running") }),
  subagent("Write matrix doc", { runtime: runtime("completed") }),
  subagent("Broken probe", { runtime: runtime("failed") }),
  subagent("Ask about signing", { hasPendingApprovals: true }),
];

function model(overrides: Partial<MattrSidebarModel> = {}): MattrSidebarModel {
  return {
    items,
    children,
    projects: [MATTR],
    activeThreadKey: today.key,
    nowMs: NOW_MS,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    actions: { openThread: vi.fn(), newThread: vi.fn(), openThreadMenu: vi.fn() },
    ...overrides,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const addons: ReadonlyArray<AddonEntry> = MATTR_ADDON_MANIFESTS.map((manifest) => ({
  manifest,
  state: {
    id: manifest.id,
    enabled: false,
    enablementSource: "default",
    updatedAt: null,
    status: { kind: "disabled" },
  },
}));

function useServer(
  options: { storage?: Record<string, unknown>; providers?: ReadonlyArray<unknown> } = {},
) {
  const realFetch = globalThis.fetch;
  window.localStorage.clear();
  for (const [key, value] of Object.entries(options.storage ?? {})) {
    window.localStorage.setItem(key, JSON.stringify(value));
  }
  harness.providers = options.providers ?? [];
  resetAddonStoreForTests();
  resetBotsStoreForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith("/api/mattr/")) return realFetch(input, init);
      if (url.pathname === "/api/mattr/addons") return json({ addons });
      return new Response("not found", { status: 404 });
    }),
  );
  return {
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      window.localStorage.clear();
      harness.providers = [];
      resetAddonStoreForTests();
      resetBotsStoreForTests();
    },
  };
}

const renderTimeline = (current: MattrSidebarModel = model()) =>
  render(
    <SidebarProvider>
      <MattrTimelineSidebar model={current} />
    </SidebarProvider>,
  );

const row = (container: HTMLElement, item: { key: string }) =>
  container.querySelector<HTMLElement>(`[data-mattr-timeline-row="${item.key}"]`);

describe("MattrTimelineSidebar", () => {
  it("buckets threads by local day and folds Earlier", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    const recent = page.getByRole("region", { name: "Recent" });
    await expect.element(recent.getByRole("button", { name: "Timeline rail" })).toBeVisible();
    await expect
      .element(
        page.getByRole("region", { name: "Yesterday" }).getByRole("button", {
          name: "Yesterday notes",
        }),
      )
      .toBeVisible();

    const earlier = page.getByRole("button", { name: "Earlier" });
    await expect.element(earlier).toHaveAttribute("aria-expanded", "false");
    expect(row(screen.container, older)).toBeNull();
    await earlier.click();
    await expect.element(earlier).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(
        page.getByRole("region", { name: "Earlier" }).getByRole("button", { name: "Old audit" }),
      )
      .toBeVisible();
  });

  it("nests only active subagents under their thread", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    const group = page.getByRole("group", { name: "Subagents of Timeline rail" });
    await expect.element(group).toBeVisible();
    const subs = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-mattr-timeline-subagent]"),
    ];
    expect(subs.map((sub) => sub.querySelector(".mts-st")?.textContent)).toEqual([
      "Ask about signing",
      "Audit adapters",
    ]);
    const [needs, running] = subs;
    expect(needs!.querySelector(".mts-sm")?.textContent).toBe("Needs you");
    expect(needs!.querySelector(".mts-sm")?.getAttribute("data-tone")).toBe("needs");
    expect(running!.querySelector(".mts-conn")).not.toBeNull();
    expect(running!.querySelector(".mts-sm")?.textContent).toBe("subagent · 4m");
    expect(screen.container.textContent).not.toContain("Write matrix doc");
    expect(screen.container.textContent).not.toContain("Broken probe");
  });

  it("hides every subagent while Show active subagents is off", async () => {
    using _server = useServer({ storage: { [MATTR_TIMELINE_SUBAGENTS_STORAGE_KEY]: false } });
    await using screen = await renderTimeline();
    await expect.element(page.getByRole("button", { name: "Timeline rail" })).toBeVisible();
    expect(screen.container.querySelector("[data-mattr-timeline-subagent]")).toBeNull();
    expect(screen.container.textContent).not.toContain("Audit adapters");
  });

  it("shows workspace, branch and pull request on each row", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    await expect.element(page.getByRole("button", { name: "Yesterday notes" })).toBeVisible();
    const todayRow = row(screen.container, today)!;
    const yesterdayRow = row(screen.container, yesterday)!;
    expect(todayRow.querySelector('[data-mattr-workspace="worktree"]')).not.toBeNull();
    expect(yesterdayRow.querySelector('[data-mattr-workspace="local"]')).not.toBeNull();
    expect(todayRow.querySelector(".mts-br")?.textContent).toBe("mattr/feature-x");
    expect(yesterdayRow.querySelector(".mts-br")).toBeNull();

    const openPr = todayRow.querySelector('.mts-pr[data-state="open"]');
    expect(openPr?.textContent).toBe("#1271");
    const mergedPr = yesterdayRow.querySelector(".mts-pr");
    expect(mergedPr?.getAttribute("data-state")).toBe("merged");
    expect(mergedPr?.textContent).toBe("#1270");
  });

  it("marks the open thread and opens rows on click", async () => {
    using _server = useServer();
    const current = model();
    await using screen = await renderTimeline(current);
    const active = page.getByRole("button", { name: "Timeline rail", exact: true });
    await expect.element(active).toHaveAttribute("aria-current", "page");
    expect(row(screen.container, today)!.hasAttribute("data-active")).toBe(true);
    expect(row(screen.container, yesterday)!.hasAttribute("data-active")).toBe(false);
    await expect
      .element(page.getByRole("button", { name: "Yesterday notes" }))
      .not.toHaveAttribute("aria-current");

    await page.getByRole("button", { name: "Yesterday notes" }).click();
    expect(current.actions.openThread).toHaveBeenCalledWith(yesterday);
  });

  it("toggles the sort and saves it", async () => {
    using _server = useServer();
    await using _screen = await renderTimeline();
    await page.getByRole("button", { name: "Sort by created" }).click();
    await expect.element(page.getByRole("button", { name: "Sort by last update" })).toBeVisible();
    expect(window.localStorage.getItem(TIMELINE_SORT_STORAGE_KEY)).toBe('"created"');
  });

  it("shows usage meters from provider limits and none without them", async () => {
    using _server = useServer({
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude main",
          enabled: true,
          usageLimits: {
            checkedAt: NOW_ISO,
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 47 }],
          },
        } as unknown as ServerProvider,
      ],
    });
    await using screen = await renderTimeline();
    const meters = page.getByRole("group", { name: "Usage limits" });
    await expect
      .element(meters.getByRole("button", { name: "Claude · wk: 47% used" }))
      .toBeVisible();

    harness.providers = [];
    await screen.rerender(
      <SidebarProvider>
        <MattrTimelineSidebar model={model({ nowMs: NOW_MS + 1 })} />
      </SidebarProvider>,
    );
    await expect.element(meters).not.toBeInTheDocument();
    expect(screen.container.querySelector(".mts-use")).toBeNull();
  });
});

describe("Timeline layout choice", () => {
  it("offers Show active subagents in the brand menu only for Timeline", async () => {
    using _server = useServer();
    await using _screen = await render(<MattrBrandMenu onNavigate={() => {}} />);
    const trigger = page.getByRole("button", { name: "mattr menu" });
    const checkbox = page.getByRole("menuitemcheckbox", { name: "Show active subagents" });

    await trigger.click();
    await expect.element(page.getByRole("menuitemradio", { name: "Timeline" })).toBeVisible();
    await expect.element(checkbox).not.toBeInTheDocument();
    await page.getByRole("menuitemradio", { name: "Timeline" }).click();
    expect(window.localStorage.getItem(MATTR_SIDEBAR_LAYOUT_STORAGE_KEY)).toBe('"timeline"');

    await trigger.click();
    await expect.element(checkbox).toHaveAttribute("aria-checked", "true");
    await checkbox.click();
    expect(window.localStorage.getItem(MATTR_TIMELINE_SUBAGENTS_STORAGE_KEY)).toBe("false");

    // Checkbox items keep the menu open.
    await page.getByRole("menuitemradio", { name: "Default" }).click();
    expect(window.localStorage.getItem(MATTR_SIDEBAR_LAYOUT_STORAGE_KEY)).toBe('"inbox"');
    await trigger.click();
    await expect.element(page.getByRole("menuitemradio", { name: "Default" })).toBeVisible();
    await expect.element(checkbox).not.toBeInTheDocument();
  });

  it.each([
    ["timeline", true],
    ["inbox", false],
  ] as const)("settings with layout %s shows the subagents switch: %s", async (layout, shown) => {
    using _server = useServer({ storage: { [MATTR_SIDEBAR_LAYOUT_STORAGE_KEY]: layout } });
    await using _screen = await render(<MattrSidebarLayoutSetting />);
    await expect.element(page.getByRole("group", { name: "Sidebar layout" })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Show active subagents" });
    if (shown) await expect.element(toggle).toBeChecked();
    else await expect.element(toggle).not.toBeInTheDocument();
  });
});
