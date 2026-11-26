import { islandModel } from "./islandModel.ts";
import type { IslandSnapshot } from "./types.ts";

/** Whether the transparent island window should stay on screen for this snapshot. */
export function shouldKeepIslandWindowAlive(
  snapshot: IslandSnapshot | null,
  forcedOpen: boolean,
  hasNotch: boolean,
  nowMs: number,
): boolean {
  if (!snapshot || !snapshot.settings.enabled) return false;
  // On notched MacBooks the window stays docked inside the camera housing, so hover and the
  // first spring run on frame 1 with nothing to flash.
  if (hasNotch) return true;
  if (forcedOpen) return true;
  return islandModel.deriveWing(snapshot, nowMs).kind !== "idle";
}
