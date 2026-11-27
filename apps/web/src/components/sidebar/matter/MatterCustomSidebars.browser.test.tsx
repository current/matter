/* oxlint-disable shadcn/no-unknown-classes -- the `mfs-*` classes come from the fork stylesheet matter/sidebar.css, which loads outside Tailwind. */
import { render } from "../../../../test/render";
import {
  EnvironmentId,
  MATTER_ADDON_MANIFESTS,
  NO_BOT_PROVIDER_CAPABILITIES,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AddonEntry,
  type BotIdentity,
  type BotProviderDescriptor,
} from "@t3tools/contracts";
import type { MatterCloudRun } from "@t3tools/client-runtime/matter/cloud-runs";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../../index.css";
// The rail's look, and the hit areas its rows click through, live in the fork stylesheet.
import "../../../../../../matter/sidebar.css";
import { resetAddonStoreForTests } from "../../../addons/addonStore";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { resetBotsStoreForTests } from "../../bots/botsStore";
import { SidebarProvider } from "../../ui/sidebar";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

// Thread jump shortcuts only bind in the desktop app, where Spaces reuses them.
vi.mock(import("../../../env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("../../../addons/matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => config,
}));

import { MatterDefaultSidebar } from "./MatterDefaultSidebar";
import { MatterUsageMeters } from "./MatterDefaultSidebarParts";
import type { MatterChildItem } from "./matterFinalSidebar.logic";
import { toMatterThreadItem } from "./matterSidebar.logic";
import { MatterScopeLine } from "./MatterScopeLine";
import { MATTER_SIDEBAR_LAYOUT_STORAGE_KEY } from "./matterSidebarStore";
import { MatterSpacesSidebar } from "./MatterSpacesSidebar";
import type { MatterSidebarModel, MatterSidebarProject } from "./useMatterSidebarModel";

const NOW_ISO = "2026-03-10T15:00:00.000Z";
const environmentId = EnvironmentId.make("local");

