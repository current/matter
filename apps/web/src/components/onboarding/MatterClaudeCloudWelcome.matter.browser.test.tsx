import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MATTER_ADDON_MANIFESTS,
  ProviderDriverKind,
  ProviderInstanceId,
  type AddonEntry,
  type ClaudeCloudOffloadPolicy,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown,
  config: null as unknown,
  matterConfig: { baseUrl: "http://server.test", headers: {} },
  cloudEnabled: false,
  settingsStatus: 200,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      configValueAtom: (() => state.config) as never,
    },
  };
});

vi.mock(import("../../addons/matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => state.matterConfig,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));

import { loadAddons, resetAddonStoreForTests } from "../../addons/addonStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  CLAUDE_CLOUD_WELCOME_DISMISSED_KEY,
  MatterClaudeCloudWelcome,
} from "./MatterClaudeCloudWelcome";

const environmentId = EnvironmentId.make("primary");

function provider(id: string, driver: string, overrides: Partial<ServerProvider> = {}) {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } satisfies ServerProvider;
}

const claude = provider("claudeAgent", "claudeAgent");
const codex = provider("codex", "codex");
const signedOutClaude = provider("claudeAgent", "claudeAgent", {
  auth: { status: "unauthenticated" },
});

const addonEntries = (enabled: boolean): ReadonlyArray<AddonEntry> =>
  MATTER_ADDON_MANIFESTS.map((manifest) => {
    const on = manifest.id === "claude-cloud" && enabled;
    return {
      manifest,
      state: {
        id: manifest.id,
        enabled: on,
        enablementSource: on ? "user" : "default",
        updatedAt: null,
        status: on ? { kind: "connected" } : { kind: "disabled" },
      },
    };
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function mount(options: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cloudEnabled: boolean;
  readonly settingsStatus?: number;
}) {
  window.localStorage.removeItem(CLAUDE_CLOUD_WELCOME_DISMISSED_KEY);
  window.localStorage.removeItem("mattr:addons:v1");
  resetAddonStoreForTests();
  state.cloudEnabled = options.cloudEnabled;
  state.settingsStatus = options.settingsStatus ?? 200;

  const settingsCalls: Array<{ readonly offloadPolicy?: ClaudeCloudOffloadPolicy }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/mattr/addons") {
      return json({ addons: addonEntries(state.cloudEnabled) });
    }
    if (url.pathname === "/api/mattr/claude-cloud/settings" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { offloadPolicy?: ClaudeCloudOffloadPolicy };
      settingsCalls.push(body);
      if (state.settingsStatus !== 200) {
        return json({ error: "save_failed", detail: "Could not save." }, state.settingsStatus);
      }
      return json({
        settings: {
          defaultInstanceId: null,
          offloadPolicy: body.offloadPolicy ?? "balanced",
          agentDelegationMode: body.offloadPolicy === "off" ? "off" : "auto",
          delegationRules: "",
          autoPushBeforeLaunch: false,
        },
      });
    }
    return json({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  await loadAddons(state.matterConfig);

  state.providers = Atom.make(options.providers).pipe(Atom.keepAlive);
  state.config = Atom.make({
    settings: { ...DEFAULT_SERVER_SETTINGS },
  }).pipe(Atom.keepAlive);

  const screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <MatterClaudeCloudWelcome environmentId={environmentId} />
    </RegistryContext.Provider>,
    { router: false },
  );

  return {
    screen,
    settingsCalls,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      vi.unstubAllGlobals();
      window.localStorage.removeItem(CLAUDE_CLOUD_WELCOME_DISMISSED_KEY);
      window.localStorage.removeItem("mattr:addons:v1");
      resetAddonStoreForTests();
    },
  };
}

describe("MatterClaudeCloudWelcome", () => {
  it("stays hidden when the user has no ready Claude account", async () => {
    await using _ctx = await mount({ providers: [codex, signedOutClaude], cloudEnabled: true });
    expect(document.querySelector("[data-claude-cloud-welcome]")).toBeNull();
  });

  it("stays hidden when the claude-cloud add-on is disabled", async () => {
    await using _ctx = await mount({ providers: [claude, codex], cloudEnabled: false });
    expect(document.querySelector("[data-claude-cloud-welcome]")).toBeNull();
  });

  it("writes the chosen offload preset through the settings API and persists dismissal", async () => {
    await using ctx = await mount({ providers: [claude], cloudEnabled: true });
    await expect.element(page.getByRole("heading", { name: "Claude Cloud" })).toBeVisible();
    await expect.element(page.getByText("Recommended", { exact: true })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /Battery saver/ }));
    await vi.waitFor(() => expect(ctx.settingsCalls).toEqual([{ offloadPolicy: "battery_saver" }]));
    await expect
      .element(page.getByRole("heading", { name: "Claude Cloud" }))
      .not.toBeInTheDocument();
    expect(window.localStorage.getItem(CLAUDE_CLOUD_WELCOME_DISMISSED_KEY)).toBe("1");

    // Remounting stays dismissed.
    await using _remount = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MatterClaudeCloudWelcome environmentId={environmentId} />
      </RegistryContext.Provider>,
      { router: false },
    );
    expect(document.querySelector("[data-claude-cloud-welcome]")).toBeNull();
  });

  it("dismisses without writing settings when the dismiss button is clicked", async () => {
    await using ctx = await mount({ providers: [claude], cloudEnabled: true });
    await userEvent.click(page.getByRole("button", { name: "Dismiss Claude Cloud setup" }));
    await expect
      .element(page.getByRole("heading", { name: "Claude Cloud" }))
      .not.toBeInTheDocument();
    expect(ctx.settingsCalls).toEqual([]);
    expect(window.localStorage.getItem(CLAUDE_CLOUD_WELCOME_DISMISSED_KEY)).toBe("1");
  });

  it("stays open with an alert if saving fails", async () => {
    await using ctx = await mount({ providers: [claude], cloudEnabled: true, settingsStatus: 500 });
    await userEvent.click(page.getByRole("button", { name: /Cloud first/ }));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Claude Cloud" })).toBeVisible();
    expect(ctx.settingsCalls).toEqual([{ offloadPolicy: "cloud_first" }]);
    expect(window.localStorage.getItem(CLAUDE_CLOUD_WELCOME_DISMISSED_KEY)).toBeNull();
  });
});
