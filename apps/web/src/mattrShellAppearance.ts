import type {
  ShellColor,
  ShellGrain,
  ShellMaterial,
  ShellTransparency,
} from "@t3tools/contracts/settings";
import { adaptShellColor, shellFrameOpacity } from "../../../antimatter/shellTint";

const SHELL_GRAIN_TILE_SIZE = 180;
const SHELL_GRAIN_MAX_OPACITY = 0.12;

export function buildMattrShellGrainDataUrl(grainPercent: number): string {
  if (grainPercent <= 0) return "none";
  const clamped = Math.min(100, Math.max(0, grainPercent));
  const opacity = ((clamped / 100) * SHELL_GRAIN_MAX_OPACITY).toFixed(4);
  const svg =
    `<svg viewBox='0 0 ${SHELL_GRAIN_TILE_SIZE} ${SHELL_GRAIN_TILE_SIZE}' xmlns='http://www.w3.org/2000/svg'>` +
    `<filter id='g'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/>` +
    `<feColorMatrix type='saturate' values='0'/>` +
    `<feComponentTransfer>` +
    `<feFuncR type='linear' slope='1.7' intercept='-0.35'/>` +
    `<feFuncG type='linear' slope='1.7' intercept='-0.35'/>` +
    `<feFuncB type='linear' slope='1.7' intercept='-0.35'/>` +
    `</feComponentTransfer>` +
    `</filter>` +
    `<rect width='100%' height='100%' filter='url(#g)' opacity='${opacity}'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export interface MattrShellAppearance {
  readonly shellMaterial: ShellMaterial;
  readonly shellGrain: ShellGrain;
  readonly shellTransparency: ShellTransparency;
  readonly shellColor: ShellColor;
}

export function applyMattrShellAppearance(root: HTMLElement, settings: MattrShellAppearance): void {
  root.dataset.mattrShellMaterial = settings.shellMaterial;
  root.style.setProperty(
    "--mattr-shell-opacity",
    `${shellFrameOpacity(settings.shellMaterial, settings.shellTransparency) * 100}%`,
  );
  if (settings.shellColor === null) {
    delete root.dataset.mattrShellTint;
    root.style.removeProperty("--mattr-shell-tint-light");
    root.style.removeProperty("--mattr-shell-tint-dark");
  } else {
    root.dataset.mattrShellTint = "on";
    root.style.setProperty(
      "--mattr-shell-tint-light",
      adaptShellColor(settings.shellColor, "light"),
    );
    root.style.setProperty("--mattr-shell-tint-dark", adaptShellColor(settings.shellColor, "dark"));
  }
  if (settings.shellGrain > 0) {
    root.dataset.mattrShellGrain = "on";
    root.style.setProperty("--mattr-shell-grain", buildMattrShellGrainDataUrl(settings.shellGrain));
  } else {
    delete root.dataset.mattrShellGrain;
    root.style.removeProperty("--mattr-shell-grain");
  }
}
