import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: null as unknown as typeof DEFAULT_UNIFIED_SETTINGS,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    connectedEnvironments: [],
    targets: [],
    target: null,
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    control,
    resetAction,
    children,
  }: {
    title: ReactNode;
    control: ReactNode;
    resetAction: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {control}
      {resetAction}
      {children}
    </div>
  )) as never,
}));

import { MatterDelegationSettings } from "./MatterDelegationSettings";

function entry(id: string, displayName: string, enabled = true): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make("claudeAgent"),
    displayName,
    enabled,
  } as ProviderInstanceEntry;
}

const ENTRIES = [
  entry("claudeAgent", "Claude main"),
  entry("claude-alt-2", "Claude pro"),
  entry("cursor", "Cursor", false),
];

async function setup() {
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  const content = () => <MatterDelegationSettings entries={ENTRIES} disabled={false} />;
  const screen = await render(content(), { router: false });
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.settings = { ...state.settings, ...patch } as typeof DEFAULT_UNIFIED_SETTINGS;
    void screen.rerender(content());
  });
  return screen;
}

describe("MatterDelegationSettings", () => {
  it("is on by default and lists enabled instances in the delegation pool", async () => {
    await using _screen = await setup();
    await expect
      .element(page.getByRole("switch", { name: "Multi-provider delegation" }))
      .toBeChecked();
    await expect.element(page.getByText("Delegation pool")).toBeVisible();
    await expect.element(page.getByRole("checkbox", { name: /Claude main/ })).toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: /Claude pro/ })).toBeChecked();
    expect(document.body.textContent).not.toContain("Cursor");
    expect(
      document.querySelector('[aria-label="Reset multi-provider delegation to default"]'),
    ).toBeNull();
  });

  it("turns off, hides the pool, and resets back on", async () => {
    await using _screen = await setup();
    await userEvent.click(page.getByRole("switch", { name: "Multi-provider delegation" }));
    expect(state.updateSettings).toHaveBeenCalledWith({ mattrMultiProviderDelegation: false });
    await expect.element(page.getByText("Delegation pool")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("switch", { name: "Balance by usage pace" }))
      .not.toBeInTheDocument();

    await userEvent.click(
      page.getByRole("button", { name: "Reset multi-provider delegation to default" }),
    );
    expect(state.updateSettings).toHaveBeenLastCalledWith({ mattrMultiProviderDelegation: true });
    await expect.element(page.getByText("Delegation pool")).toBeVisible();
  });

  it("balances by usage pace by default and can turn it off", async () => {
    await using _screen = await setup();
    const pace = page.getByRole("switch", { name: "Balance by usage pace" });
    await expect.element(pace).toBeChecked();
    await userEvent.click(pace);
    expect(state.updateSettings).toHaveBeenCalledWith({ mattrDelegationBalanceByPace: false });
    await expect.element(pace).not.toBeChecked();

    await userEvent.click(
      page.getByRole("button", { name: "Reset balance by usage pace to default" }),
    );
    expect(state.updateSettings).toHaveBeenLastCalledWith({ mattrDelegationBalanceByPace: true });
    await expect.element(pace).toBeChecked();
  });

  it("excludes an unchecked account from delegation", async () => {
    await using _screen = await setup();
    await userEvent.click(page.getByRole("checkbox", { name: /Claude pro/ }));
    expect(state.updateSettings).toHaveBeenCalledWith({
      mattrDelegationExcludedInstanceIds: ["claude-alt-2"],
    });
    await expect.element(page.getByRole("checkbox", { name: /Claude pro/ })).not.toBeChecked();
  });
});
