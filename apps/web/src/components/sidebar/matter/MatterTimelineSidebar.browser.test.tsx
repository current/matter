import { render } from "../../../../test/render";
import {
  EnvironmentId,
  MATTER_ADDON_MANIFESTS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AddonEntry,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../../index.css";
// The rail's look, and the hit areas its rows click through, live in the fork stylesheets.
import "../../../../../../matter/sidebar.css";
import "../../../../../../matter/timeline-sidebar.css";
import "../../../../../../matter/timeline-feed.css";
import { resetAddonStoreForTests } from "../../../addons/addonStore";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { resetBotsStoreForTests } from "../../bots/botsStore";
import { SidebarProvider } from "../../ui/sidebar";

vi.mock(import("../../../addons/matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => ({ baseUrl: "http://server.test", headers: {} }),
}));

const openCommandPalette = vi.hoisted(() => vi.fn());
vi.mock(import("../../../commandPaletteBus"), async (original) => ({
  ...(await original()),
  openCommandPalette,
}));

// Desktop opens rows' menus natively; a non-null local API with a desktop bridge says so.
const localApi = vi.hoisted(() => ({ current: null as object | null }));
vi.mock(import("../../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => localApi.current) as never,
}));

vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
  useEnvironmentProviders: (() => new Map()) as never,
}));

import { MatterBrandMenu } from "./MatterDefaultSidebarParts";
import type { MatterChildItem } from "./matterFinalSidebar.logic";
import { MatterTimelineSidebar } from "./MatterTimelineSidebar";
import { toMatterThreadItem, type MatterThreadItem } from "./matterSidebar.logic";
import {
  MATTER_SIDEBAR_LAYOUT_STORAGE_KEY,
  MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY,
} from "./matterSidebarStore";
import type { MatterSidebarModel, MatterSidebarProject } from "./useMatterSidebarModel";

const FOLDS_STORAGE_KEY = "mattr:sidebar:timeline-folds:v1";
const TIMELINE_SORT_STORAGE_KEY = "mattr:sidebar:timeline-sort:v1";

// Sections follow local calendar days, so every fixture time is a local wall-clock time.
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 2, day, hour, minute).toISOString();
const NOW_ISO = local(20, 12);
const NOW_MS = Date.parse(NOW_ISO);
const environmentId = EnvironmentId.make("local");

const MATTER: MatterSidebarProject = {
  key: `${environmentId}:matter`,
  name: "Matter",
  group: {
    environmentId,
    id: ProjectId.make("Matter"),
    title: "Matter",
    workspaceRoot: "/repo/matter",
    faviconPath: null,
    projectIcon: { kind: "monogram", text: "M", color: "blue" },
  } as unknown as SidebarProjectSnapshot,
};

function thread(title: string, overrides: ThreadFixtureOverrides = {}) {
  return toMatterThreadItem(
    makeThreadFixture({
      environmentId,
      id: ThreadId.make(title),
      projectId: ProjectId.make(MATTER.key),
      title,
      createdAt: local(1, 9),
      latestUserMessageAt: local(20, 9),
      ...overrides,
    }),
    MATTER,
    NOW_ISO,
  );
}

const running = {
  runtime: {
    status: "running" as const,
    activeRunId: RunId.make("run"),
    activityStartedAt: local(20, 11, 48),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: NOW_ISO,
  },
};

const mergedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "current/matter",
  number: 1270,
  url: "https://github.com/current/matter/pull/1270",
  source: "manual",
  linkedAt: local(15, 8),
  stack: null,
  snapshot: {
    state: "merged",
    title: "PR 1270",
    headBranch: "t3/old-fix",
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: local(15, 8),
  },
};

const asks = thread("Sign the build", {
  hasPendingApprovals: true,
  latestUserMessageAt: local(12, 9),
});
const working: MatterThreadItem = {
  ...thread("Port the composer", {
    ...running,
    branch: "t3/composer-port",
    worktreePath: "/worktrees/matter/composer-port",
  }),
  driver: ProviderDriverKind.make("codex"),
};
const waiting = thread("Replay the evals", {
  runtime: { ...running.runtime, status: "idle", activeRunId: null },
  pendingBackgroundTasks: [{ taskId: "replay", kind: "command", awaited: true }],
});
const today = thread("Sidebar pass");
const lastWeek = thread("Old fix", {
  latestUserMessageAt: local(15, 10),
  pullRequests: [mergedPullRequest],
});
const lastMonth = thread("February audit", { latestUserMessageAt: local(3, 10) });
const items = [today, lastMonth, working, lastWeek, asks];

