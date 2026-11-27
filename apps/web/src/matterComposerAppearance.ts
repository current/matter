import * as Schema from "effect/Schema";

import {
  hexToOklch,
  normalizeShellColor,
  oklchToHex,
  type ShellScheme,
} from "../../../matter/shellTint";
import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
  writeLocalStorageValue,
} from "./hooks/useLocalStorage";

export const MATTER_COMPOSER_APPEARANCE_STORAGE_KEY = "mattr:composer-appearance:v1";

export const MATTER_COMPOSER_MATERIALS = [
  "solid",
  "frosted",
  "glass",
  "tinted",
  "minimal",
] as const;
export type MatterComposerMaterial = (typeof MATTER_COMPOSER_MATERIALS)[number];

export const MATTER_COMPOSER_SHAPES = ["shelf", "floating", "compact", "pill"] as const;
export type MatterComposerShape = (typeof MATTER_COMPOSER_SHAPES)[number];

/** How chat and pages meet the top edge as they scroll under it. Fade is upstream's mask. */
export const MATTER_SCROLL_EDGES = ["fade", "shadow", "blur", "frost", "off"] as const;
export type MatterScrollEdge = (typeof MATTER_SCROLL_EDGES)[number];

/** `null` is the theme's own composer; `"shell"` follows the Shell color; else a `#rrggbb` seed. */
export type MatterComposerColor = null | "shell" | string;

export interface MatterComposerAppearance {
  readonly scrollEdge: MatterScrollEdge;
  readonly material: MatterComposerMaterial;
  readonly shape: MatterComposerShape;
  readonly transparency: number;
  readonly blur: number;
  readonly color: MatterComposerColor;
}

export const MIN_COMPOSER_TRANSPARENCY = 0;
export const MAX_COMPOSER_TRANSPARENCY = 85;
export const MIN_COMPOSER_BLUR = 0;
export const MAX_COMPOSER_BLUR = 40;
/** Tinted has no blur slider; a light fixed frost keeps chat text behind it from fighting the prompt. */
const TINTED_BLUR = 16;
/** A card on a shelf paints this share of the shelf's opacity, so the pair reads as the setting. */
const CARD_LIFT = 0.5;

export const DEFAULT_MATTER_COMPOSER_APPEARANCE: MatterComposerAppearance = {
  scrollEdge: "fade",
  material: "solid",
  shape: "shelf",
  transparency: 40,
  blur: 20,
  color: null,
};

const TRANSLUCENT_MATERIALS: ReadonlySet<MatterComposerMaterial> = new Set([
  "frosted",
  "glass",
  "tinted",
]);
const BLURRED_MATERIALS: ReadonlySet<MatterComposerMaterial> = new Set(["frosted", "glass"]);

export function composerMaterialIsTranslucent(material: MatterComposerMaterial): boolean {
  return TRANSLUCENT_MATERIALS.has(material);
}

export function composerMaterialHasBlurControl(material: MatterComposerMaterial): boolean {
  return BLURRED_MATERIALS.has(material);
}

