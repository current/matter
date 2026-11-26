import { render } from "../../../../test/render";
import {
  EnvironmentId,
  MATTR_ADDON_MANIFESTS,
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
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../../index.css";
// The rail's look, and the hit areas its rows click through, live in the fork stylesheet.
import "../../../../../../antimatter/sidebar.css";
import { resetAddonStoreForTests } from "../../../addons/addonStore";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { resetBotsStoreForTests } from "../../bots/botsStore";
import { SidebarProvider } from "../../ui/sidebar";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

// Thread jump shortcuts only bind in the desktop app, where Spaces reuses them.
vi.mock(import("../../../env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("../../../addons/mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => config,
}));

import { MattrDefaultSidebar } from "./MattrDefaultSidebar";
import { MattrUsageMeters } from "./MattrDefaultSidebarParts";
import type { MattrChildItem } from "./mattrFinalSidebar.logic";
import { toMattrThreadItem } from "./mattrSidebar.logic";
import { MattrScopeLine } from "./MattrScopeLine";
import { MATTR_SIDEBAR_LAYOUT_STORAGE_KEY } from "./mattrSidebarStore";
import { MattrSpacesSidebar } from "./MattrSpacesSidebar";
import type { MattrSidebarModel, MattrSidebarProject } from "./useMattrSidebarModel";

const NOW_ISO = "2026-03-10T15:00:00.000Z";
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

function thread(title: string, owner: MattrSidebarProject, overrides: ThreadFixtureOverrides = {}) {
  return toMattrThreadItem(
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
  thread("Run xcodebuild on device", MATTR, { hasPendingApprovals: true }),
  thread("Island spring morphs", MATTR, { runtime: runtime("running") }),
  thread("Settings in shell card", MATTR, {
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
  thread("Muse provider matrix", MATTR),
  thread("Pinned plan", MATTR, { pinnedAt: "2026-03-01T00:00:00.000Z" }),
  thread("Old notes", MATTR, { latestUserMessageAt: "2026-03-01T10:00:00.000Z" }),
  thread("Onboarding copy pass", LILT),
];

const subagent = (
  title: string,
  overrides: ThreadFixtureOverrides = {},
  parent = "Muse provider matrix",
  ancestor = parent,
): MattrChildItem => ({
  ...thread(title, MATTR, {
    lineage: {
      rootThreadId: ThreadId.make(ancestor),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
    ...overrides,
  }),
  ancestorKey: `${environmentId}:${ancestor}`,
});

const children = [
  subagent("Audit adapters", { runtime: runtime("running") }),
  subagent("Write matrix doc"),
];

function model(overrides: Partial<MattrSidebarModel> = {}): MattrSidebarModel {
  return {
    items,
    children,
    projects: [MATTR, LILT],
    activeThreadKey: items[1]!.key,
    nowMs: Date.parse(NOW_ISO),
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    actions: { openThread: vi.fn(), newThread: vi.fn(), openThreadMenu: vi.fn() },
    ...overrides,
  };
}

const addons = (grokEnabled: boolean): ReadonlyArray<AddonEntry> =>
  MATTR_ADDON_MANIFESTS.map((manifest) => {
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

describe("MattrDefaultSidebar", () => {
  it("groups threads by project and shows no Crew while the add-on is off", async () => {
    using server = useServer(false);
    const current = model();
    await using screen = await render(
      <SidebarProvider>
        <MattrDefaultSidebar model={current} />
      </SidebarProvider>,
    );
    const mattr = page.getByRole("region", { name: "mattr" });
    await expect.element(mattr).toBeVisible();
    await expect.element(page.getByRole("region", { name: "Lilt" })).toBeVisible();
    const titles = [
      ...screen.container.querySelectorAll('section[aria-label="mattr"] > ul > li'),
    ].map((row) => row.querySelector(".mfs-t")?.textContent);
    expect(titles[0]).toBe("Pinned plan");
    expect(titles).toContain("Old notes");

    await page.getByRole("button", { name: "Island spring morphs", exact: true }).click();
    expect(current.actions.openThread).toHaveBeenCalledWith(items[1]);

    await mattr.getByRole("button", { name: /^mattr/ }).click();
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
        <MattrDefaultSidebar model={current} />
      </SidebarProvider>,
    );
    const tree = page.getByRole("list", { name: "Subagents of Muse provider matrix" });
    await expect.element(tree).toBeVisible();
    const rows = screen.container.querySelectorAll(
      'ul[aria-label="Subagents of Muse provider matrix"] > li[data-mattr-subagent]',
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

  it("nests subagents-of-subagents and counts and keeps subagents that need you", async () => {
    using _server = useServer(false);
    const settledParent = thread("Settled release", MATTR, { settledOverride: "settled" });
    const nested = [
      ...children,
      subagent("Probe one adapter", {}, "Audit adapters", "Muse provider matrix"),
      subagent("Ask about signing", { hasPendingUserInput: true }, "Settled release"),
    ];
    await using screen = await render(
      <SidebarProvider>
        <MattrDefaultSidebar
          model={model({ items: [...items, settledParent], children: nested })}
        />
      </SidebarProvider>,
    );
    const muse = screen.container.querySelectorAll(
      'ul[aria-label="Subagents of Muse provider matrix"] > li[data-mattr-subagent] .mfs-t',
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
        <MattrDefaultSidebar model={current} />
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
        <MattrDefaultSidebar model={model()} />
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
        <MattrDefaultSidebar model={model()} />
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

describe("MattrUsageMeters", () => {
  it("renders live usage per provider and opens Usage on click", async () => {
    const onOpen = vi.fn();
    await using _screen = await render(
      <MattrUsageMeters
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
});

describe("MattrSpacesSidebar", () => {
  it("shows one project at a time with Pinned, Today, and a folded Earlier", async () => {
    using _server = useServer(false);
    const current = model();
    await using screen = await render(
      <SidebarProvider>
        <MattrSpacesSidebar model={current} />
      </SidebarProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "mattr", level: 2 })).toBeVisible();
    const sectionText = (name: string) =>
      screen.container.querySelector(`section[aria-label="${name}"]`)?.textContent ?? "";
    expect(sectionText("Pinned")).toContain("Pinned plan");
    expect(sectionText("Today")).toContain("Island spring morphs");
    expect(sectionText("Today")).not.toContain("Pinned plan");
    await expect.element(page.getByText("Old notes")).not.toBeInTheDocument();
    await page.getByRole("button", { name: /Earlier/ }).click();
    await expect.element(page.getByText("Old notes")).toBeVisible();

    await page.getByRole("button", { name: /New thread in mattr/ }).click();
    expect(current.actions.newThread).toHaveBeenCalledWith(MATTR.key);

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
        <MattrSpacesSidebar model={model()} />
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
        <MattrSpacesSidebar model={model()} />
      </SidebarProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "mattr", level: 2 })).toBeVisible();
    await userEvent.keyboard("{Control>}2{/Control}");
    await expect.element(page.getByRole("heading", { name: "Lilt", level: 2 })).toBeVisible();
  });
});

describe("MattrScopeLine", () => {
  it("persists the layout chosen from its menu", async () => {
    using _server = useServer(false);
    await using _screen = await render(<MattrScopeLine />);
    await page.getByRole("button", { name: /Sidebar view/ }).click();
    await page.getByRole("menuitemradio", { name: "Spaces" }).click();
    expect(window.localStorage.getItem(MATTR_SIDEBAR_LAYOUT_STORAGE_KEY)).toBe('"spaces"');
  });
});
