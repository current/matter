import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import shellCss from "../../../antimatter/shell.css?inline";
import { adaptShellColor, hexToRgb } from "../../../antimatter/shellTint";
import { applyMattrShellAppearance, type MattrShellAppearance } from "./mattrShellAppearance";

const SIDEBAR = "#f0f1f3";

function rgba(color: string): readonly [number, number, number, number] {
  const parts = (color.match(/[\d.]+/g) ?? []).map(Number);
  // rgb()/rgba() report 0–255 channels; color(srgb …) reports 0–1.
  const scale = color.startsWith("color(") ? 255 : 1;
  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return [Math.round(r * scale), Math.round(g * scale), Math.round(b * scale), a];
}

function hexChannels(hex: string): readonly [number, number, number] {
  return hexToRgb(hex).map((channel) => Math.round(channel * 255)) as [number, number, number];
}

async function mountShell() {
  await page.viewport(1200, 800);
  const root = document.documentElement;
  const style = document.createElement("style");
  style.textContent = shellCss;
  document.head.append(style);
  root.style.setProperty("--sidebar", SIDEBAR);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div data-slot="sidebar-wrapper"><div data-slot="sidebar"><div data-slot="sidebar-container"><div data-slot="sidebar-inner"><div class="mfs">rail</div></div></div></div></div>`,
  );
  const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')!;
  return {
    wrapper,
    inner: document.querySelector<HTMLElement>('[data-slot="sidebar-inner"]')!,
    rail: document.querySelector<HTMLElement>(".mfs")!,
    apply(settings: Partial<MattrShellAppearance>) {
      applyMattrShellAppearance(root, {
        shellMaterial: "solid",
        shellGrain: 0,
        shellTransparency: 50,
        shellColor: null,
        ...settings,
      });
    },
    frame: () => rgba(getComputedStyle(wrapper).backgroundColor),
    [Symbol.dispose]() {
      wrapper.remove();
      style.remove();
      root.classList.remove("dark");
      root.style.removeProperty("--sidebar");
      root.style.removeProperty("--mattr-shell-opacity");
      root.style.removeProperty("--mattr-shell-tint-light");
      root.style.removeProperty("--mattr-shell-tint-dark");
      for (const key of ["mattrShellMaterial", "mattrShellTint", "mattrShellGrain"]) {
        delete root.dataset[key];
      }
    },
  };
}

describe("mattr shell stylesheet", () => {
  it("keeps the sidebar rail and inner container clear so the frame shows through", async () => {
    using shell = await mountShell();
    shell.apply({ shellMaterial: "blur" });
    expect(rgba(getComputedStyle(shell.rail).backgroundColor)[3]).toBe(0);
    expect(rgba(getComputedStyle(shell.inner).backgroundColor)[3]).toBe(0);
    expect(rgba(getComputedStyle(document.body).backgroundColor)[3]).toBe(0);
  });

  it("paints Solid at full opacity in the theme's frame color", async () => {
    using shell = await mountShell();
    shell.apply({ shellMaterial: "solid", shellTransparency: 100 });
    expect(shell.frame()).toEqual([...hexChannels(SIDEBAR), 1]);
  });

  it("follows the transparency slider from near-opaque to fully clear", async () => {
    using shell = await mountShell();
    shell.apply({ shellMaterial: "transparent", shellTransparency: 0 });
    expect(shell.frame()[3]).toBeCloseTo(0.96, 2);
    shell.apply({ shellMaterial: "transparent", shellTransparency: 50 });
    expect(shell.frame()[3]).toBeCloseTo(0.46, 2);
    shell.apply({ shellMaterial: "transparent", shellTransparency: 100 });
    expect(shell.frame()[3]).toBe(0);
    shell.apply({ shellMaterial: "liquid-glass", shellTransparency: 50 });
    expect(shell.frame()[3]).toBeCloseTo(0.16, 2);
  });

  it("tints the frame with the theme-fitted shell color in light and dark", async () => {
    using shell = await mountShell();
    shell.apply({ shellMaterial: "solid", shellColor: "#4b4fa8" });
    expect(shell.frame()).toEqual([...hexChannels(adaptShellColor("#4b4fa8", "light")), 1]);

    document.documentElement.classList.add("dark");
    expect(shell.frame()).toEqual([...hexChannels(adaptShellColor("#4b4fa8", "dark")), 1]);

    shell.apply({ shellMaterial: "blur", shellColor: "#4b4fa8", shellTransparency: 50 });
    const [r, g, b, a] = shell.frame();
    expect([r, g, b]).toEqual(hexChannels(adaptShellColor("#4b4fa8", "dark")));
    expect(a).toBeCloseTo(0.3, 2);
  });
});
