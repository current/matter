import { type ClientSettings, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import {
  DEFAULT_MATTER_COMPOSER_APPEARANCE,
  MATTER_COMPOSER_APPEARANCE_STORAGE_KEY,
  readMatterComposerAppearance,
  startMatterComposerAppearance,
  writeMatterComposerAppearance,
} from "../../matterComposerAppearance";

const state = vi.hoisted(() => ({ settings: {} as Partial<ClientSettings> }));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ ...DEFAULT_UNIFIED_SETTINGS, ...state.settings })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ id, control, resetAction, children }) => (
    <div data-testid={id}>
      {control}
      {resetAction}
      {children}
    </div>
  ),
}));

import { MatterComposerAppearanceSettings } from "./MatterComposerAppearanceSettings";

const root = document.documentElement;

async function renderSettings(settings: Partial<ClientSettings> = {}) {
  state.settings = settings;
  const stop = startMatterComposerAppearance(root);
  const screen = await render(<MatterComposerAppearanceSettings />, { router: false });
  return {
    screen,
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
      stop();
      writeMatterComposerAppearance(DEFAULT_MATTER_COMPOSER_APPEARANCE);
      localStorage.removeItem(MATTER_COMPOSER_APPEARANCE_STORAGE_KEY);
    },
  };
}

const row = (id: string) => document.querySelector(`[data-testid="${id}"]`);

describe("MatterComposerAppearanceSettings", () => {
  it("toggles the scroll edge fade and resets it", async () => {
    await using _settings = await renderSettings();
    const toggle = page.getByRole("switch", { name: "Scroll edge fade" });
    await expect.element(toggle).toBeChecked();
    expect(
      page.getByRole("button", { name: "Reset scroll edge fade to default" }).query(),
    ).toBeNull();

    await userEvent.click(toggle);
    await expect.element(toggle).not.toBeChecked();
    expect(readMatterComposerAppearance().scrollFade).toBe(false);
    expect(root.dataset.matterScrollFade).toBe("off");

    await userEvent.click(page.getByRole("button", { name: "Reset scroll edge fade to default" }));
    await expect.element(toggle).toBeChecked();
    expect(root.dataset.matterScrollFade).toBeUndefined();
  });

  it("shows only the rows that apply to Solid, with a live preview", async () => {
    await using _settings = await renderSettings();
    await expect
      .element(page.getByRole("combobox", { name: "Composer material" }))
      .toHaveTextContent("Solid");
    await expect
      .element(page.getByRole("combobox", { name: "Composer style" }))
      .toHaveTextContent("Shelf");
    expect(row("setting-matter-composer-transparency")).toBeNull();
    expect(row("setting-matter-composer-blur")).toBeNull();
    await expect.element(page.getByRole("group", { name: "Composer color" })).toBeVisible();
    expect(
      document.querySelector("[data-matter-composer-preview] [data-matter-composer]"),
    ).not.toBeNull();
  });

  it("picks Frosted and saves each slider to the root", async () => {
    await using _settings = await renderSettings();
    await userEvent.click(page.getByRole("combobox", { name: "Composer material" }));
    await userEvent.click(page.getByRole("option", { name: "Frosted" }));
    expect(readMatterComposerAppearance().material).toBe("frosted");
    expect(root.dataset.matterComposerMaterial).toBe("frosted");

    const transparency = page.getByRole("slider", { name: "Composer transparency" });
    const blur = page.getByRole("slider", { name: "Composer blur" });
    await expect.element(transparency).toHaveValue("40");
    await expect.element(blur).toHaveValue("20");
    await userEvent.fill(transparency, "60");
    await userEvent.fill(blur, "32");
    expect(readMatterComposerAppearance()).toMatchObject({ transparency: 60, blur: 32 });
    expect(root.style.getPropertyValue("--mca-opacity")).toBe("40%");
    expect(root.style.getPropertyValue("--mca-blur")).toBe("32px");

    await userEvent.click(page.getByRole("button", { name: "Reset composer material to default" }));
    expect(root.dataset.matterComposerMaterial).toBeUndefined();
    expect(root.dataset.matterComposerBlur).toBeUndefined();
    expect(row("setting-matter-composer-blur")).toBeNull();
  });

  it("shows transparency but no blur for Tinted, deduplicates Match shell, and hides color for Minimal", async () => {
    writeMatterComposerAppearance({ material: "tinted" });
    await using _settings = await renderSettings({ shellColor: "#7d4e85" });
    await expect.element(page.getByRole("slider", { name: "Composer transparency" })).toBeVisible();
    expect(row("setting-matter-composer-blur")).toBeNull();
    const defaultTinted = page.getByRole("button", { name: "Default (match shell)" });
    await expect.element(defaultTinted).toHaveAttribute("aria-pressed", "true");
    await expect.element(defaultTinted).toHaveStyle({ backgroundColor: "rgb(125, 78, 133)" });
    expect(page.getByRole("button", { name: "Match shell", exact: true }).query()).toBeNull();
    expect(
      page.getByRole("button", { name: "Reset composer color to default" }).query(),
    ).toBeNull();

    // Carrying an earlier "shell" pick into Tinted still treats Match shell as the default.
    writeMatterComposerAppearance({ material: "tinted", color: "shell" });
    await expect.element(defaultTinted).toHaveAttribute("aria-pressed", "true");
    expect(
      page.getByRole("button", { name: "Reset composer color to default" }).query(),
    ).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Ocean Slate" }));
    await expect
      .element(page.getByRole("button", { name: "Reset composer color to default" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Reset composer color to default" }));
    expect(readMatterComposerAppearance().color).toBeNull();

    writeMatterComposerAppearance({ material: "minimal" });
    await expect.poll(() => row("matter-composer-color")).toBeNull();
    expect(row("setting-matter-composer-transparency")).toBeNull();
  });

  it("picks a style", async () => {
    await using _settings = await renderSettings();
    await userEvent.click(page.getByRole("combobox", { name: "Composer style" }));
    await userEvent.click(page.getByRole("option", { name: "Pill" }));
    expect(readMatterComposerAppearance().shape).toBe("pill");
    expect(root.dataset.matterComposerShape).toBe("pill");
    await userEvent.click(page.getByRole("button", { name: "Reset composer style to default" }));
    expect(root.dataset.matterComposerShape).toBeUndefined();
  });

  it("picks preset, shell and custom colors", async () => {
    await using _settings = await renderSettings({ shellColor: "#7d4e85" });
    await userEvent.click(page.getByRole("button", { name: "Ocean Slate" }));
    expect(readMatterComposerAppearance().color).toBe("#3f6e8c");
    expect(root.dataset.matterComposerTint).toBe("custom");
    await expect
      .element(page.getByRole("button", { name: "Ocean Slate" }))
      .toHaveAttribute("aria-pressed", "true");

    await userEvent.click(page.getByRole("button", { name: "Match shell" }));
    expect(readMatterComposerAppearance().color).toBe("shell");
    expect(root.dataset.matterComposerTint).toBe("shell");

    await userEvent.fill(page.getByLabelText("Custom color", { exact: true }), "#123456");
    expect(readMatterComposerAppearance().color).toBe("#123456");
    await expect.element(page.getByLabelText("Custom color (selected)")).toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Reset composer color to default" }));
    expect(readMatterComposerAppearance().color).toBeNull();
    expect(root.dataset.matterComposerTint).toBeUndefined();
  });
});