function clampStep(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

/** Any stored value (older, partial, hand-edited) as a complete, in-range appearance. */
export function normalizeMatterComposerAppearance(value: unknown): MatterComposerAppearance {
  const input =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const defaults = DEFAULT_MATTER_COMPOSER_APPEARANCE;
  const color =
    input.color === "shell"
      ? "shell"
      : typeof input.color === "string"
        ? normalizeShellColor(input.color)
        : null;
  return {
    // Older stores kept an on/off `scrollFade`; off carries over.
    scrollEdge: oneOf(
      MATTER_SCROLL_EDGES,
      input.scrollEdge,
      input.scrollFade === false ? "off" : defaults.scrollEdge,
    ),
    material: oneOf(MATTER_COMPOSER_MATERIALS, input.material, defaults.material),
    shape: oneOf(MATTER_COMPOSER_SHAPES, input.shape, defaults.shape),
    transparency: clampStep(
      input.transparency,
      MIN_COMPOSER_TRANSPARENCY,
      MAX_COMPOSER_TRANSPARENCY,
      defaults.transparency,
    ),
    blur: clampStep(input.blur, MIN_COMPOSER_BLUR, MAX_COMPOSER_BLUR, defaults.blur),
    color,
  };
}

// Card lightness/chroma windows per scheme. Subtle tints sit under the theme's own composer ink;
// Tinted allows more color. Both keep ink, placeholder and tray grays at their usual contrast.
const TINT_WINDOWS: Record<
  "subtle" | "rich",
  Record<ShellScheme, { readonly minL: number; readonly maxL: number; readonly maxC: number }>
> = {
  subtle: {
    light: { minL: 0.955, maxL: 0.985, maxC: 0.022 },
    dark: { minL: 0.23, maxL: 0.27, maxC: 0.03 },
  },
  rich: {
    light: { minL: 0.92, maxL: 0.95, maxC: 0.05 },
    dark: { minL: 0.25, maxL: 0.29, maxC: 0.055 },
  },
};

export type MatterComposerTintStrength = keyof typeof TINT_WINDOWS;

/** The card color for `color` under `scheme`, clamped so composer text stays readable. */
export function adaptComposerTint(
  color: string,
  scheme: ShellScheme,
  strength: MatterComposerTintStrength,
): string {
  const window = TINT_WINDOWS[strength][scheme];
  const { l, c, h } = hexToOklch(color);
  return oklchToHex({
    l: Math.min(window.maxL, Math.max(window.minL, l)),
    c: Math.min(c, window.maxC),
    h,
  });
}

/** Tinted with no color of its own follows the Shell color. */
export function effectiveComposerColor(appearance: MatterComposerAppearance): MatterComposerColor {
  if (appearance.material === "minimal") return null;
  if (appearance.material === "tinted" && appearance.color === null) return "shell";
  return appearance.color;
}

export function composerBlurRadius(appearance: MatterComposerAppearance): number {
  if (composerMaterialHasBlurControl(appearance.material)) return appearance.blur;
  if (appearance.material === "tinted" && appearance.transparency > 0) return TINTED_BLUR;
  return 0;
}

const CSS_VARS = [
  "--mca-opacity",
  "--mca-card-lift",
  "--mca-blur",
  "--mca-tint-light",
  "--mca-tint-dark",
] as const;

/**
 * Root attributes and variables read by matter/composer-appearance.css. Defaults leave no
 * attribute behind, and the backdrop blur attribute only appears when a blur is actually painted,
 * so Solid and Minimal never create a backdrop layer.
 */
export function applyMatterComposerAppearance(
  root: HTMLElement,
  appearance: MatterComposerAppearance,
): void {
  const { dataset, style } = root;
  if (appearance.scrollEdge === "fade") delete dataset.matterScrollEdge;
  else dataset.matterScrollEdge = appearance.scrollEdge;

  if (appearance.material === "solid") delete dataset.matterComposerMaterial;
  else dataset.matterComposerMaterial = appearance.material;

  if (appearance.shape === "shelf") delete dataset.matterComposerShape;
  else dataset.matterComposerShape = appearance.shape;

  for (const name of CSS_VARS) style.removeProperty(name);
  delete dataset.matterComposerBlur;
  delete dataset.matterComposerTint;

  if (composerMaterialIsTranslucent(appearance.material)) {
    style.setProperty("--mca-opacity", `${100 - appearance.transparency}%`);
    style.setProperty(
      "--mca-card-lift",
      `${Math.round((100 - appearance.transparency) * CARD_LIFT)}%`,
    );
    const blur = composerBlurRadius(appearance);
    if (blur > 0) {
      dataset.matterComposerBlur = "on";
      style.setProperty("--mca-blur", `${blur}px`);
    }
  }

  const color = effectiveComposerColor(appearance);
  if (color === "shell") {
    dataset.matterComposerTint = "shell";
  } else if (color !== null) {
    const strength = appearance.material === "tinted" ? "rich" : "subtle";
    dataset.matterComposerTint = "custom";
    style.setProperty("--mca-tint-light", adaptComposerTint(color, "light", strength));
    style.setProperty("--mca-tint-dark", adaptComposerTint(color, "dark", strength));
  }
}

const StoredAppearance = Schema.Unknown;

export function readMatterComposerAppearance(): MatterComposerAppearance {
  return normalizeMatterComposerAppearance(
    readLocalStorageValue(MATTER_COMPOSER_APPEARANCE_STORAGE_KEY, null, StoredAppearance),
  );
}

export function writeMatterComposerAppearance(patch: Partial<MatterComposerAppearance>): void {
  writeLocalStorageValue<unknown, unknown>(
    MATTER_COMPOSER_APPEARANCE_STORAGE_KEY,
    (current: unknown) =>
      normalizeMatterComposerAppearance({
        ...normalizeMatterComposerAppearance(current),
        ...patch,
      }),
    null,
    StoredAppearance,
  );
}

/** Applies the saved appearance before the first render and follows changes from any window. */
export function startMatterComposerAppearance(
  root: HTMLElement = document.documentElement,
): () => void {
  applyMatterComposerAppearance(root, readMatterComposerAppearance());
  return subscribeLocalStorageKey(MATTER_COMPOSER_APPEARANCE_STORAGE_KEY, () =>
    applyMatterComposerAppearance(root, readMatterComposerAppearance()),
  );
}

export function useMatterComposerAppearance(): readonly [
  MatterComposerAppearance,
  (patch: Partial<MatterComposerAppearance>) => void,
] {
  const [stored] = useLocalStorage<unknown, unknown>(
    MATTER_COMPOSER_APPEARANCE_STORAGE_KEY,
    null,
    StoredAppearance,
  );
  return [normalizeMatterComposerAppearance(stored), writeMatterComposerAppearance];
}