const subagent = (title: string, overrides: ThreadFixtureOverrides = running): MatterChildItem => ({
  ...thread(title, {
    lineage: {
      rootThreadId: ThreadId.make(working.title),
      parentThreadId: ThreadId.make(working.title),
      relationshipToParent: "subagent",
    },
    ...overrides,
  }),
  ancestorKey: working.key,
});

function model(overrides: Partial<MatterSidebarModel> = {}): MatterSidebarModel {
  return {
    items,
    children: [],
    projects: [MATTER],
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

const addons: ReadonlyArray<AddonEntry> = MATTER_ADDON_MANIFESTS.map((manifest) => ({
  manifest,
  state: {
    id: manifest.id,
    enabled: false,
    enablementSource: "default",
    updatedAt: null,
    status: { kind: "disabled" },
  },
}));

function useServer(storage: Record<string, unknown> = {}) {
  const realFetch = globalThis.fetch;
  window.localStorage.clear();
  for (const [key, value] of Object.entries(storage)) {
    window.localStorage.setItem(key, JSON.stringify(value));
  }
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
      resetAddonStoreForTests();
      resetBotsStoreForTests();
    },
  };
}

const renderTimeline = (current: MatterSidebarModel = model()) =>
  render(
    <SidebarProvider>
      <MatterTimelineSidebar model={current} />
    </SidebarProvider>,
  );

const row = (container: HTMLElement, item: { key: string }) =>
  container.querySelector<HTMLElement>(`[data-matter-timeline-row="${item.key}"]`);

const sectionIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-matter-timeline-section]")].map((section) =>
    section.getAttribute("data-matter-timeline-section"),
  );

