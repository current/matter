import "./index.css";

import { describe, expect, it } from "vite-plus/test";
import shellCss from "../../../matter/shell.css?inline";
import { render } from "../test/render";
import { ComposerSurface } from "./components/chat/ComposerSurface";
import {
  adaptComposerTint,
  applyMatterComposerAppearance,
  DEFAULT_MATTER_COMPOSER_APPEARANCE,
  MATTER_COMPOSER_APPEARANCE_STORAGE_KEY,
  type MatterComposerAppearance,
  startMatterComposerAppearance,
  writeMatterComposerAppearance,
} from "./matterComposerAppearance";

const root = document.documentElement;

function apply(patch: Partial<MatterComposerAppearance>) {
  applyMatterComposerAppearance(root, { ...DEFAULT_MATTER_COMPOSER_APPEARANCE, ...patch });
}

function shellStyles(): Disposable {
  const style = document.createElement("style");
  style.textContent = shellCss;
  document.head.append(style);
  return {
    [Symbol.dispose]() {
      style.remove();
      apply({});
      root.classList.remove("dark");
      delete root.dataset.themeId;
      root.style.removeProperty("--app-theme-sidebar");
      localStorage.removeItem(MATTER_COMPOSER_APPEARANCE_STORAGE_KEY);
    },
  };
}

function Composer({
  contextRow,
  attachedBanner = false,
}: {
  contextRow: boolean;
  attachedBanner?: boolean;
}) {
  return (
    <div style={{ width: 640 }}>
      <div className="topbar-scroll-fade h-20 overflow-y-auto" data-testid="scroller">
        <div className="h-60" />
      </div>
      <ComposerSurface.Shell data-matter-composer="" contextRow={contextRow}>
        <ComposerSurface.Host>
          {attachedBanner ? <div data-composer-banner-surface="attached">banner</div> : null}
          <ComposerSurface.Main>
            <div data-chat-composer-surface="true">
              <div data-chat-composer-body="true">prompt</div>
              <div data-chat-composer-footer="true" />
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
        {contextRow ? <ComposerSurface.ContextStrip>tray</ComposerSurface.ContextStrip> : null}
      </ComposerSurface.Shell>
    </div>
  );
}

const shell = () => document.querySelector<HTMLElement>("[data-matter-composer]")!;
const host = () => document.querySelector<HTMLElement>('[data-slot="composer-host"]')!;
const main = () => document.querySelector<HTMLElement>("[data-chat-composer-main-surface]")!;
const contextStrip = () =>
  document.querySelector<HTMLElement>('[data-slot="composer-context-strip"]')!;
const scroller = () => document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
const css = (element: Element, pseudo?: string) => getComputedStyle(element, pseudo);
/** The backdrop filter actually painted: a hidden pseudo-element keeps upstream's value but no layer. */
const backdrop = (element: Element, pseudo?: string) => {
  const style = css(element, pseudo);
  if (style.display === "none") return "none";
  return style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter");
};
const mask = (element: Element) => {
  const style = css(element);
  return style.maskImage || style.getPropertyValue("-webkit-mask-image");
};