function project(id: string, name: string): MatterSidebarProject {
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

const MATTER = project("Matter", "Matter");
const LILT = project("lilt", "Lilt");

function thread(
  title: string,
  owner: MatterSidebarProject,
  overrides: ThreadFixtureOverrides = {},
) {
  return toMatterThreadItem(
    makeThreadFixture({
      environmentId,
      id: ThreadId.make(title),
      projectId: ProjectId.make(owner.key),
      title,
      latestUserMessageAt: "2026-03-10T14:00:00.000Z",
      ...overrides,
    }),
    owner,
    NOW_ISO,
  );
}

const runtime = (status: "running" | "completed") => ({
  status,
  activeRunId: status === "running" ? RunId.make("run") : null,
  activityStartedAt: "2026-03-10T14:56:00.000Z",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW_ISO,
});

const items = [
  thread("Run xcodebuild on device", MATTER, { hasPendingApprovals: true }),
  thread("Island spring morphs", MATTER, { runtime: runtime("running") }),
  thread("Settings in shell card", MATTER, {
    runtime: runtime("completed"),
    lastVisitedAt: "2026-03-10T14:00:00.000Z",
    latestRun: {
      runId: RunId.make("done"),
      status: "completed",
      requestedAt: null,
      startedAt: "2026-03-10T14:10:00.000Z",
      completedAt: "2026-03-10T14:30:00.000Z",
      assistantMessageId: null,
    },
  }),
  thread("Muse provider matrix", MATTER),
  thread("Pinned plan", MATTER, { pinnedAt: "2026-03-01T00:00:00.000Z" }),
  thread("Old notes", MATTER, { latestUserMessageAt: "2026-03-01T10:00:00.000Z" }),
  thread("Onboarding copy pass", LILT),
];

const subagent = (
  title: string,
  overrides: ThreadFixtureOverrides = {},
  parent = "Muse provider matrix",
  ancestor = parent,
): MatterChildItem => ({
  ...thread(title, MATTER, {
    lineage: {
      rootThreadId: ThreadId.make(ancestor),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
    ...overrides,
  }),
  ancestorKey: `${environmentId}:${ancestor}`,
});

const cloudRun = (id: string, title: string, state: MatterCloudRun["state"]): MatterCloudRun => ({
  id,
  title,
  state,
  sourceThreadId: ThreadId.make("Muse provider matrix"),
  instanceId: "claudeAgent",
  needsAction: null,
  startedAt: "2026-03-10T14:50:00.000Z",
  updatedAt: NOW_ISO,
});

const children = [
  subagent("Audit adapters", { runtime: runtime("running") }),
  subagent("Write matrix doc"),
];

function model(overrides: Partial<MatterSidebarModel> = {}): MatterSidebarModel {
  return {
    items,
    children,
    cloudRuns: new Map(),
    projects: [MATTER, LILT],
    activeThreadKey: items[1]!.key,
    nowMs: Date.parse(NOW_ISO),
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    actions: { openThread: vi.fn(), newThread: vi.fn(), openThreadMenu: vi.fn() },
    ...overrides,
  };
}

const addons = (grokEnabled: boolean): ReadonlyArray<AddonEntry> =>
  MATTER_ADDON_MANIFESTS.map((manifest) => {
    const enabled = manifest.id === "grok-bot" && grokEnabled;
    return {
      manifest,
      state: {
        id: manifest.id,
        enabled,
        enablementSource: enabled ? "user" : "default",
        updatedAt: null,
        status: enabled ? { kind: "connected" } : { kind: "disabled" },
      },
    };
  });

const provider: BotProviderDescriptor = {
  providerId: "grok-bot",
  addonId: "grok-bot",
  displayName: "Grok Bot",
  transport: "local-app-bridge",
  experimental: true,
  status: { kind: "connected" },
  capabilities: NO_BOT_PROVIDER_CAPABILITIES,
  officialAppUrl: null,
};

const bot: BotIdentity = {
  providerId: "grok-bot",
  remoteBotId: "scout",
  accountScopeId: "acct",
  name: "Scout",
  avatar: null,
  status: "working",
  unreadCount: 3,
  defaultConversationId: null,
  officialAppUrl: null,
  metadata: {},
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function useServer(
  grokEnabled: boolean,
  options: { bots?: ReadonlyArray<BotIdentity>; pending?: ReadonlyArray<unknown> } = {},
) {
  const realFetch = globalThis.fetch;
  window.localStorage.clear();
  resetAddonStoreForTests();
  resetBotsStoreForTests();
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/api/mattr/")) return realFetch(input, init);
    switch (url.pathname) {
      case "/api/mattr/addons":
        return json({ addons: addons(grokEnabled) });
      case "/api/mattr/bots/providers":
        return json({ providers: [provider] });
      case "/api/mattr/bots/bots":
        return json({ bots: options.bots ?? [bot] });
      case "/api/mattr/bots/pending":
        return json({ requests: options.pending ?? [] });
      case "/api/mattr/bots/events":
        return new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    botsCalls: () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/mattr/bots/")),
    addonCalls: () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/mattr/addons")),
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      window.localStorage.clear();
      resetAddonStoreForTests();
      resetBotsStoreForTests();
    },
  };
}

describe("MatterDefaultSidebar", () => {
  it("groups threads by project and shows no Crew while the add-on is off", async () => {
    using server = useServer(false);
    const current = model();
    await using screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar model={current} />
      </SidebarProvider>,
    );
    const projectGroup = page.getByRole("region", { name: "Matter" });
    await expect.element(projectGroup).toBeVisible();
    await expect.element(page.getByRole("region", { name: "Lilt" })).toBeVisible();
    const titles = [
      ...screen.container.querySelectorAll('section[aria-label="Matter"] > ul > li'),
    ].map((row) => row.querySelector(".mfs-t")?.textContent);
    expect(titles[0]).toBe("Pinned plan");
    expect(titles).toContain("Old notes");

    await page.getByRole("button", { name: "Island spring morphs", exact: true }).click();
    expect(current.actions.openThread).toHaveBeenCalledWith(items[1]);

    const inbox = page.getByRole("button", { name: "Show all activity" }).element();
    expect(inbox.getBoundingClientRect()).toMatchObject({ width: 28, height: 28 });
    expect(getComputedStyle(inbox)).toMatchObject({ borderRadius: "7px", boxShadow: "none" });

    await projectGroup.getByRole("button", { name: /^Matter/ }).click();
    await expect.element(page.getByText("Pinned plan")).not.toBeInTheDocument();

    await expect.poll(() => server.addonCalls().length).toBeGreaterThan(0);
    expect(screen.container.querySelector('section[aria-label="Crew"]')).toBeNull();
    expect(server.botsCalls()).toEqual([]);
  });

  it("nests subagents under their parent with live status and toggles the tree", async () => {
    using _server = useServer(false);
    const current = model();
    await using screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar model={current} />
      </SidebarProvider>,
    );
    const tree = page.getByRole("list", { name: "Subagents of Muse provider matrix" });
    await expect.element(tree).toBeVisible();
    const rows = screen.container.querySelectorAll(
      'ul[aria-label="Subagents of Muse provider matrix"] > li[data-matter-subagent]',
    );
    expect([...rows].map((row) => row.querySelector(".mfs-t")?.textContent)).toEqual([
      "Audit adapters",
      "Write matrix doc",
    ]);
    expect(rows[0]!.querySelector(".mfs-st")?.getAttribute("data-tone")).toBe("running");
    expect(rows[0]!.querySelector(".mfs-st")?.textContent).toBe("4m");
    expect(rows[1]!.querySelector(".mfs-st")?.textContent).toBe("Done");

    await page.getByRole("button", { name: "Audit adapters", exact: true }).click();
    expect(current.actions.openThread).toHaveBeenCalledWith(children[0]);

    await page.getByRole("button", { name: "Hide subagents of Muse provider matrix" }).click();
    await expect.element(tree).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Show 2 subagents of Muse provider matrix" }).click();
    await expect.element(tree).toBeVisible();
  });

  it("nests a chat's live cloud runs above its subagents and opens their session pages", async () => {
    using _server = useServer(false);
    const parent = items[3]!;
    const current = model({
      cloudRuns: new Map([
        [
          parent.key,
          [
            cloudRun("cse_ask", "Answer the schema question", "needs_input"),
            cloudRun("cse_build", "Full test suite", "running"),
          ],
        ],
      ]),
    });
    await using screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar model={current} />
      </SidebarProvider>,
    );
    await expect
      .element(page.getByRole("list", { name: "Subagents of Muse provider matrix" }))
      .toBeVisible();
    const rows = [
      ...screen.container.querySelectorAll(
        'ul[aria-label="Subagents of Muse provider matrix"] > li',
      ),
    ];
    expect(rows.map((row) => row.querySelector(".mfs-t")?.textContent)).toEqual([
      "Answer the schema question",
      "Full test suite",
      "Audit adapters",
      "Write matrix doc",
    ]);
    expect(rows[0]!.querySelector(".mfs-st")?.textContent).toBe("Needs you");
    expect(rows[1]!.querySelector(".mfs-st")?.getAttribute("data-tone")).toBe("running");
    await expect
      .element(page.getByRole("link", { name: "Full test suite, cloud run, working for 10m" }))
      .toHaveAttribute("href", "/cloud/cse_build?instanceId=claudeAgent");
    await expect
      .element(page.getByRole("button", { name: "Hide subagents of Muse provider matrix" }))
      .toBeVisible();
  });

  it("draws the subagent tree without overlapping strokes", async () => {
    using _server = useServer(false);
    await using screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar model={model()} />
      </SidebarProvider>,
    );
    await expect
      .element(page.getByRole("list", { name: "Subagents of Muse provider matrix" }))
      .toBeVisible();
    const rows = [
      ...screen.container.querySelectorAll<HTMLElement>(
        'ul[aria-label="Subagents of Muse provider matrix"] > li',
      ),
    ];
    expect(rows).toHaveLength(2);
    const [first, last] = rows.map((row) => ({
      elbow: getComputedStyle(row, "::before"),
      trunk: getComputedStyle(row, "::after"),
    }));
    // Elbows start at the parent row's edge; a sibling below draws one full-height trunk
    // and clips the elbow's left stroke so translucent strokes never stack.
    expect(first!.elbow.top).toBe("0px");
    expect(first!.elbow.clipPath).toBe("inset(0px 0px 0px 1.5px)");
    expect(first!.trunk).toMatchObject({ top: "0px", bottom: "0px", width: "1.5px" });
    expect(first!.trunk.left).toBe(first!.elbow.left);
    expect(last!.elbow.clipPath).toBe("none");
    expect(last!.trunk.content).toBe("none");
  });

  it("keeps a tree it opened for the open thread when another tree's subagent is opened", async () => {
    using _server = useServer(false);
    const finished = [
      subagent("Write matrix doc"),
      subagent("Check settings copy", {}, "Settings in shell card"),
    ];
    const at = (activeThreadKey: string) => (
      <SidebarProvider>
        <MatterDefaultSidebar model={model({ children: finished, activeThreadKey })} />
      </SidebarProvider>
    );
    await using screen = await render(at(finished[0]!.key));
    const muse = page.getByRole("list", { name: "Subagents of Muse provider matrix" });
    const settings = page.getByRole("list", { name: "Subagents of Settings in shell card" });
    await expect.element(muse).toBeVisible();
    await expect.element(settings).not.toBeInTheDocument();
    const below = () =>
      page.getByRole("button", { name: "Settings in shell card", exact: true }).element();
    const top = below().getBoundingClientRect().top;

    // Rows jumping under the pointer while moving between subagents reads as flicker.
    await screen.rerender(at(finished[1]!.key));
    await expect.element(settings).toBeVisible();
    await expect.element(muse).toBeVisible();
    expect(below().getBoundingClientRect().top).toBe(top);

    await page.getByRole("button", { name: "Hide subagents of Muse provider matrix" }).click();
    await expect.element(muse).not.toBeInTheDocument();
  });

  it("nests subagents-of-subagents and counts and keeps subagents that need you", async () => {
    using _server = useServer(false);
    const settledParent = thread("Settled release", MATTER, { settledOverride: "settled" });
    const nested = [
      ...children,
      subagent("Probe one adapter", {}, "Audit adapters", "Muse provider matrix"),
      subagent("Ask about signing", { hasPendingUserInput: true }, "Settled release"),
    ];
    await using screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar
          model={model({ items: [...items, settledParent], children: nested })}
        />
      </SidebarProvider>,
    );
    const muse = screen.container.querySelectorAll(
      'ul[aria-label="Subagents of Muse provider matrix"] > li[data-matter-subagent] .mfs-t',
    );
    expect([...muse].map((title) => title.textContent)).toContain("Probe one adapter");

    const needsYou = page.getByRole("button", { name: /Needs you/ });
    await expect.element(needsYou).toHaveTextContent("Needs you2");
    await needsYou.click();
    await expect.element(page.getByText("Settled release")).toBeVisible();
    await expect
      .element(page.getByRole("list", { name: "Subagents of Settled release" }))
      .toBeVisible();
    await expect.element(page.getByText("Ask about signing")).toBeVisible();
    await expect.element(page.getByText("Muse provider matrix")).not.toBeInTheDocument();
  });

  it("filters to Needs you, scopes to one project, and searches titles", async () => {
    using _server = useServer(false);
    const current = model();
    await using _screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar model={current} />
      </SidebarProvider>,
    );
    const needsYou = page.getByRole("button", { name: /Needs you/ });
    await expect.element(needsYou).toHaveAttribute("aria-pressed", "false");
    await expect.element(needsYou).toHaveTextContent("Needs you1");
    await needsYou.click();
    await expect.element(needsYou).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("Run xcodebuild on device")).toBeVisible();
    await expect.element(page.getByText("Island spring morphs")).not.toBeInTheDocument();
    await needsYou.click();

    await page.getByRole("button", { name: "Activity scope: All activity" }).click();
    await page.getByRole("menuitemradio", { name: /Lilt/ }).click();
    await expect.element(page.getByText("Onboarding copy pass")).toBeVisible();
    await expect.element(page.getByText("Island spring morphs")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Show all activity" }).click();
    await expect.element(page.getByText("Island spring morphs")).toBeVisible();

    await page.getByRole("searchbox", { name: "Search threads" }).fill("spring");
    await expect.element(page.getByRole("region", { name: "Search results" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(current.actions.openThread).toHaveBeenCalledWith(items[1]);
  });

  it("shows the Crew section with Bots once the Grok Bot add-on is on", async () => {
    using _server = useServer(true);
    await using _screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar model={model()} />
      </SidebarProvider>,
    );
    const crew = page.getByRole("region", { name: "Crew" });
    await expect.element(crew).toBeVisible();
    await expect
      .element(crew.getByRole("link", { name: /Scout/ }))
      .toHaveAttribute("href", "/bots/grok-bot/scout");
  });

  it("counts a Bot blocked on the user in Needs you", async () => {
    const waiting = { ...bot, remoteBotId: "ward", name: "Ward", status: "idle" as const };
    using _server = useServer(true, {
      bots: [bot, waiting],
      pending: [
        {
          requestId: "r1",
          providerId: "grok-bot",
          accountScopeId: "acct",
          botId: "ward",
          conversationId: null,
          kind: "approval",
          title: "Deploy to production?",
          detail: null,
          options: [],
          allowFreeText: false,
          createdAt: "2026-11-25T12:00:00.000Z",
          expiresAt: null,
        },
      ],
    });
    await using _screen = await render(
      <SidebarProvider>
        <MatterDefaultSidebar model={model()} />
      </SidebarProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: /Needs you/ }))
      .toHaveTextContent("Needs you2");
    await expect
      .element(page.getByRole("region", { name: "Crew" }).getByRole("link", { name: /Ward/ }))
      .toBeVisible();
  });
});

