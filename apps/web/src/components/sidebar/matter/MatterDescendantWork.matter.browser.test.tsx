import { render } from "../../../../test/render";
import {
  EnvironmentId,
  MATTER_ADDON_MANIFESTS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AddonEntry,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../../index.css";
import "../../../../../../matter/sidebar.css";
import "../../../../../../matter/timeline-sidebar.css";
import { resetAddonStoreForTests } from "../../../addons/addonStore";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../../test-fixtures";
import { resetBotsStoreForTests } from "../../bots/botsStore";
import { SidebarProvider } from "../../ui/sidebar";

vi.mock(import("../../../addons/matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => ({ baseUrl: "http://server.test", headers: {} }),
}));

vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
  useEnvironmentProviders: (() => new Map()) as never,
}));

import { MatterDefaultSidebar } from "./MatterDefaultSidebar";
import type { MatterChildItem } from "./matterFinalSidebar.logic";
import {
  toMatterThreadItem,
  withDescendantWork,
  workingDescendantSince,
} from "./matterSidebar.logic";
import { MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY } from "./matterSidebarStore";
import { MatterTimelineSidebar } from "./MatterTimelineSidebar";
import type { MatterSidebarModel, MatterSidebarProject } from "./useMatterSidebarModel";

const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 2, day, hour, minute).toISOString();
const NOW_ISO = local(10, 12);
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
    projectIcon: { kind: "monogram", text: "m", color: "blue" },
  } as unknown as SidebarProjectSnapshot,
};

const runtime = (status: "running" | "completed" | "idle") => ({
  status,
  activeRunId: status === "running" ? RunId.make("run") : null,
  activityStartedAt: status === "running" ? local(10, 11, 56) : null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW_ISO,
});

function thread(title: string, overrides: ThreadFixtureOverrides = {}) {
  return toMatterThreadItem(
    makeThreadFixture({
      environmentId,
      id: ThreadId.make(title),
      projectId: ProjectId.make(MATTER.key),
      title,
      // Yesterday, so only running work lists it under Active.
      latestUserMessageAt: local(9, 15),
      createdAt: local(9, 15),
      ...overrides,
    }),
    MATTER,
    NOW_ISO,
  );
}

// Its own turn ended; it is only waiting on the work it started.
const parent = thread("Release prep", { runtime: runtime("idle") });

function subagent(
  title: string,
  status: "running" | "completed",
  parentTitle = parent.title,
): MatterChildItem {
  return {
    ...thread(title, {
      runtime: runtime(status),
      lineage: {
        rootThreadId: ThreadId.make(parent.title),
        parentThreadId: ThreadId.make(parentTitle),
        relationshipToParent: "subagent",
      },
    }),
    ancestorKey: parent.key,
  };
}

function model(children: ReadonlyArray<MatterChildItem>): MatterSidebarModel {
  const since = workingDescendantSince([parent, ...children]);
  return {
    items: withDescendantWork([parent], since),
    children: withDescendantWork(children, since),
    projects: [MATTER],
    activeThreadKey: null,
    nowMs: Date.parse(NOW_ISO),
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    actions: { openThread: vi.fn(), newThread: vi.fn(), openThreadMenu: vi.fn() },
  };
}

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
      if (url.pathname === "/api/mattr/addons") {
        return new Response(JSON.stringify({ addons }), {
          headers: { "content-type": "application/json" },
        });
      }
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

const timelineRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(`[data-matter-timeline-row="${parent.key}"]`);

describe("Timeline parent with working subagents", () => {
  it.each([true, false])(
    "spins and stays in Active while a subagent runs (Active subagents %s)",
    async (showSubagents) => {
      using _server = useServer({ [MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY]: showSubagents });
      const timeline = (children: ReadonlyArray<MatterChildItem>) => (
        <SidebarProvider>
          <MatterTimelineSidebar model={model(children)} />
        </SidebarProvider>
      );
      await using screen = await render(timeline([subagent("Audit adapters", "running")]));
      const working = page.getByRole("region", { name: "Active" });
      await expect.element(working.getByRole("button", { name: parent.title })).toBeVisible();
      await expect.element(working.getByText(/^Working for/).first()).toBeInTheDocument();
      expect(timelineRow(screen.container)!.querySelector(".mts-spin")).not.toBeNull();
      expect(screen.container.querySelector("[data-matter-timeline-subagent]") !== null).toBe(
        showSubagents,
      );

      await screen.rerender(timeline([subagent("Audit adapters", "completed")]));
      await expect
        .element(
          page.getByRole("region", { name: "Yesterday" }).getByRole("button", {
            name: parent.title,
          }),
        )
        .toBeVisible();
      expect(timelineRow(screen.container)!.querySelector(".mts-spin")).toBeNull();
    },
  );

  it("spins for a grandchild that runs under a finished subagent", async () => {
    using _server = useServer({ [MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY]: false });
    await using screen = await render(
      <SidebarProvider>
        <MatterTimelineSidebar
          model={model([
            subagent("Plan release", "completed"),
            subagent("Sign build", "running", "Plan release"),
          ])}
        />
      </SidebarProvider>,
    );
    await expect
      .element(
        page.getByRole("region", { name: "Active" }).getByRole("button", { name: parent.title }),
      )
      .toBeVisible();
    expect(timelineRow(screen.container)!.querySelector(".mts-spin")).not.toBeNull();
  });
});

describe("Default parent with working subagents", () => {
  it("shows running on the row and the folded project until the subagent finishes", async () => {
    using _server = useServer();
    const rail = (children: ReadonlyArray<MatterChildItem>) => (
      <SidebarProvider>
        <MatterDefaultSidebar model={model(children)} />
      </SidebarProvider>
    );
    await using screen = await render(rail([subagent("Audit adapters", "running")]));
    const status = () =>
      screen.container.querySelector(`[data-matter-thread-row="${parent.key}"] .mfs-row .mfs-a`);
    await expect.element(page.getByRole("button", { name: parent.title })).toBeVisible();
    expect(status()?.getAttribute("data-tone")).toBe("running");
    expect(status()?.textContent).toBe("4m");

    await page.getByRole("button", { name: `Hide subagents of ${parent.title}` }).click();
    expect(status()?.getAttribute("data-tone")).toBe("running");

    const group = page.getByRole("region", { name: "Matter" });
    await group.getByRole("button", { name: /^Matter/ }).click();
    await expect.element(group.getByRole("img", { name: "Running" })).toBeVisible();

    await screen.rerender(rail([subagent("Audit adapters", "completed")]));
    await expect.element(group.getByRole("img", { name: "Running" })).not.toBeInTheDocument();
    await group.getByRole("button", { name: /^Matter/ }).click();
    await expect.element(page.getByRole("button", { name: parent.title })).toBeVisible();
    expect(status()?.getAttribute("data-tone")).toBe("muted");
  });
});
