// @effect-diagnostics nodeBuiltinImport:off -- macOS platform boundary spawns the background modifier-tap poller.

import * as NodeChildProcess from "node:child_process";

export type MacSingleTapModifier = "control" | "option";

// CoreGraphics modifier flag masks (CGEventFlags)
const MODIFIER_FLAG_MASK: Record<MacSingleTapModifier, number> = {
  control: 0x40000, // kCGEventFlagMaskControl
  option: 0x80000, // kCGEventFlagMaskAlternate
};

// All standard modifier flags (Shift | Control | Option | Command)
const ALL_MODIFIERS_MASK = 0x20000 | 0x40000 | 0x80000 | 0x100000;

// Polls CGEventSourceFlagsState + CGEventSourceSecondsSinceLastEventType without Accessibility permissions.
// Fires "tap" only when the target modifier is pressed alone, held < 450ms, and released with no other
// keys or mouse clicks occurring in between (so Ctrl+C, Ctrl+Tab, etc. never trigger).
const POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const targetMask = Number(argv[0]);
  const allMask = Number(argv[1]);
  const otherMask = allMask & ~targetMask;
  let held = false;
  let dirty = false;
  let downAt = 0;
  console.log("ready");
  while ($.getppid() !== 1) {
    const flags = $.CGEventSourceFlagsState(1);
    const targetDown = (flags & targetMask) !== 0;
    const otherDown = (flags & otherMask) !== 0;
    const now = Date.now() / 1000;
    if (targetDown) {
      if (!held) {
        held = true;
        dirty = otherDown;
        downAt = now;
      } else if (!dirty) {
        const elapsed = now - downAt;
        const sinceKey = $.CGEventSourceSecondsSinceLastEventType(1, 10);
        const sinceClick = $.CGEventSourceSecondsSinceLastEventType(1, 1);
        if (otherDown || sinceKey < elapsed || sinceClick < elapsed || elapsed > 0.5) {
          dirty = true;
        }
      }
    } else if (held) {
      const elapsed = now - downAt;
      const sinceKey = $.CGEventSourceSecondsSinceLastEventType(1, 10);
      const sinceClick = $.CGEventSourceSecondsSinceLastEventType(1, 1);
      if (!dirty && elapsed >= 0.02 && elapsed <= 0.45 && sinceKey >= elapsed && sinceClick >= elapsed) {
        console.log("tap");
      }
      held = false;
      dirty = false;
    }
    delay(0.025);
  }
  return "orphaned";
}`;

export function startMacSingleTapModifierMonitor(
  modifier: MacSingleTapModifier,
  onTap: () => void,
  onFailure?: (error: Error) => void,
): Promise<() => void> {
  const targetMask = MODIFIER_FLAG_MASK[modifier];
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", POLLER_SCRIPT, String(targetMask), String(ALL_MODIFIERS_MASK)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let buffered = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        poller.kill();
      } catch {}
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure?.(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    poller.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = line.trim();
        if (message === "ready" && !settled) {
          settled = true;
          resolve(stop);
          continue;
        }
        if (message !== "tap" || !settled || stopped) continue;
        try {
          onTap();
        } catch {}
      }
    });

    poller.once("error", (error) => {
      fail(error);
    });
    poller.once("exit", (code) => {
      fail(new Error(`Island modifier monitor exited with code ${code}`));
    });
  });
}