describe("MatterUsageMeters", () => {
  it("renders live usage per provider and opens Usage on click", async () => {
    const onOpen = vi.fn();
    await using _screen = await render(
      <MatterUsageMeters
        nowMs={Date.parse(NOW_ISO)}
        onOpen={onOpen}
        meters={[
          {
            key: "claude:weekly",
            driver: ProviderDriverKind.make("claudeAgent"),
            providerName: "Claude",
            accountName: "Claude main",
            windowLabel: "week",
            usedPercent: 47,
            resetsAt: "2026-03-10T17:14:00.000Z",
          },
          {
            key: "codex:weekly",
            driver: ProviderDriverKind.make("codex"),
            providerName: "Codex",
            accountName: "Codex main",
            windowLabel: "5h",
            usedPercent: 9,
            resetsAt: null,
          },
        ]}
      />,
    );
    const meters = page.getByRole("group", { name: "Usage limits" });
    const claude = meters.getByRole("button", { name: /Claude week: 47% used/ });
    await expect.element(claude).toBeVisible();
    await expect.element(claude.getByText("47%", { exact: true })).toBeVisible();
    await expect.element(claude.getByText("Resets in 2h 14m")).toBeVisible();
    await expect.element(meters.getByRole("button", { name: /Codex 5h: 9% used/ })).toBeVisible();
    await claude.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("draws each meter as a 4px track that stays above its reset line", async () => {
    await using screen = await render(
      <div className="mfs" style={{ width: 280 }}>
        <MatterUsageMeters
          nowMs={Date.parse(NOW_ISO)}
          onOpen={() => {}}
          meters={[
            {
              key: "claude:weekly",
              driver: ProviderDriverKind.make("claudeAgent"),
              providerName: "Claude",
              accountName: "Claude main",
              windowLabel: "week",
              usedPercent: 15,
              resetsAt: "2026-03-10T17:14:00.000Z",
            },
          ]}
        />
      </div>,
    );
    await expect.element(page.getByText("Resets in 2h 14m")).toBeVisible();
    const track = screen.container.querySelector<HTMLElement>(".mfs-tr")!;
    const fill = track.querySelector("i")!;
    const reset = screen.container.querySelector(".mfs-rs")!;
    expect(track.getBoundingClientRect().height).toBe(4);
    expect(fill.getBoundingClientRect().height).toBe(4);
    expect(getComputedStyle(track).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(fill.getBoundingClientRect().width).toBeCloseTo(
      track.getBoundingClientRect().width * 0.15,
      0,
    );
    expect(reset.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      track.getBoundingClientRect().bottom,
    );
  });
});

describe("Default layout titlebar", () => {
  // Web uses browser history ("/"); Electron uses hash history, whose home href ends in "#/".
  it.each(["/", "/#/", "/index.html#/"])(
    "hides the duplicate wordmark linked as %s",
    async (href) => {
      await using screen = await render(
        <div data-matter-sidebar-layout="inbox">
          <header>
            <a href={href} style={{ display: "flex" }}>
              Matter
            </a>
            <button type="button">Toggle</button>
          </header>
          <a href={href}>Elsewhere</a>
        </div>,
      );
      const [brand, elsewhere] = screen.container.querySelectorAll("a");
      expect(getComputedStyle(brand!).display).toBe("none");
      expect(brand!.getBoundingClientRect().width).toBe(0);
      expect(getComputedStyle(elsewhere!).display).not.toBe("none");
    },
  );
});

describe("MatterSpacesSidebar", () => {
  it("shows one project at a time with Pinned, Today, and a folded Earlier", async () => {
    using _server = useServer(false);
    const current = model();
    await using screen = await render(
      <SidebarProvider>
        <MatterSpacesSidebar model={current} />
      </SidebarProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Matter", level: 2 })).toBeVisible();
    const sectionText = (name: string) =>
      screen.container.querySelector(`section[aria-label="${name}"]`)?.textContent ?? "";
    expect(sectionText("Pinned")).toContain("Pinned plan");
    expect(sectionText("Today")).toContain("Island spring morphs");
    expect(sectionText("Today")).not.toContain("Pinned plan");
    await expect.element(page.getByText("Old notes")).not.toBeInTheDocument();
    await page.getByRole("button", { name: /Earlier/ }).click();
    await expect.element(page.getByText("Old notes")).toBeVisible();

    await page.getByRole("button", { name: /New thread in Matter/ }).click();
    expect(current.actions.newThread).toHaveBeenCalledWith(MATTER.key);

    await page.getByRole("group", { name: "Spaces" }).getByRole("button", { name: "Lilt" }).click();
    await expect.element(page.getByRole("heading", { name: "Lilt", level: 2 })).toBeVisible();
    await expect.element(page.getByText("Onboarding copy pass")).toBeVisible();
    await expect.element(page.getByText("Pinned plan")).not.toBeInTheDocument();
    expect(screen.container.querySelector('[role="group"][aria-label="Bots"]')).toBeNull();
  });

  it("shows the Bots favorites row with full character tiles when the Grok Bot add-on is on", async () => {
    using _server = useServer(true);
    await using _screen = await render(
      <SidebarProvider>
        <MatterSpacesSidebar model={model()} />
      </SidebarProvider>,
    );
    const botsGroup = page.getByRole("group", { name: "Bots" });
    await expect.element(botsGroup).toBeVisible();
    await expect
      .element(botsGroup.getByRole("link", { name: /Scout/ }))
      .toHaveAttribute("href", "/bots/grok-bot/scout");
    await expect.element(botsGroup.getByText("Scout")).toBeVisible();
  });

  it("switches spaces with the thread jump shortcuts", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    using _server = useServer(false);
    await using _screen = await render(
      <SidebarProvider>
        <MatterSpacesSidebar model={model()} />
      </SidebarProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Matter", level: 2 })).toBeVisible();
    await userEvent.keyboard("{Control>}2{/Control}");
    await expect.element(page.getByRole("heading", { name: "Lilt", level: 2 })).toBeVisible();
  });
});

describe("MatterScopeLine", () => {
  it("persists the layout chosen from its menu", async () => {
    using _server = useServer(false);
    await using _screen = await render(<MatterScopeLine />);
    await page.getByRole("button", { name: /Sidebar view/ }).click();
    await page.getByRole("menuitemradio", { name: "Spaces" }).click();
    expect(window.localStorage.getItem(MATTER_SIDEBAR_LAYOUT_STORAGE_KEY)).toBe('"spaces"');
  });
});
