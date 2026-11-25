import { render } from "../../../../test/render";
import {
  EnvironmentId,
  MATTR_ADDON_MANIFESTS,
  NO_BOT_PROVIDER_CAPABILITIES,
  ProjectId,
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

import { MattrAttentionInboxSidebar } from "./MattrAttentionInboxSidebar";
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

function model(): MattrSidebarModel {
  return {
    items,
    projects: [MATTR, LILT],
    activeThreadKey: items[1]!.key,
    nowMs: Date.parse(NOW_ISO),
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    actions: { openThread: vi.fn(), newThread: vi.fn(), openThreadMenu: vi.fn() },
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

function useServer(grokEnabled: boolean) {
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
        return json({ bots: [bot] });
      case "/api/mattr/bots/pending":
        return json({ requests: [] });
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

describe("MattrAttentionInboxSidebar", () => {
  it("orders threads by attention, folds Quiet, and shows no Bots while the add-on is off", async () => {
    using server = useServer(false);
    const current = model();
    await using screen = await render(
      <SidebarProvider>
        <MattrAttentionInboxSidebar model={current} />
      </SidebarProvider>,
    );
    const headings = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) => heading.textContent);
    await expect.element(page.getByRole("region", { name: "Needs you" })).toBeVisible();
    expect(headings()).toEqual(["Needs you1", "Running1", "Ready to review1", "Quiet4"]);
    await expect.element(page.getByText("Muse provider matrix")).not.toBeInTheDocument();

    await page.getByRole("button", { name: /Quiet/ }).click();
    await expect.element(page.getByText("Muse provider matrix")).toBeVisible();

    await page.getByRole("button", { name: "Review" }).click();
    expect(current.actions.openThread).toHaveBeenCalledWith(items[0]);

    await page.getByRole("button", { name: /Island spring morphs/ }).click();
    expect(current.actions.openThread).toHaveBeenCalledWith(items[1]);

    await expect.poll(() => server.addonCalls().length).toBeGreaterThan(0);
    expect(screen.container.querySelector('[role="group"][aria-label="Bots"]')).toBeNull();
    expect(server.botsCalls()).toEqual([]);
  });

  it("slices the queue to one project and searches titles", async () => {
    using _server = useServer(false);
    const current = model();
    await using _screen = await render(
      <SidebarProvider>
        <MattrAttentionInboxSidebar model={current} />
      </SidebarProvider>,
    );
    await page.getByRole("button", { name: /Sidebar view: Inbox, All projects/ }).click();
    await page.getByRole("menuitemradio", { name: /Lilt/ }).click();
    await expect.element(page.getByRole("region", { name: "Running" })).not.toBeInTheDocument();
    await page.getByRole("button", { name: /Quiet/ }).click();
    await expect.element(page.getByText("Onboarding copy pass")).toBeVisible();
    await expect.element(page.getByText("Muse provider matrix")).not.toBeInTheDocument();

    await page.getByRole("button", { name: /Sidebar view: Inbox, Lilt/ }).click();
    await page.getByRole("menuitemradio", { name: "All projects" }).click();
    await page.getByRole("searchbox", { name: "Search threads" }).fill("spring");
    await expect.element(page.getByRole("region", { name: "Search results" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(current.actions.openThread).toHaveBeenCalledWith(items[1]);
  });

  it("shows the Crew section and bot attention once the Grok Bot add-on is on", async () => {
    using _server = useServer(true);
    await using _screen = await render(
      <SidebarProvider>
        <MattrAttentionInboxSidebar model={model()} />
      </SidebarProvider>,
    );
    const crew = page.getByRole("region", { name: "Crew" });
    await expect.element(crew).toBeVisible();
    await expect
      .element(crew.getByRole("link", { name: /Scout/ }))
      .toHaveAttribute("href", "/bots/grok-bot/scout");
    await expect.element(crew.getByText("3 unread")).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: /Needs you/ }))
      .toHaveTextContent("Needs you2");
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
