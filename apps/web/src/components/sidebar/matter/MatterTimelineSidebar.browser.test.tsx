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
import type { SidebarRouteReveal } from "../routeReveal";
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
const LILT = project("lilt", "Lilt");

function thread(
  title: string,
  overrides: ThreadFixtureOverrides = {},
  owner: MattrSidebarProject | null = MATTR,
) {
  return toMattrThreadItem(
    makeThreadFixture({
      environmentId,
      id: ThreadId.make(title),
      projectId: ProjectId.make(owner?.key ?? "none"),
      title,
      latestUserMessageAt: local(10, 9),
      ...overrides,
    }),
    owner,
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
    actions: {
      openThread: vi.fn(),
      newThread: vi.fn(),
      openThreadMenu: vi.fn(),
      runThreadAction: vi.fn(),
    },
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

const renderTimeline = (current: MattrSidebarModel = model(), routeReveal?: SidebarRouteReveal) =>
  render(
    <SidebarProvider>
      <MattrTimelineSidebar model={current} routeReveal={routeReveal} />
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
    expect(running!.querySelector(".mts-sm")?.textContent).toBe("4m");
    expect(running!.querySelector(".mts-sub-dot")).not.toBeNull();
    expect(screen.container.textContent).not.toContain("Write matrix doc");
    expect(screen.container.textContent).not.toContain("Broken probe");
  });

  it("draws subagent connectors without overlapping strokes", async () => {
    using _server = useServer();
    const runningParent = { ...today, attention: "running" as const };
    const threeRunning = ["Audit adapters", "Probe codex", "Probe claude"].map((title) =>
      subagent(title, { runtime: runtime("running") }),
    );
    await using screen = await renderTimeline(
      model({ items: [runningParent, yesterday, older], children: threeRunning }),
    );
    await expect
      .element(page.getByRole("group", { name: "Subagents of Timeline rail" }))
      .toBeVisible();
    const parent = row(screen.container, today)!;
    const subs = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-mattr-timeline-subagent]"),
    ];
    expect(subs).toHaveLength(3);

    const spans: Array<[number, number]> = [];
    subs.forEach((sub, index) => {
      const last = index === subs.length - 1;
      const top = sub.getBoundingClientRect().top;
      const conn = sub.querySelector<HTMLElement>(".mts-conn")!;
      const elbow = conn.getBoundingClientRect();
      const trunk = getComputedStyle(sub, "::after");
      // A sibling below takes the elbow's left stroke over with one full-height trunk.
      expect(getComputedStyle(conn).clipPath).toBe(last ? "none" : "inset(0px 0px 0px 1.5px)");
      expect(trunk.content).toBe(last ? "none" : '""');
      if (!last) {
        expect(trunk.width).toBe("1.5px");
        expect(parseFloat(trunk.left)).toBe(elbow.left - sub.getBoundingClientRect().left);
        spans.push([top + parseFloat(trunk.top), sub.getBoundingClientRect().bottom]);
      } else {
        spans.push([elbow.top, elbow.bottom]);
      }
    });
    // The trunk starts at the parent's edge, and each segment ends where the next begins.
    expect(spans[0]![0]).toBeCloseTo(parent.getBoundingClientRect().bottom, 2);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]![0]).toBeCloseTo(spans[index - 1]![1], 2);
    }
  });

  it("spins the running indicator smoothly and wires observeVisibleAnimation", async () => {
    using _server = useServer();
    await using screen = await renderTimeline(
      model({ items: [{ ...today, attention: "running" }, yesterday, older], children: [] }),
    );
    await expect.element(page.getByRole("img", { name: "Running" })).toBeInTheDocument();
    const spinEl = screen.container.querySelector<SVGSVGElement>(".mts-spin")!;
    const spin = getComputedStyle(spinEl);
    expect(spin.animationName).toBe("mts-spin");
    expect(spin.animationTimingFunction).toBe("linear");
    expect(spin.animationIterationCount).toBe("infinite");
    expect(screen.container.querySelectorAll(".mts-spin")).toHaveLength(1);
    await expect
      .poll(() => spinEl.style.getPropertyValue("--visible-animation-state"))
      .toBe("running");
    expect(spinEl.style.getPropertyValue("--visible-animation-will-change")).toBe("transform");
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

  it("toggles the sort, highlights data-sort=created, and saves it", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    const sortBtn = page.getByRole("button", { name: "Sort by created" });
    await expect.element(sortBtn).toHaveAttribute("data-sort", "updated");
    expect(screen.container.querySelector(".mts-so-lab")).toBeNull();

    await sortBtn.click();
    const activeSort = page.getByRole("button", { name: "Sort by last update" });
    await expect.element(activeSort).toBeVisible();
    await expect.element(activeSort).toHaveAttribute("data-sort", "created");
    expect(screen.container.querySelector(".mts-so-lab")?.textContent).toBe("Created");
    expect(window.localStorage.getItem(TIMELINE_SORT_STORAGE_KEY)).toBe('"created"');
  });

  it("keeps Inbox transparent when off and shows removable Needs you pill when active", async () => {
    using _server = useServer();
    await using screen = await renderTimeline(
      model({
        items: [today, thread("Needs approval", { hasPendingApprovals: true }), yesterday],
        children: [],
      }),
    );
    const inbox = page.getByRole("button", { name: /^Needs you/ });
    await expect.element(inbox).toHaveAttribute("aria-pressed", "false");
    expect(getComputedStyle(inbox.element()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(screen.container.querySelector(".mts-pill")).toBeNull();

    await inbox.click();
    await expect.element(inbox).toHaveAttribute("aria-pressed", "true");
    expect(getComputedStyle(inbox.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    const pill = page.getByRole("button", { name: "Clear Needs you filter" });
    await expect.element(pill).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Needs approval" })).toBeVisible();
    expect(row(screen.container, today)).toBeNull();

    await pill.click();
    await expect.element(inbox).toHaveAttribute("aria-pressed", "false");
    await expect.element(pill).not.toBeInTheDocument();
  });

  it("omits workspace icon on No project threads and hides project name when filtered", async () => {
    using _server = useServer();
    const scratch = thread("Scratch note", { worktreePath: "/tmp/scratch-wt" }, null);
    const liltThread = thread(
      "Lilt polish",
      { branch: "lilt/fix", worktreePath: "/worktrees/lilt/fix" },
      LILT,
    );
    await using screen = await renderTimeline(
      model({ items: [today, scratch, liltThread], children: [], projects: [MATTR, LILT] }),
    );
    const scratchRow = row(screen.container, scratch)!;
    expect(scratchRow.querySelector("[data-mattr-workspace]")).toBeNull();
    expect(scratchRow.querySelector(".mts-proj")?.textContent).toBe("No project");

    await page.getByRole("button", { name: "Activity scope: All activity" }).click();
    await page.getByRole("menuitemradio", { name: /^Lilt/ }).click();
    const filteredRow = row(screen.container, liltThread)!;
    expect(filteredRow.querySelector(".mts-proj")).toBeNull();
    expect(filteredRow.querySelector('[data-mattr-workspace="worktree"]')).not.toBeNull();
    expect(filteredRow.querySelector(".mts-br")?.textContent).toBe("lilt/fix");
  });

  it("renders Pinned bucket, Failed dot, Unread salience, and idle relative timestamps", async () => {
    using _server = useServer();
    const pinned = thread("Pinned spec", {
      pinnedAt: local(1, 9),
      latestUserMessageAt: local(10, 11),
    });
    const failed = thread("Broken run", { runtime: runtime("failed") });
    const unread = thread("Fresh reply", {
      latestUserMessageAt: local(10, 11),
      lastVisitedAt: local(10, 10),
      latestRun: {
        runId: RunId.make("done"),
        status: "completed",
        requestedAt: null,
        startedAt: local(10, 11),
        completedAt: local(10, 11, 45),
        assistantMessageId: null,
      },
    });
    await using screen = await renderTimeline(
      model({ items: [pinned, failed, unread, today], children: [] }),
    );
    const pinnedRegion = page.getByRole("region", { name: "Pinned" });
    await expect.element(pinnedRegion.getByRole("button", { name: "Pinned spec" })).toBeVisible();
    expect(row(screen.container, pinned)!.querySelector(".mts-pin")).not.toBeNull();

    const failedRow = row(screen.container, failed)!;
    expect(failedRow.querySelector(".mts-fail")).not.toBeNull();
    expect(failedRow.querySelector(".mts-age")).toBeNull();

    const unreadRow = row(screen.container, unread)!;
    expect(unreadRow.hasAttribute("data-unread")).toBe(true);
    expect(unreadRow.querySelector(".mts-unread")).not.toBeNull();
    expect(unreadRow.querySelector(".mts-age")?.textContent).toBe("15m");

    const todayRow = row(screen.container, today)!;
    expect(todayRow.querySelector(".mts-age")?.textContent).toBe("3h");
  });

  it("renders distinct open and merged PR glyphs", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    const openSvg = row(screen.container, today)!.querySelector('.mts-pr[data-state="open"] svg')!;
    const mergedSvg = row(screen.container, yesterday)!.querySelector(
      '.mts-pr[data-state="merged"] svg',
    )!;
    expect(openSvg.innerHTML).not.toBe(mergedSvg.innerHTML);
  });

  it("opens a frosted Web/PWA thread menu on right-click and via the row actions trigger", async () => {
    using _server = useServer();
    const current = model({ children: [] });
    await using screen = await renderTimeline(current);
    const todayRow = row(screen.container, today)!;

    todayRow.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 120 }),
    );
    await expect.element(page.getByRole("menuitem", { name: "Pin" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Pin" }).click();
    expect(current.actions.runThreadAction).toHaveBeenCalledWith(today, "pin");

    const moreButton = todayRow.querySelector<HTMLButtonElement>(".mts-more")!;
    expect(moreButton).not.toBeNull();
    moreButton.click();
    await expect.element(page.getByRole("menuitem", { name: "Mark as unread" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Mark as unread" }).click();
    expect(current.actions.runThreadAction).toHaveBeenCalledWith(today, "mark-unread");
  });

  it("shows 3+ usage meters with severity tones and none without limits", async () => {
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
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          usageLimits: {
            checkedAt: NOW_ISO,
            windows: [
              {
                id: "session",
                kind: "session",
                label: "5h",
                windowDurationMins: 300,
                usedPercent: 82,
              },
            ],
          },
        } as unknown as ServerProvider,
        {
          instanceId: "antigravity",
          driver: "antigravity",
          displayName: "Antigravity",
          enabled: true,
          usageLimits: {
            checkedAt: NOW_ISO,
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 96 }],
          },
        } as unknown as ServerProvider,
      ],
    });
    await using screen = await renderTimeline();
    const meters = page.getByRole("group", { name: "Usage limits" });
    const claudeBtn = meters.getByRole("button", { name: "Claude · wk: 47% used" });
    const codexBtn = meters.getByRole("button", { name: "Codex · 5h: 82% used" });
    const agBtn = meters.getByRole("button", { name: "Antigravity · wk: 96% used" });
    await expect.element(claudeBtn).toHaveAttribute("data-tone", "normal");
    await expect.element(codexBtn).toHaveAttribute("data-tone", "warn");
    await expect.element(agBtn).toHaveAttribute("data-tone", "critical");
    expect(codexBtn.element().querySelector(".mts-pi")?.hasAttribute("data-monochrome")).toBe(true);
    expect(claudeBtn.element().querySelector(".mts-pi")?.hasAttribute("data-monochrome")).toBe(
      false,
    );

    harness.providers = [];
    await screen.rerender(
      <SidebarProvider>
        <MattrTimelineSidebar model={model({ nowMs: NOW_MS + 1 })} />
      </SidebarProvider>,
    );
    await expect.element(meters).not.toBeInTheDocument();
    expect(screen.container.querySelector(".mts-use")).toBeNull();
  });

  it("tracks top/bottom scroll fade and respects data-mattr-scroll-fade=off", async () => {
    using _server = useServer();
    const many = Array.from({ length: 18 }, (_, index) =>
      thread(`Thread ${index + 1}`, { latestUserMessageAt: local(10, 9, index) }),
    );
    await using screen = await render(
      <div style={{ height: "260px", display: "flex", flexDirection: "column" }}>
        <SidebarProvider>
          <MattrTimelineSidebar model={model({ items: many, children: [] })} />
        </SidebarProvider>
      </div>,
    );
    const list = screen.container.querySelector<HTMLDivElement>(".mts-list")!;
    await expect.poll(() => list.hasAttribute("data-scrolled-bottom")).toBe(true);
    expect(list.hasAttribute("data-scrolled-top")).toBe(false);

    list.scrollTop = 60;
    list.dispatchEvent(new Event("scroll"));
    expect(list.hasAttribute("data-scrolled-top")).toBe(true);
    expect(getComputedStyle(list).maskImage).not.toBe("none");

    document.documentElement.setAttribute("data-mattr-scroll-fade", "off");
    try {
      expect(getComputedStyle(list).maskImage).toBe("none");
    } finally {
      document.documentElement.removeAttribute("data-mattr-scroll-fade");
    }
  });

  it("reveals the active row when activeThreadKey changes", async () => {
    using _server = useServer();
    const reveal: SidebarRouteReveal = { observedKey: null, pendingKey: null };
    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    try {
      await using screen = await renderTimeline(model({ activeThreadKey: today.key }), reveal);
      expect(scrollSpy).toHaveBeenCalled();
      scrollSpy.mockClear();

      await screen.rerender(
        <SidebarProvider>
          <MattrTimelineSidebar
            model={model({ activeThreadKey: yesterday.key })}
            routeReveal={reveal}
          />
        </SidebarProvider>,
      );
      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      scrollSpy.mockRestore();
    }
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
