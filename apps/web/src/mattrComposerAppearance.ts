import * as Schema from "effect/Schema";

import {
  hexToOklch,
  normalizeShellColor,
  oklchToHex,
  type ShellScheme,
} from "../../../antimatter/shellTint";
import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
  writeLocalStorageValue,
} from "./hooks/useLocalStorage";

export const MATTR_COMPOSER_APPEARANCE_STORAGE_KEY = "mattr:composer-appearance:v1";

export const MATTR_COMPOSER_MATERIALS = ["solid", "frosted", "glass", "tinted", "minimal"] as const;
export type MattrComposerMaterial = (typeof MATTR_COMPOSER_MATERIALS)[number];

export const MATTR_COMPOSER_SHAPES = ["shelf", "floating", "compact", "pill"] as const;
export type MattrComposerShape = (typeof MATTR_COMPOSER_SHAPES)[number];

/** `null` is the theme's own composer; `"shell"` follows the Shell color; else a `#rrggbb` seed. */
export type MattrComposerColor = null | "shell" | string;

export interface MattrComposerAppearance {
  readonly scrollFade: boolean;
  readonly material: MattrComposerMaterial;
  readonly shape: MattrComposerShape;
  readonly transparency: number;
  readonly blur: number;
  readonly color: MattrComposerColor;
}

export const MIN_COMPOSER_TRANSPARENCY = 0;
export const MAX_COMPOSER_TRANSPARENCY = 85;
export const MIN_COMPOSER_BLUR = 0;
export const MAX_COMPOSER_BLUR = 40;
/** Tinted has no blur slider; a light fixed frost keeps chat text behind it from fighting the prompt. */
const TINTED_BLUR = 16;
/** A card on a shelf paints this share of the shelf's opacity, so the pair reads as the setting. */
const CARD_LIFT = 0.5;

export const DEFAULT_MATTR_COMPOSER_APPEARANCE: MattrComposerAppearance = {
  scrollFade: true,
  material: "solid",
  shape: "shelf",
  transparency: 40,
  blur: 20,
  color: null,
};

const TRANSLUCENT_MATERIALS: ReadonlySet<MattrComposerMaterial> = new Set([
  "frosted",
  "glass",
  "tinted",
]);
const BLURRED_MATERIALS: ReadonlySet<MattrComposerMaterial> = new Set(["frosted", "glass"]);

export function composerMaterialIsTranslucent(material: MattrComposerMaterial): boolean {
  return TRANSLUCENT_MATERIALS.has(material);
}

export function composerMaterialHasBlurControl(material: MattrComposerMaterial): boolean {
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
export function normalizeMattrComposerAppearance(value: unknown): MattrComposerAppearance {
  const input =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const defaults = DEFAULT_MATTR_COMPOSER_APPEARANCE;
  const color =
    input.color === "shell"
      ? "shell"
      : typeof input.color === "string"
        ? normalizeShellColor(input.color)
        : null;
  return {
    scrollFade: typeof input.scrollFade === "boolean" ? input.scrollFade : defaults.scrollFade,
    material: oneOf(MATTR_COMPOSER_MATERIALS, input.material, defaults.material),
    shape: oneOf(MATTR_COMPOSER_SHAPES, input.shape, defaults.shape),
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

export type MattrComposerTintStrength = keyof typeof TINT_WINDOWS;

/** The card color for `color` under `scheme`, clamped so composer text stays readable. */
export function adaptComposerTint(
  color: string,
  scheme: ShellScheme,
  strength: MattrComposerTintStrength,
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
export function effectiveComposerColor(appearance: MattrComposerAppearance): MattrComposerColor {
  if (appearance.material === "minimal") return null;
  if (appearance.material === "tinted" && appearance.color === null) return "shell";
  return appearance.color;
}

export function composerBlurRadius(appearance: MattrComposerAppearance): number {
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
 * Root attributes and variables read by antimatter/composer-appearance.css. Defaults leave no
 * attribute behind, and the backdrop blur attribute only appears when a blur is actually painted,
 * so Solid and Minimal never create a backdrop layer.
 */
export function applyMattrComposerAppearance(
  root: HTMLElement,
  appearance: MattrComposerAppearance,
): void {
  const { dataset, style } = root;
  if (appearance.scrollFade) delete dataset.mattrScrollFade;
  else dataset.mattrScrollFade = "off";

  if (appearance.material === "solid") delete dataset.mattrComposerMaterial;
  else dataset.mattrComposerMaterial = appearance.material;

  if (appearance.shape === "shelf") delete dataset.mattrComposerShape;
  else dataset.mattrComposerShape = appearance.shape;

  for (const name of CSS_VARS) style.removeProperty(name);
  delete dataset.mattrComposerBlur;
  delete dataset.mattrComposerTint;

  if (composerMaterialIsTranslucent(appearance.material)) {
    style.setProperty("--mca-opacity", `${100 - appearance.transparency}%`);
    style.setProperty(
      "--mca-card-lift",
      `${Math.round((100 - appearance.transparency) * CARD_LIFT)}%`,
    );
    const blur = composerBlurRadius(appearance);
    if (blur > 0) {
      dataset.mattrComposerBlur = "on";
      style.setProperty("--mca-blur", `${blur}px`);
    }
  }

  const color = effectiveComposerColor(appearance);
  if (color === "shell") {
    dataset.mattrComposerTint = "shell";
  } else if (color !== null) {
    const strength = appearance.material === "tinted" ? "rich" : "subtle";
    dataset.mattrComposerTint = "custom";
    style.setProperty("--mca-tint-light", adaptComposerTint(color, "light", strength));
    style.setProperty("--mca-tint-dark", adaptComposerTint(color, "dark", strength));
  }
}

const StoredAppearance = Schema.Unknown;

export function readMattrComposerAppearance(): MattrComposerAppearance {
  return normalizeMattrComposerAppearance(
    readLocalStorageValue(MATTR_COMPOSER_APPEARANCE_STORAGE_KEY, null, StoredAppearance),
  );
}

export function writeMattrComposerAppearance(patch: Partial<MattrComposerAppearance>): void {
  writeLocalStorageValue<unknown, unknown>(
    MATTR_COMPOSER_APPEARANCE_STORAGE_KEY,
    (current: unknown) =>
      normalizeMattrComposerAppearance({ ...normalizeMattrComposerAppearance(current), ...patch }),
    null,
    StoredAppearance,
  );
}

/** Applies the saved appearance before the first render and follows changes from any window. */
export function startMattrComposerAppearance(
  root: HTMLElement = document.documentElement,
): () => void {
  applyMattrComposerAppearance(root, readMattrComposerAppearance());
  return subscribeLocalStorageKey(MATTR_COMPOSER_APPEARANCE_STORAGE_KEY, () =>
    applyMattrComposerAppearance(root, readMattrComposerAppearance()),
  );
}

export function useMattrComposerAppearance(): readonly [
  MattrComposerAppearance,
  (patch: Partial<MattrComposerAppearance>) => void,
] {
  const [stored] = useLocalStorage<unknown, unknown>(
    MATTR_COMPOSER_APPEARANCE_STORAGE_KEY,
    null,
    StoredAppearance,
  );
  return [normalizeMattrComposerAppearance(stored), writeMattrComposerAppearance];
}
