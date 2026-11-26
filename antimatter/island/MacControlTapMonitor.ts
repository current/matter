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

const MODIFIER_EVENTS = ["tap", "hold-start", "hold-end", "hold-cancel"] as const;

export type MacModifierEvent = (typeof MODIFIER_EVENTS)[number];

export function parseModifierMonitorLine(line: string): MacModifierEvent | null {
  const message = line.trim();
  return MODIFIER_EVENTS.find((event) => event === message) ?? null;
}

export const MODIFIER_TAP_MAX_SECONDS = 0.22;
export const MODIFIER_TAP_MIN_SECONDS = 0.015;

// Polls CGEventSourceFlagsState without Accessibility permissions. Clean keydown prints
// "hold-start" at 0ms; another key, modifier, or click prints "hold-cancel". Clean release prints
// "hold-cancel" + "tap" when <= 220ms, or "hold-end" when held longer.
export const MODIFIER_POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const targetMask = Number(argv[0]);
  const allMask = Number(argv[1]);
  const otherMask = allMask & ~targetMask;
  const tapMax = ${MODIFIER_TAP_MAX_SECONDS};
  const tapMin = ${MODIFIER_TAP_MIN_SECONDS};
  let held = false;
  let dirty = false;
  let holding = false;
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
        if (!dirty) {
          holding = true;
          console.log("hold-start");
        }
      } else if (!dirty) {
        const elapsed = now - downAt;
        const sinceKey = $.CGEventSourceSecondsSinceLastEventType(1, 10);
        const sinceClick = $.CGEventSourceSecondsSinceLastEventType(1, 1);
        if (otherDown || sinceKey < elapsed || sinceClick < elapsed) {
          dirty = true;
          if (holding) {
            holding = false;
            console.log("hold-cancel");
          }
        }
      }
    } else if (held) {
      const elapsed = now - downAt;
      const sinceKey = $.CGEventSourceSecondsSinceLastEventType(1, 10);
      const sinceClick = $.CGEventSourceSecondsSinceLastEventType(1, 1);
      const clean = !dirty && sinceKey >= elapsed && sinceClick >= elapsed;
      if (holding) {
        if (clean && elapsed <= tapMax) {
          console.log("hold-cancel");
          if (elapsed >= tapMin) {
            console.log("tap");
          }
        } else {
          console.log(clean ? "hold-end" : "hold-cancel");
        }
      }
      held = false;
      dirty = false;
      holding = false;
    }
    delay(0.02);
  }
  return "orphaned";
}`;

export function startMacSingleTapModifierMonitor(
  modifier: MacSingleTapModifier,
  onEvent: (event: MacModifierEvent) => void,
  onFailure?: (error: Error) => void,
): Promise<() => void> {
  const targetMask = MODIFIER_FLAG_MASK[modifier];
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      MODIFIER_POLLER_SCRIPT,
      String(targetMask),
      String(ALL_MODIFIERS_MASK),
    ],
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
        const event = parseModifierMonitorLine(message);
        if (!event || !settled || stopped) continue;
        try {
          onEvent(event);
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