describe("MatterTimelineSidebar", () => {
  it("leads with what waits on you and what is working, then files the rest by date", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    await expect
      .element(
        page.getByRole("region", { name: "Needs you" }).getByRole("button", {
          name: "Sign the build",
        }),
      )
      .toBeVisible();
    expect(sectionIds(screen.container)).toEqual(["needs", "working", "today", "week", "days30"]);
    await expect
      .element(
        page.getByRole("region", { name: "Active" }).getByRole("button", {
          name: "Port the composer",
        }),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByRole("region", { name: "Previous 7 days" }).getByRole("button", {
          name: "Old fix",
        }),
      )
      .toBeVisible();
  });

  it("says what a row waits on and how long it has run", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    await expect.element(page.getByRole("button", { name: "Sign the build" })).toBeVisible();
    const asksRow = row(screen.container, asks)!;
    expect(asksRow.getAttribute("data-state")).toBe("needs");
    expect(asksRow.querySelector(".mlf-st")?.textContent).toBe("Approval");
    const workingRow = row(screen.container, working)!;
    expect(workingRow.querySelector(".mlf-st")?.textContent).toBe("12m");
    expect(workingRow.querySelector(".mts-spin")).not.toBeNull();
    expect(workingRow.querySelector(".mts-l2 .mlf-st")?.textContent).toBe("Working");
    expect(row(screen.container, today)!.querySelector(".mts-age")?.textContent).toBe("3h");
  });

  it("swaps a row's status for its actions on hover only where the actions button exists", async () => {
    using _server = useServer();
    // Desktop width, where the sidebar isn't the mobile sheet that always shows the button.
    await page.viewport(1280, 900);
    const ageVisibility = (container: HTMLElement) =>
      getComputedStyle(row(container, today)!.querySelector(".mts-age")!).visibility;
    {
      await using screen = await renderTimeline();
      await userEvent.hover(page.getByRole("button", { name: "Sidebar pass" }));
      await expect
        .element(page.getByRole("button", { name: "Actions for Sidebar pass" }))
        .toBeVisible();
      expect(ageVisibility(screen.container)).toBe("hidden");
    }
    localApi.current = {};
    window.desktopBridge = {} as NonNullable<typeof window.desktopBridge>;
    try {
      await using screen = await renderTimeline();
      await userEvent.hover(page.getByRole("button", { name: "Sidebar pass" }));
      expect(screen.container.querySelector(".mts-more")).toBeNull();
      expect(ageVisibility(screen.container)).toBe("visible");
    } finally {
      localApi.current = null;
      delete window.desktopBridge;
    }
  });

  it("keeps recent rows on two lines and history on one", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    await expect.element(page.getByRole("button", { name: "Old fix" })).toBeVisible();
    const workingRow = row(screen.container, working)!;
    expect(workingRow.getAttribute("data-density")).toBe("full");
    expect(workingRow.querySelector('[data-matter-workspace="worktree"]')).not.toBeNull();
    expect(workingRow.querySelector(".mts-l1 .mlf-proj-icon")).not.toBeNull();
    expect(workingRow.querySelector(".mts-l2 .mlf-l2-provider")).not.toBeNull();
    expect(workingRow.querySelector(".mts-proj")?.textContent).toBe("Matter");
    expect(workingRow.querySelector(".mts-br")?.textContent).toBe("composer-port");

    const oldRow = row(screen.container, lastWeek)!;
    expect(oldRow.getAttribute("data-density")).toBe("compact");
    expect(oldRow.querySelector(".mts-l2")).toBeNull();
    expect(oldRow.querySelector('.mlf-pr-mark[data-state="merged"]')).not.toBeNull();
    expect(oldRow.getBoundingClientRect().height).toBeLessThan(
      workingRow.getBoundingClientRect().height,
    );
  });

  it("folds older sections by default, with a count, and saves a fold", async () => {
    using _server = useServer();
    await using screen = await renderTimeline();
    const older = page.getByRole("button", { name: "Previous 30 days, 1" });
    await expect.element(older).toHaveAttribute("aria-expanded", "false");
    expect(row(screen.container, lastMonth)).toBeNull();

    await older.click();
    await expect.element(older).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByRole("button", { name: "February audit" })).toBeVisible();
    expect(JSON.parse(window.localStorage.getItem(FOLDS_STORAGE_KEY) ?? "{}")).toEqual({
      days30: true,
    });

    await page.getByRole("button", { name: "Today, 1" }).click();
    expect(JSON.parse(window.localStorage.getItem(FOLDS_STORAGE_KEY) ?? "{}")).toEqual({
      days30: true,
      today: false,
    });
  });

  it("keeps the open thread on screen inside a folded section", async () => {
    using _server = useServer({ [FOLDS_STORAGE_KEY]: { today: false } });
    const other = thread("Second today");
    await using screen = await renderTimeline(model({ items: [...items, other] }));
    await expect
      .element(page.getByRole("button", { name: "Sidebar pass" }))
      .toHaveAttribute("aria-current", "page");
    expect(row(screen.container, other)).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Today, 2" }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a thread's subagents to a few rows and opens the rest on request", async () => {
    using _server = useServer();
    const children = [
      subagent("Agent one"),
      subagent("Agent two"),
      subagent("Agent three"),
      subagent("Agent four"),
      subagent("Agent five"),
      subagent("Agent asks", { hasPendingUserInput: true }),
      subagent("Agent done", {}),
    ];
    await using screen = await renderTimeline(model({ children }));
    await expect
      .element(page.getByRole("list", { name: "Subagents of Port the composer" }))
      .toBeVisible();
    const shown = () =>
      [...screen.container.querySelectorAll<HTMLElement>("[data-matter-timeline-subagent]")].map(
        (sub) => sub.querySelector(".mts-st")?.textContent,
      );
    expect(shown()).toEqual(["Agent asks", "Agent one", "Agent two"]);
    expect(
      screen.container.querySelector("[data-matter-timeline-subagent] .mts-sm")?.textContent,
    ).toBe("Question");
    // A waiting subagent raises its thread into Needs you.
    expect(row(screen.container, working)!.querySelector(".mlf-st")?.textContent).toBe("Subagent");

    const more = page.getByRole("button", { name: "Show 3 more running subagents" });
    await more.click();
    await expect.element(page.getByRole("button", { name: "Agent five" })).toBeVisible();
    expect(shown()).toHaveLength(6);
    expect(screen.container.textContent).not.toContain("Agent done");
    await page.getByRole("button", { name: "Show fewer subagents" }).click();
    await expect.element(page.getByRole("button", { name: "Agent five" })).not.toBeInTheDocument();
  });

  it("gives an open finished subagent its own row, unless subagents are off", async () => {
    const done = subagent("Agent done", {});
    {
      using _server = useServer();
      await using screen = await renderTimeline(
        model({ children: [done], activeThreadKey: done.key }),
      );
      await expect
        .element(page.getByRole("button", { name: "Agent done" }))
        .toHaveAttribute("aria-current", "page");
      expect(row(screen.container, working)!.hasAttribute("data-active")).toBe(false);
    }
    {
      using _server = useServer({ [MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY]: false });
      await using screen = await renderTimeline(
        model({ children: [done], activeThreadKey: done.key }),
      );
      await expect.element(page.getByRole("button", { name: "Port the composer" })).toBeVisible();
      expect(screen.container.querySelector("[data-matter-timeline-subagent]")).toBeNull();
      expect(row(screen.container, working)!.hasAttribute("data-active")).toBe(true);
    }
  });

  it("sorts and toggles subagents from the view options menu", async () => {
    using _server = useServer();
    await using screen = await renderTimeline(model({ children: [subagent("Agent one")] }));
    const options = page.getByRole("button", { name: /^View options/ });
    await expect.element(options).toHaveAttribute("data-sort", "updated");

    await options.click();
    await page.getByRole("menuitemradio", { name: "Created" }).click();
    await expect.element(options).toHaveAttribute("data-sort", "created");
    expect(window.localStorage.getItem(TIMELINE_SORT_STORAGE_KEY)).toBe('"created"');
    expect(screen.container.querySelector(".mts-so-lab")?.textContent).toBe("Created");

    await options.click();
    await page.getByRole("menuitemcheckbox", { name: "Active subagents" }).click();
    expect(window.localStorage.getItem(MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY)).toBe("false");
    await expect.element(page.getByRole("button", { name: "Agent one" })).not.toBeInTheDocument();
  });

  it("walks rows and folds with the arrow keys and opens the focused row", async () => {
    using _server = useServer();
    const current = model();
    await using _screen = await renderTimeline(current);
    const first = page.getByRole("button", { name: "Sign the build" });
    await expect.element(first).toBeVisible();
    (first.element() as HTMLElement).focus();

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("button", { name: "Active, 1" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("button", { name: "Port the composer" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(current.actions.openThread).toHaveBeenCalledWith(working);

    await userEvent.keyboard("{End}");
    await expect.element(page.getByRole("button", { name: "Previous 30 days, 1" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect.element(first).toHaveFocus();
  });

  it("opens the thread menu on right-click and filters to Needs you", async () => {
    using _server = useServer();
    const current = model();
    await using screen = await renderTimeline(current);
    await expect.element(page.getByRole("button", { name: "Old fix" })).toBeVisible();
    row(screen.container, lastWeek)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 120 }),
    );
    await page.getByRole("menuitem", { name: "Archive" }).click();
    expect(current.actions.runThreadAction).toHaveBeenCalledWith(lastWeek, "archive");

    await page.getByRole("button", { name: "Needs you, 1 waiting" }).click();
    await expect
      .element(page.getByRole("button", { name: "Clear Needs you filter" }))
      .toBeVisible();
    expect(sectionIds(screen.container)).toEqual(["needs"]);
  });

  it("lists a thread waiting on background work under Active, marked Waiting", async () => {
    using _server = useServer();
    await using screen = await renderTimeline(model({ items: [...items, waiting] }));
    await expect
      .element(
        page.getByRole("region", { name: "Active" }).getByRole("button", {
          name: "Replay the evals",
        }),
      )
      .toBeVisible();
    const waitingRow = row(screen.container, waiting)!;
    expect(waitingRow.getAttribute("data-state")).toBe("background");
    expect(waitingRow.querySelector(".mts-spin")).toBeNull();
    expect(waitingRow.querySelector(".mlf-wait")).not.toBeNull();
    expect(waitingRow.querySelector(".mts-l2 .mlf-st")?.textContent).toBe("Waiting");
  });

  it("adds projects and opens project settings from the scope and thread menus", async () => {
    using _server = useServer();
    const current = model();
    await using screen = await renderTimeline(current);
    await page.getByRole("button", { name: "Activity scope: All activity" }).click();
    await page.getByRole("menuitem", { name: "Add project" }).click();
    expect(openCommandPalette).toHaveBeenCalledWith({ open: "add-project" });

    row(screen.container, lastWeek)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 120 }),
    );
    await page.getByRole("menuitem", { name: "Project settings" }).click();
    expect(current.actions.runThreadAction).toHaveBeenCalledWith(lastWeek, "project-settings");
  });

  it("leads with the provider once the list shows one project", async () => {
    using _server = useServer({ "mattr:sidebar:inbox-project:v1": MATTER.key });
    await using screen = await renderTimeline();
    await expect.element(page.getByRole("button", { name: "Port the composer" })).toBeVisible();
    const workingRow = row(screen.container, working)!;
    expect(workingRow.querySelector(".mlf-proj-icon")).toBeNull();
    expect(workingRow.querySelector(".mlf-l2-provider")).toBeNull();
    expect(workingRow.querySelector(".mts-proj")).toBeNull();
  });
});

describe("Timeline layout choice", () => {
  it("is offered in the Matter menu", async () => {
    using _server = useServer();
    await using _screen = await render(<MatterBrandMenu onNavigate={() => {}} />);
    await page.getByRole("button", { name: "Matter menu" }).click();
    await page.getByRole("menuitemradio", { name: "Timeline" }).click();
    expect(window.localStorage.getItem(MATTER_SIDEBAR_LAYOUT_STORAGE_KEY)).toBe('"timeline"');
  });
});
