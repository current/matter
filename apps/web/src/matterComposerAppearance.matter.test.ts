import { describe, expect, it } from "vite-plus/test";

import { relativeLuminance, SHELL_COLOR_PRESETS } from "../../../matter/shellTint";
import {
  adaptComposerTint,
  composerBlurRadius,
  DEFAULT_MATTER_COMPOSER_APPEARANCE,
  effectiveComposerColor,
  MATTER_COMPOSER_APPEARANCE_STORAGE_KEY,
  type MatterComposerAppearance,
  normalizeMatterComposerAppearance,
  readMatterComposerAppearance,
  writeMatterComposerAppearance,
} from "./matterComposerAppearance";

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

const appearance = (patch: Partial<MatterComposerAppearance>): MatterComposerAppearance => ({
  ...DEFAULT_MATTER_COMPOSER_APPEARANCE,
  ...patch,
});

// composer.css ink tokens per scheme: prompt text and the tray/icon gray.
const INK = {
  light: { text: "#3a3b40", tray: "#7c7e85" },
  dark: { text: "#d6d6d6", tray: "#9e9e9e" },
} as const;

describe("normalizeMatterComposerAppearance", () => {
  it("fills a missing or malformed value with the defaults", () => {
    expect(normalizeMatterComposerAppearance(null)).toEqual(DEFAULT_MATTER_COMPOSER_APPEARANCE);
    expect(normalizeMatterComposerAppearance("glass")).toEqual(DEFAULT_MATTER_COMPOSER_APPEARANCE);
    expect(
      normalizeMatterComposerAppearance({
        scrollEdge: "glow",
        material: "chrome",
        shape: 3,
        transparency: "50",
        blur: Number.NaN,
        color: 12,
      }),
    ).toEqual(DEFAULT_MATTER_COMPOSER_APPEARANCE);
  });

  it("keeps valid fields from a partial value", () => {
    expect(normalizeMatterComposerAppearance({ material: "glass", scrollEdge: "frost" })).toEqual(
      appearance({ material: "glass", scrollEdge: "frost" }),
    );
  });

  it("carries the old scroll fade switch over", () => {
    expect(normalizeMatterComposerAppearance({ scrollFade: false }).scrollEdge).toBe("off");
    expect(normalizeMatterComposerAppearance({ scrollFade: true }).scrollEdge).toBe("fade");
    expect(
      normalizeMatterComposerAppearance({ scrollFade: false, scrollEdge: "blur" }).scrollEdge,
    ).toBe("blur");
    expect(normalizeMatterComposerAppearance({ scrollFade: false })).not.toHaveProperty(
      "scrollFade",
    );
  });

  it("clamps and rounds the sliders into range", () => {
    const clamped = normalizeMatterComposerAppearance({ transparency: 140, blur: -3 });
    expect(clamped.transparency).toBe(85);
    expect(clamped.blur).toBe(0);
    expect(normalizeMatterComposerAppearance({ transparency: 42.6, blur: 17.2 })).toMatchObject({
      transparency: 43,
      blur: 17,
    });
  });

  it("accepts shell, normalizes hex seeds and drops anything else", () => {
    expect(normalizeMatterComposerAppearance({ color: "shell" }).color).toBe("shell");
    expect(normalizeMatterComposerAppearance({ color: "#ABC" }).color).toBe("#aabbcc");
    expect(normalizeMatterComposerAppearance({ color: " 3F6E8C " }).color).toBe("#3f6e8c");
    expect(normalizeMatterComposerAppearance({ color: "red" }).color).toBeNull();
  });
});

describe("composer tint", () => {
  const seeds = [
    ...SHELL_COLOR_PRESETS.map((preset) => preset.color),
    "#ffffff",
    "#000000",
    "#ff00ff",
  ];

  it.each(["subtle", "rich"] as const)("keeps %s tints readable in both schemes", (strength) => {
    for (const seed of seeds) {
      const light = adaptComposerTint(seed, "light", strength);
      const dark = adaptComposerTint(seed, "dark", strength);
      expect(contrast(INK.light.text, light), `${seed} light text`).toBeGreaterThanOrEqual(7);
      expect(contrast(INK.light.tray, light), `${seed} light tray`).toBeGreaterThanOrEqual(3);
      expect(contrast(INK.dark.text, dark), `${seed} dark text`).toBeGreaterThanOrEqual(7);
      expect(contrast(INK.dark.tray, dark), `${seed} dark tray`).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives Tinted more color than a subtle tint", () => {
    const seed = "#c0673f";
    const chroma = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
    };
    expect(chroma(adaptComposerTint(seed, "light", "rich"))).toBeGreaterThan(
      chroma(adaptComposerTint(seed, "light", "subtle")),
    );
  });

  it("follows the shell for Tinted without a color and ignores color for Minimal", () => {
    expect(effectiveComposerColor(appearance({ material: "tinted" }))).toBe("shell");
    expect(effectiveComposerColor(appearance({ material: "tinted", color: "#4b4fa8" }))).toBe(
      "#4b4fa8",
    );
    expect(effectiveComposerColor(appearance({ material: "solid" }))).toBeNull();
    expect(
      effectiveComposerColor(appearance({ material: "minimal", color: "#4b4fa8" })),
    ).toBeNull();
  });
});

describe("composerBlurRadius", () => {
  it("only blurs translucent materials", () => {
    expect(composerBlurRadius(appearance({ material: "solid", blur: 30 }))).toBe(0);
    expect(composerBlurRadius(appearance({ material: "minimal", blur: 30 }))).toBe(0);
    expect(composerBlurRadius(appearance({ material: "frosted", blur: 30 }))).toBe(30);
    expect(composerBlurRadius(appearance({ material: "glass", blur: 0 }))).toBe(0);
    expect(composerBlurRadius(appearance({ material: "tinted", transparency: 20 }))).toBe(16);
    expect(composerBlurRadius(appearance({ material: "tinted", transparency: 0 }))).toBe(0);
  });
});

describe("composer appearance storage", () => {
  it("merges patches into the stored appearance", () => {
    expect(readMatterComposerAppearance()).toEqual(DEFAULT_MATTER_COMPOSER_APPEARANCE);
    writeMatterComposerAppearance({ material: "frosted" });
    writeMatterComposerAppearance({ transparency: 999, scrollEdge: "shadow" });
    expect(readMatterComposerAppearance()).toEqual(
      appearance({ material: "frosted", transparency: 85, scrollEdge: "shadow" }),
    );
    writeMatterComposerAppearance(DEFAULT_MATTER_COMPOSER_APPEARANCE);
    expect(readMatterComposerAppearance()).toEqual(DEFAULT_MATTER_COMPOSER_APPEARANCE);
    expect(MATTER_COMPOSER_APPEARANCE_STORAGE_KEY).toBe("mattr:composer-appearance:v1");
  });
});
