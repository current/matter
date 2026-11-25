import { render } from "../../test/render";
import {
  CLAUDE_CLOUD_DEFAULT_SETTINGS,
  MATTR_ADDON_MANIFESTS,
  ProviderInstanceId,
  type AddonEntry,
  type AddonRuntimeStatus,
  type ClaudeCloudStatus,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../index.css";
import { resetAddonStoreForTests } from "./addonStore";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("./mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => config,
}));

import { AddonsSettingsPanel } from "./AddonsSettingsPanel";

let grokStatus: AddonRuntimeStatus = {
  kind: "app_unavailable",
  detail: "Open Grok Bot to connect.",
};

function entries(enabled: Record<string, boolean>): ReadonlyArray<AddonEntry> {
  return MATTR_ADDON_MANIFESTS.map((manifest) => {
    const on = enabled[manifest.id] ?? false;
    return {
      manifest,
      state: {
        id: manifest.id,
        enabled: on,
        enablementSource: on ? "user" : "default",
        updatedAt: null,
        status: on
          ? manifest.id === "grok-bot"
            ? grokStatus
            : { kind: "connected" }
          : { kind: "disabled" },
      },
    };
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;

describe("AddonsSettingsPanel", () => {
  let enabled: Record<string, boolean>;
  let refuseWrites: boolean;
  let grokConfig: Record<string, unknown>;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/mattr/claude-cloud")) return claudeCloudResponse(url, init);
    if (!url.pathname.startsWith("/api/mattr/addons")) return realFetch(input, init);
    if (url.pathname === "/api/mattr/addons/config") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { config: Record<string, unknown> };
        grokConfig = { ...grokConfig, ...body.config };
      }
      return json({ id: "grok-bot", config: grokConfig });
    }
    if (url.pathname === "/api/mattr/addons/reconnect") {
      grokStatus = { kind: "connected" };
    }
    if (url.pathname === "/api/mattr/addons/enabled") {
      if (refuseWrites) return json({ error: "forbidden" }, 403);
      const body = JSON.parse(String(init?.body)) as { id: string; enabled: boolean };
      enabled = { ...enabled, [body.id]: body.enabled };
    }
    return json({ addons: entries(enabled) });
  });

  let cloudStatus: ClaudeCloudStatus;
  const claudeCloudResponse = (url: URL, init: RequestInit | undefined) => {
    if (url.pathname === "/api/mattr/claude-cloud/status") {
      if (url.searchParams.get("refresh") === "1") {
        cloudStatus = {
          ...cloudStatus,
          accounts: [
            {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              displayName: "Claude",
              ready: true,
              planTier: "max_20x",
              checkedAt: "2026-11-25T00:00:00.000Z",
            },
            {
              instanceId: ProviderInstanceId.make("claude-alt"),
              displayName: "Claude Alt",
              ready: false,
              problem: "signed_out",
              checkedAt: "2026-11-25T00:00:00.000Z",
            },
          ],
        };
      }
      return json(cloudStatus);
    }
    if (url.pathname === "/api/mattr/claude-cloud/settings") {
      const patch = JSON.parse(String(init?.body)) as Partial<ClaudeCloudStatus["settings"]>;
      cloudStatus = { ...cloudStatus, settings: { ...cloudStatus.settings, ...patch } };
      return json({ settings: cloudStatus.settings });
    }
    if (url.pathname.startsWith("/api/mattr/claude-cloud/sessions/") && init?.method === "DELETE") {
      cloudStatus = { ...cloudStatus, sessions: [] };
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  };
  const cloudCalls = () =>
    fetchMock.mock.calls
      .map(([input, init]) => ({ url: new URL(String(input)), init }))
      .filter(({ url }) => url.pathname.startsWith("/api/mattr/claude-cloud"));

  const addonCalls = () =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/mattr/addons")).length;

  function useAddonServer({ refuse = false } = {}): Disposable {
    enabled = {};
    refuseWrites = refuse;
    grokConfig = {};
    grokStatus = { kind: "app_unavailable", detail: "Open Grok Bot to connect." };
    cloudStatus = {
      enabled: true,
      settings: CLAUDE_CLOUD_DEFAULT_SETTINGS,
      instances: [
        { instanceId: ProviderInstanceId.make("claudeAgent"), displayName: "Claude" },
        { instanceId: ProviderInstanceId.make("claude-alt"), displayName: "Claude Alt" },
      ],
      accounts: [],
      sessions: [
        {
          id: "cse_01ABCDEFGH1234",
          url: "https://claude.ai/code/cse_01ABCDEFGH1234",
          title: "Run the e2e suite",
          promptPreview: "Run the e2e suite",
          instanceId: ProviderInstanceId.make("claudeAgent"),
          projectId: null,
          cwd: null,
          branch: "main",
          createdBy: "agent",
          sourceThreadId: null,
          reason: "Takes 20 minutes locally",
          createdAt: "2026-11-25T00:00:00.000Z",
          lastMessageAt: null,
          lastReplyPreview: "All 412 tests pass.",
          teleportedThreadId: null,
          teleportedWorktreePath: null,
        },
      ],
    };
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.removeItem("mattr:addons:v1");
    resetAddonStoreForTests();
    return {
      [Symbol.dispose]: () => {
        vi.unstubAllGlobals();
        window.localStorage.removeItem("mattr:addons:v1");
        resetAddonStoreForTests();
      },
    };
  }

  it("lists every add-on, off by default, with its status", async () => {
    using _server = useAddonServer();
    await using screen = await render(<AddonsSettingsPanel />);
    await expect
      .element(page.getByText("Talk to your existing Grok Bot teammates", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText("A hands-free assistant", { exact: false })).toBeVisible();
    await expect
      .element(page.getByText("Offload heavy work to Claude Cloud VMs", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText("Talk to your Devin Bots", { exact: false })).toBeVisible();
    expect(page.getByText("Experimental").elements()).toHaveLength(3);
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).not.toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Enable Voice Assistant" }))
      .not.toBeChecked();
    expect(screen.container.querySelectorAll("[data-addon-status]")).toHaveLength(
      MATTR_ADDON_MANIFESTS.length,
    );
  });

  it("turns an add-on on, shows its server status, and offers its settings", async () => {
    using _server = useAddonServer();
    await using _screen = await render(<AddonsSettingsPanel />);
    await expect.poll(() => addonCalls()).toBe(1);

    await userEvent.click(page.getByRole("switch", { name: "Enable Grok Bot" }));
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).toBeChecked();
    await expect.element(page.getByText("Grok Bot app not installed")).toBeVisible();
    await expect
      .element(page.getByText("Install Grok Bot on this Mac, then test the connection."))
      .toBeVisible();
    const write = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/enabled"));
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      id: "grok-bot",
      enabled: true,
      source: "user",
    });
    // Grok Bot is configured on this page, so it gets no separate Configure link.
    await expect.element(page.getByRole("link", { name: "Configure" })).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("switch", { name: "Enable Voice Assistant" }));
    await expect
      .element(page.getByRole("link", { name: "Configure" }))
      .toHaveAttribute("href", "/settings/general#mattr-voice-assistant");

    await userEvent.click(page.getByRole("switch", { name: "Enable Grok Bot" }));
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).not.toBeChecked();
  });

  it("shows Grok Bot's debug port, launch command and connection test when enabled", async () => {
    using _server = useAddonServer();
    enabled = { "grok-bot": true };
    grokStatus = { kind: "enabled_unconfigured", detail: "Grok Bot isn't reachable." };
    await using screen = await render(<AddonsSettingsPanel />);

    await expect.element(page.getByText("Needs debug port")).toBeVisible();
    const port = page.getByRole("spinbutton", { name: "Debug port" });
    await expect.element(port).toHaveValue(9222);
    await expect
      .element(page.getByText('open -a "Grok Bot" --args --remote-debugging-port=9222'))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy command" })).toBeVisible();

    await userEvent.fill(port, "9333");
    await expect
      .element(page.getByText('open -a "Grok Bot" --args --remote-debugging-port=9333'))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Test connection" }));

    await expect.element(page.getByText("Connected")).toBeVisible();
    expect(grokConfig).toEqual({ cdpPort: 9333 });
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toContain("/api/mattr/addons/reconnect");
    expect(screen.container.querySelector("[data-grok-bot-command]")).toBeNull();
  });

  it("shows no Claude Cloud card and calls none of its routes while it is off", async () => {
    using _server = useAddonServer();
    await using screen = await render(<AddonsSettingsPanel />);
    await expect
      .element(page.getByRole("switch", { name: "Enable Claude Cloud" }))
      .not.toBeChecked();
    expect(screen.container.querySelector("[data-claude-cloud-settings]")).toBeNull();
    expect(cloudCalls()).toEqual([]);
  });

  it("configures Claude Cloud: accounts, delegation, rules, auto-push and sessions", async () => {
    using _server = useAddonServer();
    enabled = { "claude-cloud": true };
    await using _screen = await render(<AddonsSettingsPanel />);

    await expect.element(page.getByText("Run the e2e suite")).toBeVisible();
    await expect.element(page.getByText("All 412 tests pass.")).toBeVisible();
    await expect.element(page.getByText("By an agent")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Open in claude.ai" }))
      .toHaveAttribute("href", "https://claude.ai/code/cse_01ABCDEFGH1234");
    // Loading the card never asks the server to run the CLI.
    expect(cloudCalls().map(({ url }) => url.search)).toEqual([""]);
    await expect.element(page.getByText("Not checked").first()).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Refresh" }));
    await expect.element(page.getByText("Ready · max_20x")).toBeVisible();
    await expect.element(page.getByText("Signed out")).toBeVisible();

    await userEvent.fill(
      page.getByRole("textbox", { name: "Custom delegation rules" }),
      "Only test suites over five minutes.",
    );
    await userEvent.click(page.getByRole("button", { name: "Save rules" }));
    await expect
      .poll(() => cloudStatus.settings.delegationRules)
      .toBe("Only test suites over five minutes.");
    await expect.element(page.getByRole("button", { name: "Save rules" })).toBeDisabled();

    await userEvent.click(page.getByRole("switch", { name: "Push before launching" }));
    await expect.poll(() => cloudStatus.settings.autoPushBeforeLaunch).toBe(true);

    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    await expect.element(page.getByText("No cloud sessions yet.")).toBeVisible();
    expect(
      cloudCalls().some(
        ({ url, init }) =>
          init?.method === "DELETE" &&
          url.pathname === "/api/mattr/claude-cloud/sessions/cse_01ABCDEFGH1234",
      ),
    ).toBe(true);
  });

  it("puts the switch back and explains when the server refuses", async () => {
    using _server = useAddonServer({ refuse: true });
    await using _screen = await render(<AddonsSettingsPanel />);
    await expect.poll(() => addonCalls()).toBe(1);
    await userEvent.click(page.getByRole("switch", { name: "Enable Grok Bot" }));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).not.toBeChecked();
  });
});
