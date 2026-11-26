import { describe, expect, it } from "vite-plus/test";
import {
  adaptShellColor,
  hexToOklch,
  MAX_SHELL_BLUR_RADIUS,
  normalizeShellColor,
  oklchToHex,
  relativeLuminance,
  SHELL_COLOR_PRESETS,
  shellBlurRadius,
  shellFrameOpacity,
  shellGlassTint,
} from "../../../antimatter/shellTint";

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

const LIGHT_TEXT = "#f1f3f7";
const DARK_TEXT = "#1f1f1f";
const HARD_COLORS = ["#ffffff", "#000000", "#ffff00", "#00ff00", "#ff00ff", "#00ffff", "#ff0000"];

describe("shell tint", () => {
  it("normalizes picker values and rejects anything else", () => {
    expect(normalizeShellColor("#ABCDEF")).toBe("#abcdef");
    expect(normalizeShellColor("abc")).toBe("#aabbcc");
    expect(normalizeShellColor(" #3f6e8c ")).toBe("#3f6e8c");
    expect(normalizeShellColor("red")).toBeNull();
    expect(normalizeShellColor("#12345")).toBeNull();
  });

  it("converts through OKLCH without drifting", () => {
    for (const { color } of SHELL_COLOR_PRESETS) {
      expect(oklchToHex(hexToOklch(color))).toBe(color);
    }
  });

  it("keeps sidebar text legible on every preset and on extreme custom colors", () => {
    for (const color of [...SHELL_COLOR_PRESETS.map((preset) => preset.color), ...HARD_COLORS]) {
      expect(contrast(adaptShellColor(color, "dark"), LIGHT_TEXT)).toBeGreaterThan(7);
      expect(contrast(adaptShellColor(color, "light"), DARK_TEXT)).toBeGreaterThan(7);
    }
  });

  it("keeps the picked hue", () => {
    const seed = hexToOklch("#4b4fa8");
    for (const scheme of ["light", "dark"] as const) {
      const adapted = hexToOklch(adaptShellColor("#4b4fa8", scheme));
      expect(Math.abs(adapted.h - seed.h)).toBeLessThan(6);
      expect(adapted.c).toBeGreaterThan(0.03);
    }
  });

  it("maps transparency from near-opaque to fully clear for every translucent material", () => {
    for (const material of ["transparent", "blur", "liquid-glass"] as const) {
      expect(shellFrameOpacity(material, 0)).toBeCloseTo(0.96);
      expect(shellFrameOpacity(material, 100)).toBe(0);
      expect(shellFrameOpacity(material, 25)).toBeGreaterThan(shellFrameOpacity(material, 75));
    }
    expect(shellFrameOpacity("solid", 100)).toBe(1);
  });

  it("keeps the shipped look at the default 50%", () => {
    expect(shellFrameOpacity("transparent", 50)).toBeCloseTo(0.46, 2);
    expect(shellFrameOpacity("blur", 50)).toBeCloseTo(0.3, 2);
    expect(shellFrameOpacity("liquid-glass", 50)).toBeCloseTo(0.16, 2);
  });

  it("maps blur amount onto the native radius", () => {
    expect(shellBlurRadius(0)).toBe(0);
    expect(shellBlurRadius(60)).toBe(38);
    expect(shellBlurRadius(100)).toBe(MAX_SHELL_BLUR_RADIUS);
    expect(shellBlurRadius(500)).toBe(MAX_SHELL_BLUR_RADIUS);
  });

  it("tints Liquid Glass with the theme-fitted color, lighter as transparency rises", () => {
    expect(shellGlassTint(null, "dark", 50)).toBeNull();
    const opaque = shellGlassTint("#c0673f", "dark", 0);
    const clear = shellGlassTint("#c0673f", "dark", 100);
    expect(opaque?.alpha).toBe(0.5);
    expect(clear?.alpha).toBe(0.15);
    const [r, g, b] = [opaque!.red, opaque!.green, opaque!.blue];
    const hex = `#${[r, g, b]
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
    expect(hex).toBe(adaptShellColor("#c0673f", "dark"));
  });
});