describe("applyMatterComposerAppearance", () => {
  it("leaves no attribute or variable behind for the defaults", () => {
    apply({ material: "glass", shape: "pill", scrollFade: false, color: "#4b4fa8" });
    apply({});
    for (const name of [
      "matterScrollFade",
      "matterComposerMaterial",
      "matterComposerShape",
      "matterComposerBlur",
      "matterComposerTint",
    ]) {
      expect(root.dataset[name], name).toBeUndefined();
    }
    for (const name of [
      "--mca-opacity",
      "--mca-card-lift",
      "--mca-blur",
      "--mca-tint-light",
      "--mca-tint-dark",
    ]) {
      expect(root.style.getPropertyValue(name), name).toBe("");
    }
  });

  it("writes the material, shape, blur and fitted tints", () => {
    apply({ material: "frosted", shape: "compact", transparency: 40, blur: 24, color: "#c0673f" });
    expect(root.dataset.matterComposerMaterial).toBe("frosted");
    expect(root.dataset.matterComposerShape).toBe("compact");
    expect(root.dataset.matterComposerBlur).toBe("on");
    expect(root.style.getPropertyValue("--mca-opacity")).toBe("60%");
    expect(root.style.getPropertyValue("--mca-card-lift")).toBe("30%");
    expect(root.style.getPropertyValue("--mca-blur")).toBe("24px");
    expect(root.dataset.matterComposerTint).toBe("custom");
    expect(root.style.getPropertyValue("--mca-tint-light")).toBe(
      adaptComposerTint("#c0673f", "light", "subtle"),
    );
    expect(root.style.getPropertyValue("--mca-tint-dark")).toBe(
      adaptComposerTint("#c0673f", "dark", "subtle"),
    );
    apply({});
  });

  it("never marks a blur for Solid or Minimal", () => {
    apply({ material: "minimal", blur: 40, color: "#c0673f" });
    expect(root.dataset.matterComposerBlur).toBeUndefined();
    expect(root.dataset.matterComposerTint).toBeUndefined();
    expect(root.style.getPropertyValue("--mca-opacity")).toBe("");
    apply({ material: "solid", blur: 40 });
    expect(root.dataset.matterComposerBlur).toBeUndefined();
    apply({});
  });

  it("follows storage writes from the start call", () => {
    using _styles = shellStyles();
    const stop = startMatterComposerAppearance(root);
    try {
      expect(root.dataset.matterScrollFade).toBeUndefined();
      writeMatterComposerAppearance({ scrollFade: false, material: "tinted" });
      expect(root.dataset.matterScrollFade).toBe("off");
      expect(root.dataset.matterComposerMaterial).toBe("tinted");
      expect(root.dataset.matterComposerTint).toBe("shell");
    } finally {
      stop();
    }
  });
});

