import type { IslandDisplayMetrics } from "./types.ts";

// Fits the 420pt Open card plus its 18pt ears and the hover bloom, with room for the drop zones.
export const ISLAND_WINDOW_WIDTH = 520;
export const ISLAND_WINDOW_HEIGHT = 560;
/** How far below the screen top a drag counts as "near the notch". */
export const ISLAND_DROP_CATCH_HEIGHT = 140;
// Wider than both 14"/16" MacBook Pro (~185pt) and 13"/15" MacBook Air (~192pt) camera housings
// so left/right pill wings never clip beneath the physical notch.
export const NOTCHED_DISPLAY_NOTCH_WIDTH = 200;
export const STANDARD_DISPLAY_NOTCH_WIDTH = 168;

export interface DisplayGeometryInput {
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly workArea: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface ComputedIslandPlacement {
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly metrics: IslandDisplayMetrics;
}

export function computeIslandPlacement(
  display: DisplayGeometryInput,
  isMac: boolean,
): ComputedIslandPlacement {
  const { x, y, width } = display.bounds;
  const topInset = Math.max(0, display.workArea.y - display.bounds.y);
  // Notched MacBooks have a 37-38pt menu bar while the physical camera notch sits at 32pt.
  const hasNotch = isMac && topInset >= 30;
  const notchHeight = hasNotch ? Math.min(32, Math.max(30, topInset - 5)) : 34;
  const notchWidth = hasNotch ? NOTCHED_DISPLAY_NOTCH_WIDTH : STANDARD_DISPLAY_NOTCH_WIDTH;
  return {
    bounds: {
      x: Math.round(x + (width - ISLAND_WINDOW_WIDTH) / 2),
      // Anchor flush to the physical screen top edge, never display.workArea.y.
      y,
      width: ISLAND_WINDOW_WIDTH,
      height: ISLAND_WINDOW_HEIGHT,
    },
    metrics: {
      hasNotch,
      notchWidth,
      notchHeight,
      windowWidth: ISLAND_WINDOW_WIDTH,
    },
  };
}
