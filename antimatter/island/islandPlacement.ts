import type { IslandDisplayMetrics } from "./types.ts";

export const ISLAND_WINDOW_WIDTH = 560;
export const ISLAND_WINDOW_HEIGHT = 600;
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
  // Notched MacBooks reserve 32-38pt at the top edge vs 24-25pt for standard macOS menu bars.
  const hasNotch = isMac && topInset >= 30;
  const notchHeight = hasNotch ? Math.min(40, Math.max(32, topInset)) : 34;
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
