import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
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
  updateSettings: vi.fn(),
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
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => state.updateSettings) as never,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { MatterDelegationWelcome } from "./MatterDelegationWelcome";

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
const signedOutCursor = provider("cursor", "cursor", { auth: { status: "unauthenticated" } });

async function mount(providers: ReadonlyArray<ServerProvider>) {
  state.providers = Atom.make(providers).pipe(Atom.keepAlive);
  state.config = Atom.make({
    settings: { ...DEFAULT_SERVER_SETTINGS },
  }).pipe(Atom.keepAlive);
  state.updateSettings.mockReset().mockImplementation((patch: object) => {
    const current = appAtomRegistry.get(state.config as Atom.Writable<{ settings: object }>);
    appAtomRegistry.set(state.config as Atom.Writable<{ settings: object }>, {
      settings: { ...current.settings, ...patch },
    });
  });
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <MatterDelegationWelcome environmentId={environmentId} />
    </RegistryContext.Provider>,
    { router: false },
  );
}

describe("MatterDelegationWelcome", () => {
  it("stays hidden with fewer than two signed-in subscriptions", async () => {
    await using _screen = await mount([claude, signedOutCursor]);
    expect(document.body.textContent).not.toContain("Multi-provider delegation");
  });

  it("offers delegation with two signed-in subscriptions and turns it off", async () => {
    await using _screen = await mount([claude, codex, signedOutCursor]);
    await expect.element(page.getByRole("heading", { name: "Subscriptions" })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Multi-provider delegation" });
    await expect.element(toggle).toBeChecked();

    await userEvent.click(toggle);
    expect(state.updateSettings).toHaveBeenCalledWith({ mattrMultiProviderDelegation: false });
    await expect.element(toggle).not.toBeChecked();
  });
});
