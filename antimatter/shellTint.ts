// Shell appearance math shared by the web renderer (CSS variables) and the desktop main process
// (native blur radius and Liquid Glass tint), so both sides derive the same frame from one
// setting. Plain literals instead of contract imports: this folder has no package of its own.

export type ShellMaterialName = "solid" | "transparent" | "blur" | "liquid-glass";
export type ShellScheme = "light" | "dark";

export interface ShellColorPreset {
  readonly id: string;
  readonly color: string;
}

/** Arc-style frame colors. Each is a seed: `adaptShellColor` fits it to the active theme. */
export const SHELL_COLOR_PRESETS: readonly ShellColorPreset[] = [
  { id: "graphite", color: "#5b6068" },
  { id: "ocean-slate", color: "#3f6e8c" },
  { id: "deep-indigo", color: "#4b4fa8" },
  { id: "sage-moss", color: "#6b8f5e" },
  { id: "warm-terracotta", color: "#c0673f" },
  { id: "dusk-plum", color: "#7d4e85" },
  { id: "rose-clay", color: "#b86a74" },
  { id: "obsidian-amber", color: "#b5852b" },
];

// Lightness and chroma windows that keep the sidebar's own foreground legible whatever color is
// picked: light themes get a pastel frame under dark text, dark themes a deep one under light text.
const SCHEME_WINDOWS: Record<
  ShellScheme,
  { readonly minL: number; readonly maxL: number; readonly maxC: number }
> = {
  light: { minL: 0.87, maxL: 0.95, maxC: 0.055 },
  dark: { minL: 0.22, maxL: 0.3, maxC: 0.06 },
};

// Frame opacity at the default 50% transparency matches the fixed values each material shipped
// with (46%, 30%, 16%); 0% is near-opaque and 100% fully clear for every material.
const FRAME_OPACITY_AT_ZERO = 0.96;
const FRAME_OPACITY_EXPONENT: Record<Exclude<ShellMaterialName, "solid">, number> = {
  transparent: 1.06,
  blur: 1.68,
  "liquid-glass": 2.58,
};

/** CGSSetWindowBackgroundBlurRadius takes points; 64 is where more radius stops reading as more blur. */
export const MAX_SHELL_BLUR_RADIUS = 64;

export function normalizeShellColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(trimmed);
  return long ? `#${long[1]}` : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  const c = clamp(channel, 0, 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export function hexToRgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((channel) =>
      Math.round(clamp(channel, 0, 1) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

export function oklchToHex({ l: L, c, h }: Oklch): string {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return rgbToHex([
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

/** The frame color for `color` under the given theme, clamped into a legible window. */
export function adaptShellColor(color: string, scheme: ShellScheme): string {
  const window = SCHEME_WINDOWS[scheme];
  const { l, c, h } = hexToOklch(color);
  return oklchToHex({ l: clamp(l, window.minL, window.maxL), c: Math.min(c, window.maxC), h });
}

/** WCAG relative luminance, used by tests to prove the adapted frame keeps text legible. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** How much of the frame color paints over the window material, 0–1. Solid is always opaque. */
export function shellFrameOpacity(material: ShellMaterialName, transparency: number): number {
  if (material === "solid") return 1;
  const clear = clamp(transparency, 0, 100) / 100;
  const opacity = FRAME_OPACITY_AT_ZERO * (1 - clear) ** FRAME_OPACITY_EXPONENT[material];
  return Math.round(opacity * 1000) / 1000;
}

export function shellBlurRadius(blur: number): number {
  return Math.round((clamp(blur, 0, 100) / 100) * MAX_SHELL_BLUR_RADIUS);
}

export interface ShellGlassTint {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

/**
 * NSGlassEffectView.tintColor for the picked color, or null for untinted glass. The glass keeps a
 * hint of the color even when fully transparent; the CSS frame layer carries the rest.
 */
export function shellGlassTint(
  color: string | null,
  scheme: ShellScheme,
  transparency: number,
): ShellGlassTint | null {
  if (color === null) return null;
  const [red, green, blue] = hexToRgb(adaptShellColor(color, scheme));
  const alpha = 0.15 + 0.35 * (1 - clamp(transparency, 0, 100) / 100);
  return { red, green, blue, alpha: Math.round(alpha * 1000) / 1000 };
}
