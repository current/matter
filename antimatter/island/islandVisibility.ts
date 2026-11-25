import type { IslandSnapshot } from "./types.ts";

const ACTIVE_ASSISTANT_PHASES = new Set([
  "listening",
  "transcribing",
  "thinking",
  "acting",
  "speaking",
]);

/** Whether the transparent Island window should stay on screen for this snapshot. */
export function shouldKeepIslandWindowAlive(
  snapshot: IslandSnapshot | null,
  forcedOpen: boolean,
  hasNotch: boolean,
): boolean {
  if (!snapshot || !snapshot.settings.enabled) return false;
  // On notched MacBooks the overlay stays docked invisibly inside the camera cutout so
  // hover-to-peek and spring transitions run on frame 1 with zero flash.
  if (hasNotch) return true;
  if (forcedOpen) return true;
  if (snapshot.voice.phase !== "idle") return true;
  if (snapshot.assistant?.handsFreeActive) return true;
  if (snapshot.assistant && ACTIVE_ASSISTANT_PHASES.has(snapshot.assistant.phase)) return true;
  if (!snapshot.settings.showNotifications) return false;
  return (
    snapshot.pendingApprovals.length > 0 ||
    snapshot.pendingUserInputs.length > 0 ||
    snapshot.doneNotifications.length > 0 ||
    snapshot.recentThreads.some(
      (thread) =>
        thread.status === "running" || thread.status === "approval" || thread.status === "input",
    )
  );
}
