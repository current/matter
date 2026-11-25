import type { ShellGrain, ShellMaterial } from "@t3tools/contracts/settings";

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

export function applyMattrShellAppearance(
  root: HTMLElement,
  settings: {
    readonly shellMaterial: ShellMaterial;
    readonly shellGrain: ShellGrain;
  },
): void {
  root.dataset.mattrShellMaterial = settings.shellMaterial;
  if (settings.shellGrain > 0) {
    root.dataset.mattrShellGrain = "on";
    root.style.setProperty("--mattr-shell-grain", buildMattrShellGrainDataUrl(settings.shellGrain));
  } else {
    delete root.dataset.mattrShellGrain;
    root.style.removeProperty("--mattr-shell-grain");
  }
}
