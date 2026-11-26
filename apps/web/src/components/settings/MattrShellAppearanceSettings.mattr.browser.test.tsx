import { render } from "../../../test/render";
import { type ClientSettings, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: {} as Partial<ClientSettings>,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ ...DEFAULT_UNIFIED_SETTINGS, ...state.settings })) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ id, control, resetAction }) => (
    <div data-testid={id}>
      {control}
      {resetAction}
    </div>
  ),
}));
// The material, transparency, blur and glass rows only render in the desktop app.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
// Blur amount and glass style are macOS-only; CI browsers may run elsewhere.
Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
vi.mock("../sidebar/mattr/MattrSidebarLayoutSetting", () => ({
  MattrSidebarLayoutSetting: () => null,
}));
vi.mock("./MattrUiFontSetting", () => ({ MattrUiFontSetting: () => null }));
vi.mock("./MattrIconPackSetting", () => ({ MattrIconPackSetting: () => null }));

import { MattrShellAppearanceSettings } from "./MattrShellAppearanceSettings";

async function renderSettings(settings: Partial<ClientSettings> = {}) {
  state.settings = settings;
  state.updateSettings.mockReset();
  return render(<MattrShellAppearanceSettings />, { router: false });
}

describe("MattrShellAppearanceSettings", () => {
  it("hides the intensity rows for Solid and shows the color swatches", async () => {
    await using _screen = await renderSettings();
    await expect.element(page.getByRole("group", { name: "Shell color" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Default" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-testid="setting-shell-transparency"]')).toBeNull();
    expect(document.querySelector('[data-testid="setting-shell-blur"]')).toBeNull();
    expect(document.querySelector('[data-testid="shell-glass-style"]')).toBeNull();
  });

  it("shows transparency and blur amount for Blur and saves each slider", async () => {
    await using _screen = await renderSettings({ shellMaterial: "blur" });
    const transparency = page.getByRole("slider", { name: "Shell transparency" });
    const blur = page.getByRole("slider", { name: "Blur amount" });
    await expect.element(transparency).toHaveValue("50");
    await expect.element(blur).toHaveValue("60");

    await userEvent.fill(transparency, "80");
    expect(state.updateSettings).toHaveBeenLastCalledWith({ shellTransparency: 80 });
    await userEvent.fill(blur, "25");
    expect(state.updateSettings).toHaveBeenLastCalledWith({ shellBlur: 25 });
    expect(document.querySelector('[data-testid="shell-glass-style"]')).toBeNull();
  });

  it("shows the glass style for Liquid Glass, without a blur amount", async () => {
    await using _screen = await renderSettings({
      shellMaterial: "liquid-glass",
      shellGlassStyle: "clear",
    });
    await expect
      .element(page.getByRole("combobox", { name: "Glass style" }))
      .toHaveTextContent("Clear");
    await expect.element(page.getByRole("slider", { name: "Shell transparency" })).toBeVisible();
    expect(document.querySelector('[data-testid="setting-shell-blur"]')).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Reset glass style to default" }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({ shellGlassStyle: "regular" });
  });

  it("picks a preset, a custom color, and resets to Default", async () => {
    await using screen = await renderSettings();
    await userEvent.click(page.getByRole("button", { name: "Ocean Slate" }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({ shellColor: "#3f6e8c" });

    const custom = page.getByLabelText("Custom color").element() as HTMLInputElement;
    custom.value = "#AA3355";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({ shellColor: "#aa3355" });

    state.settings = { shellColor: "#aa3355" };
    await screen.rerender(<MattrShellAppearanceSettings />);
    await expect.element(page.getByLabelText("Custom color (selected)")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Default" }))
      .toHaveAttribute("aria-pressed", "false");
    await userEvent.click(page.getByRole("button", { name: "Reset shell color to default" }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({ shellColor: null });
  });

  it("marks the selected preset", async () => {
    await using _screen = await renderSettings({ shellColor: "#7d4e85" });
    await expect
      .element(page.getByRole("button", { name: "Dusk Plum" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByRole("button", { name: "Default" }))
      .toHaveAttribute("aria-pressed", "false");
  });
});