describe("composer appearance CSS", () => {
  it("turns the top scroll fade off without moving anything", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    expect(mask(scroller())).toContain("linear-gradient");
    const before = scroller().getBoundingClientRect();
    apply({ scrollFade: false });
    expect(mask(scroller())).toBe("none");
    expect(scroller().getBoundingClientRect()).toEqual(before);
  });

  it("keeps Solid opaque with no backdrop layer", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    expect(css(shell()).backgroundColor).toBe("rgb(243, 243, 245)");
    expect(css(host()).backgroundColor).toBe("rgb(255, 255, 255)");
    expect(backdrop(shell())).toBe("none");
    expect(backdrop(shell(), "::before")).toBe("none");
    expect(backdrop(host())).toBe("none");
  });

  it("frosts the whole shelf once through a pseudo-element", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    apply({ material: "frosted", transparency: 30, blur: 20 });
    expect(backdrop(shell())).toBe("none");
    expect(backdrop(shell(), "::before")).toContain("blur(20px)");
    expect(css(shell()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    // The shelf clears its own border so ::before's inset shadow draws the 1px rim once.
    expect(css(shell()).borderTopColor).toBe("rgba(0, 0, 0, 0)");
    // The card adds half the shelf's opacity as a lift instead of stacking a second 70%.
    expect(css(host()).backgroundColor).toMatch(/0\.35\)$/);
    expect(backdrop(host(), "::before")).toBe("none");
  });

  it("blurs Floating translucent once on the card without wrapping the under-tray", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    apply({ material: "frosted", shape: "floating", transparency: 30, blur: 20 });
    expect(css(shell()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(backdrop(shell(), "::before")).toBe("none");
    expect(css(host()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(backdrop(host(), "::before")).toContain("blur(20px)");
    expect(css(host(), "::before").backgroundColor).toMatch(/0\.7\)$/);
    expect(css(host(), "::before").borderTopLeftRadius).toBe("13px");
    expect(css(contextStrip()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    apply({ material: "glass", shape: "floating", blur: 16 });
    expect(backdrop(shell(), "::before")).toBe("none");
    expect(backdrop(host(), "::before")).toMatch(/blur\(16px\) saturate\(1\.4\)/);
    expect(css(shell()).boxShadow).toBe("none");
    expect(css(host()).boxShadow).toContain("inset");
  });

  it("clears upstream backdrop-filter on attached banners and keeps side gutters clean", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow attachedBanner />, { router: false });
    expect(backdrop(main())).toBe("none");
    expect(backdrop(main(), "::before")).toBe("none");
    expect(css(host()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(main()).backgroundColor).toBe("rgb(255, 255, 255)");

    apply({ material: "minimal" });
    expect(backdrop(main())).toBe("none");
    expect(backdrop(main(), "::before")).toBe("none");
    expect(css(host()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(main()).boxShadow).toBe("none");

    apply({ material: "frosted", transparency: 30, blur: 0 });
    expect(backdrop(main())).toBe("none");
    expect(backdrop(main(), "::before")).toBe("none");
    expect(css(host()).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    apply({ material: "frosted", transparency: 30, blur: 20 });
    expect(backdrop(shell(), "::before")).toContain("blur(20px)");
    expect(backdrop(host(), "::before")).toBe("none");
    expect(backdrop(main())).toBe("none");
    expect(backdrop(main(), "::before")).toBe("none");
    expect(css(host()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(main()).backgroundColor).toMatch(/0\.35\)$/);

    apply({ material: "frosted", shape: "floating", transparency: 30, blur: 20 });
    expect(backdrop(shell(), "::before")).toBe("none");
    expect(backdrop(host(), "::before")).toBe("none");
    expect(backdrop(main())).toBe("none");
    expect(backdrop(main(), "::before")).toContain("blur(20px)");
    expect(css(host()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(main()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(main(), "::before").backgroundColor).toMatch(/0\.7\)$/);
  });

  it("moves blur to the main surface for trayless composers with attached banners", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow={false} attachedBanner />, {
      router: false,
    });
    apply({ material: "frosted", transparency: 30, blur: 18 });
    expect(backdrop(host(), "::before")).toBe("none");
    expect(backdrop(main())).toBe("none");
    expect(backdrop(main(), "::before")).toContain("blur(18px)");
    expect(css(host()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(main()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(main(), "::before").backgroundColor).toMatch(/0\.7\)$/);
  });

  it("inherits dark custom theme shell color on Match shell and Tinted", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    root.classList.add("dark");
    apply({ material: "solid", color: "shell" });
    const defaultDark = css(host()).backgroundColor;

    root.dataset.themeId = "custom-dark";
    root.style.setProperty("--app-theme-sidebar", "#1e3a5f");
    const customDark = css(host()).backgroundColor;
    expect(customDark).not.toBe(defaultDark);

    apply({ material: "tinted", transparency: 0 });
    expect(css(host()).backgroundColor).not.toBe(defaultDark);
  });

  it("blurs the card itself when there is no under-tray, and saturates Glass", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow={false} />, { router: false });
    apply({ material: "glass", blur: 12 });
    expect(backdrop(host(), "::before")).toMatch(/blur\(12px\) saturate\(1\.4\)/);
    expect(css(host()).boxShadow).toContain("inset");
  });

  it("swaps the radii for each style", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    expect(css(shell()).borderTopLeftRadius).toBe("17px");
    expect(css(host()).borderTopLeftRadius).toBe("13px");
    apply({ shape: "pill" });
    expect(css(shell()).borderTopLeftRadius).toBe("22px");
    expect(css(host()).borderTopLeftRadius).toBe("18px");
    apply({ shape: "compact" });
    expect(css(shell()).borderTopLeftRadius).toBe("13px");
    expect(css(host()).borderTopLeftRadius).toBe("10px");
    expect(css(shell()).paddingTop).toBe("3px");
    apply({ shape: "floating" });
    expect(css(shell()).paddingTop).toBe("0px");
    expect(css(shell()).borderTopColor).toBe("rgba(0, 0, 0, 0)");
    expect(css(host()).boxShadow).not.toBe("none");
  });

  it("paints a custom tint per scheme and flattens Minimal", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    apply({ color: "#3f6e8c" });
    const lightCard = css(host()).backgroundColor;
    root.classList.add("dark");
    const darkCard = css(host()).backgroundColor;
    expect(lightCard).not.toBe("rgb(255, 255, 255)");
    expect(darkCard).not.toBe(lightCard);
    root.classList.remove("dark");

    apply({ material: "minimal" });
    expect(css(host()).boxShadow).toBe("none");
    expect(css(shell()).borderTopColor).toBe("rgba(0, 0, 0, 0)");
    expect(backdrop(shell(), "::before")).toBe("none");
  });

  it("uses normal type everywhere", async () => {
    using _styles = shellStyles();
    await using _screen = await render(<Composer contextRow />, { router: false });
    apply({ material: "glass", shape: "pill", color: "shell" });
    for (const element of shell().querySelectorAll("*")) {
      expect(css(element).fontStyle).toBe("normal");
    }
  });
});
