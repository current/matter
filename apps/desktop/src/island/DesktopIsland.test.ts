import { describe, expect, it } from "vite-plus/test";
import { buildIslandHtml } from "../../../../antimatter/island/islandHtml.ts";
import { islandModelRuntime } from "../../../../antimatter/island/islandModel.ts";
import {
  ISLAND_DROP_ARM_HEIGHT,
  ISLAND_DROP_CATCH_HEIGHT,
  ISLAND_WINDOW_HEIGHT,
  ISLAND_WINDOW_WIDTH,
  computeIslandPlacement,
} from "../../../../antimatter/island/islandPlacement.ts";
import { shouldKeepIslandWindowAlive } from "../../../../antimatter/island/islandVisibility.ts";
import {
  MODIFIER_POLLER_SCRIPT,
  MODIFIER_TAP_MAX_SECONDS,
  parseModifierMonitorLine,
  type MacMonitorEvent,
} from "../../../../antimatter/island/MacControlTapMonitor.ts";
import {
  INITIAL_MODIFIER_ROUTING,
  buildIslandWindowOptions,
  createIslandMonitorController,
  isIslandRendererAction,
  isNearDropCatch,
  routeModifierEvent,
  type ModifierRoutingState,
  type ModifierTarget,
} from "./DesktopIsland.ts";
import { makeIslandSnapshot, makeIslandThread } from "./islandTestFixtures.ts";
import {
  SIRI_FLUID_DOTS_FRAG,
  SIRI_WAVE_FRAG,
  SIRI_WAVE_VERT,
  siriWaveStretch,
} from "../../../../antimatter/island/siriWaveShaders.ts";
import type { MacModifierEvent } from "../../../../antimatter/island/MacControlTapMonitor.ts";

function islandScript(): string {
  const match = buildIslandHtml().match(/<script>([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe("Matter Island document", () => {
  it("is a self-contained page whose script parses and embeds the Siri wave shaders", () => {
    const html = buildIslandHtml();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Matter Island</title>");
    expect(html).toContain("mainImage");
    expect(html).toContain("spectral4");
    expect(SIRI_WAVE_VERT).toContain("gl_Position");
    expect(SIRI_WAVE_FRAG).toContain("max(c.r, max(c.g, c.b))");
    expect(SIRI_FLUID_DOTS_FRAG).toContain("max(c.r, max(c.g, c.b))");
    expect(() => new Function(islandScript())).not.toThrow();
  });

  it("embeds a model runtime that works on its own, with no outside references", () => {
    const standalone = new Function(`return (${islandModelRuntime.toString()})();`)() as ReturnType<
      typeof islandModelRuntime
    >;
    const snapshot = makeIslandSnapshot({
      recentThreads: [makeIslandThread({ key: "env:a", status: "running", providerKind: "codex" })],
    });
    expect(standalone.deriveWing(snapshot, 0).kind).toBe("running");
    expect(
      standalone.chooseOpenCard({
        dropActive: true,
        needsYouCount: 1,
        hasDraft: true,
        wantsPrompt: true,
        glanceCount: 1,
      }),
    ).toBe("drop");
  });

  it("moves on spring-sampled linear() easings and never loops an animation", () => {
    const html = buildIslandHtml();
    expect(html).toMatch(/--island-ease-expand: linear\(0, [^)]*, 1\);/);
    expect(html).toMatch(/--island-ease-collapse: linear\(/);
    expect(html).toContain("var(--island-ease-hover)");
    expect(html).not.toMatch(/animation:[^;]*infinite/);
    expect(html).not.toMatch(/animation-iteration-count:\s*infinite/);
    // Reduced motion zeroes every spring duration.
    expect(html).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*:root \{ --island-dur-expand: 0ms;/,
    );
  });

  it("draws a pure black notch with no rim, glow or shadow", () => {
    const html = buildIslandHtml();
    expect(html).toContain("background: #000;");
    expect(html).not.toMatch(/box-shadow/);
    expect(html).not.toMatch(/drop-shadow/);
    expect(html).not.toContain("stroke-width: 1.5px; stroke: rgba");
  });
});

describe("Siri wave", () => {
  it("matches the state-to-stretch curve", () => {
    expect(siriWaveStretch("idle", 0.9)).toBe(0.45);
    expect(siriWaveStretch("thinking", 0.9)).toBe(1);
    expect(siriWaveStretch("listening", 0)).toBeCloseTo(0.55);
    expect(siriWaveStretch("listening", 2)).toBeCloseTo(1.45);
  });
});

describe("computeIslandPlacement & buildIslandWindowOptions", () => {
  it("anchors the window flush to display.bounds.y (never workArea.y) and clears the hardware notch", () => {
    const macBookPro14 = {
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 37, width: 1512, height: 878 },
    };
    const placement = computeIslandPlacement(macBookPro14, true);
    expect(placement.bounds).toEqual({
      x: Math.round((1512 - ISLAND_WINDOW_WIDTH) / 2),
      y: 0,
      width: ISLAND_WINDOW_WIDTH,
      height: ISLAND_WINDOW_HEIGHT,
    });
    expect(placement.metrics.hasNotch).toBe(true);
    expect(placement.metrics.notchWidth).toBeGreaterThanOrEqual(200);
    expect(placement.metrics.notchHeight).toBe(32);
    // Open (420pt) plus its 18pt ears and the hover bloom fit the window.
    expect(ISLAND_WINDOW_WIDTH).toBeGreaterThanOrEqual(420 * 1.06 + 36);
  });

  it("anchors external displays to display.bounds.y without notch ears", () => {
    const placement = computeIslandPlacement(
      {
        bounds: { x: 1512, y: -120, width: 2560, height: 1440 },
        workArea: { x: 1512, y: -95, width: 2560, height: 1415 },
      },
      true,
    );
    expect(placement.bounds.x).toBe(1512 + Math.round((2560 - ISLAND_WINDOW_WIDTH) / 2));
    expect(placement.bounds.y).toBe(-120);
    expect(placement.metrics.hasNotch).toBe(false);
  });

  it("is a non-activating macOS panel that answers first clicks", () => {
    const bounds = { x: 496, y: 0, width: ISLAND_WINDOW_WIDTH, height: ISLAND_WINDOW_HEIGHT };
    const mac = buildIslandWindowOptions(bounds, "/tmp/island-preload.cjs", true);
    expect(mac.type).toBe("panel");
    expect(mac.acceptFirstMouse).toBe(true);
    expect(mac.enableLargerThanScreen).toBe(true);
    expect(mac.hiddenInMissionControl).toBe(true);
    expect(mac.transparent).toBe(true);
    expect(mac.hasShadow).toBe(false);
    expect(buildIslandWindowOptions(bounds, "/tmp/p.cjs", false).type).toBeUndefined();
  });

  it("arms drop zones only at the notch, then keeps the drag over the zones' card", () => {
    const bounds = { x: 496, y: 0, width: ISLAND_WINDOW_WIDTH };
    const center = 496 + ISLAND_WINDOW_WIDTH / 2;
    // A drag across a browser's tab strip or toolbar below the menu bar never arms.
    expect(isNearDropCatch({ x: center, y: 10 }, bounds, 200, false)).toBe(true);
    expect(isNearDropCatch({ x: center, y: ISLAND_DROP_ARM_HEIGHT + 20 }, bounds, 200, false)).toBe(
      false,
    );
    expect(isNearDropCatch({ x: center + 200, y: 10 }, bounds, 200, false)).toBe(false);
    // Armed, the cursor can move down onto the zones.
    expect(isNearDropCatch({ x: center + 200, y: 100 }, bounds, 200, true)).toBe(true);
    expect(isNearDropCatch({ x: center, y: ISLAND_DROP_CATCH_HEIGHT + 1 }, bounds, 200, true)).toBe(
      false,
    );
    // Measured against the window's own display, not the one under the cursor.
    expect(isNearDropCatch({ x: center + 1512, y: 10 }, bounds, 200, false)).toBe(false);
  });
});

describe("shouldKeepIslandWindowAlive", () => {
  it("stays docked on notched displays and hides when disabled", () => {
    const snapshot = makeIslandSnapshot();
    expect(shouldKeepIslandWindowAlive(snapshot, false, true, 0)).toBe(true);
    expect(shouldKeepIslandWindowAlive(null, true, true, 0)).toBe(false);
    expect(
      shouldKeepIslandWindowAlive(
        makeIslandSnapshot({ settings: { ...snapshot.settings, enabled: false } }),
        true,
        true,
        0,
      ),
    ).toBe(false);
  });

  it("shows on other displays only while there is something to show, focused or not", () => {
    const idle = makeIslandSnapshot();
    expect(shouldKeepIslandWindowAlive(idle, false, false, 0)).toBe(false);
    expect(shouldKeepIslandWindowAlive(idle, true, false, 0)).toBe(true);
    for (const mainWindowFocused of [true, false]) {
      const running = makeIslandSnapshot({
        mainWindowFocused,
        recentThreads: [makeIslandThread({ key: "env:a", status: "running" })],
      });
      expect(shouldKeepIslandWindowAlive(running, false, false, 0)).toBe(true);
    }
    const finished = makeIslandSnapshot({
      doneNotifications: [
        {
          key: "env:a",
          environmentId: "env",
          threadId: "a",
          threadTitle: "A",
          completedAt: 1000,
          outcome: "completed",
        },
      ],
    });
    expect(shouldKeepIslandWindowAlive(finished, false, false, 1000)).toBe(true);
    expect(shouldKeepIslandWindowAlive(finished, false, false, 5000)).toBe(false);
  });
});

describe("modifier routing", () => {
  const run = (
    steps: ReadonlyArray<readonly [MacModifierEvent, ModifierTarget, number]>,
    initial: ModifierRoutingState = INITIAL_MODIFIER_ROUTING,
  ) => {
    let state = initial;
    const out: unknown[] = [];
    for (const [event, focused, now] of steps) {
      const routed = routeModifierEvent(state, event, focused, now);
      state = routed.state;
      out.push(...routed.events);
    }
    return { state, out };
  };

  it("parses the poller's modifier and drag lines only", () => {
    expect(parseModifierMonitorLine(" hold-start\r")).toBe("hold-start");
    expect(parseModifierMonitorLine("drag-start")).toBe("drag-start");
    expect(parseModifierMonitorLine("drag-end")).toBe("drag-end");
    expect(parseModifierMonitorLine("ready")).toBeNull();
    expect(parseModifierMonitorLine("tapped")).toBeNull();
  });

  it("opens on a double tap from any app and ignores a lone or slow tap", () => {
    const tap = (now: number) =>
      [
        ["hold-start", "none", now],
        ["hold-cancel", "none", now + 80],
        ["tap", "none", now + 80],
      ] as const;
    expect(run([...tap(0), ...tap(300)]).out).toEqual([{ kind: "toggle" }]);
    expect(run([...tap(0)]).out).toEqual([]);
    expect(run([...tap(0), ...tap(900)]).out).toEqual([]);
    // A third tap starts a new pair rather than toggling twice.
    expect(run([...tap(0), ...tap(200), ...tap(400)]).out).toEqual([{ kind: "toggle" }]);
  });

  it("dictates a hold into the composer focused when it started, through its release", () => {
    expect(
      run([
        ["hold-start", "main", 0],
        ["hold-end", "island", 600],
      ]).out,
    ).toEqual([
      { kind: "hold", target: "main", phase: "start" },
      { kind: "hold", target: "main", phase: "end" },
    ]);
    expect(
      run([
        ["hold-start", "island", 0],
        ["hold-cancel", "main", 50],
      ]).out,
    ).toEqual([
      { kind: "hold", target: "island", phase: "start" },
      { kind: "hold", target: "island", phase: "cancel" },
    ]);
    expect(
      run([
        ["hold-start", "none", 0],
        ["hold-end", "main", 600],
      ]).out,
    ).toEqual([]);
  });

  it("drops a pending tap once a real hold ends, so tap-then-hold never toggles", () => {
    const { out } = run([
      ["hold-start", "none", 0],
      ["hold-cancel", "none", 80],
      ["tap", "none", 80],
      ["hold-start", "none", 150],
      ["hold-end", "none", 500],
      ["hold-start", "none", 520],
      ["hold-cancel", "none", 560],
      ["tap", "none", 560],
    ]);
    expect(out).toEqual([]);
  });

  it("emits hold-start at 0ms, cancels quick taps (<=220ms) into tap, ends real holds (>220ms), and cancels chords", () => {
    const CTRL = 0x40000;
    const SHIFT = 0x20000;
    const ALL = 0x20000 | 0x40000 | 0x80000 | 0x100000;

    type Frame = {
      readonly nowMs: number;
      readonly flags: number;
      readonly sinceKey?: number;
      readonly sinceClick?: number;
      readonly mouse?: number;
      readonly dragCount?: number;
    };

    const runPoller = (frames: ReadonlyArray<Frame>, mask = CTRL): MacMonitorEvent[] => {
      let index = 0;
      const logs: string[] = [];
      const fake$ = {
        NSApplication: {
          sharedApplication: { setActivationPolicy: () => {} },
        },
        NSApplicationActivationPolicyProhibited: 2,
        NSPasteboardNameDrag: "drag",
        NSPasteboard: {
          pasteboardWithName: () => ({
            get changeCount() {
              return frames[Math.min(index, frames.length - 1)]!.dragCount ?? 0;
            },
          }),
        },
        NSEvent: {
          get pressedMouseButtons() {
            return frames[index]!.mouse ?? 0;
          },
        },
        getppid: () => (index < frames.length ? 42 : 1),
        CGEventSourceFlagsState: () => frames[index]!.flags,
        CGEventSourceSecondsSinceLastEventType: (_stateId: number, eventType: number) => {
          const frame = frames[index]!;
          return eventType === 10 ? (frame.sinceKey ?? 10) : (frame.sinceClick ?? 10);
        },
      };
      const fakeDate = { now: () => frames[index]!.nowMs };
      const fakeConsole = { log: (msg: string) => logs.push(msg) };
      const runFn = new Function(
        "ObjC",
        "$",
        "Date",
        "console",
        "delay",
        `${MODIFIER_POLLER_SCRIPT}\nreturn run;`,
      )({ import: () => {} }, fake$, fakeDate, fakeConsole, () => {
        index += 1;
      }) as (argv: string[]) => string;
      runFn([String(mask), String(ALL)]);
      expect(logs[0]).toBe("ready");
      return logs
        .slice(1)
        .map(parseModifierMonitorLine)
        .filter((event): event is MacMonitorEvent => event !== null);
    };

    expect(MODIFIER_TAP_MAX_SECONDS).toBe(0.22);

    // 1. Clean keydown emits hold-start immediately (0ms), and a quick tap (100ms <= 220ms) emits hold-cancel then tap.
    expect(
      runPoller([
        { nowMs: 1000, flags: CTRL },
        { nowMs: 1040, flags: CTRL },
        { nowMs: 1100, flags: 0 },
      ]),
    ).toEqual(["hold-start", "hold-cancel", "tap"]);

    // 2. Real dictation hold (300ms > 220ms) emits hold-start at t=0ms then hold-end on release.
    expect(
      runPoller([
        { nowMs: 1000, flags: CTRL },
        { nowMs: 1150, flags: CTRL },
        { nowMs: 1300, flags: 0 },
      ]),
    ).toEqual(["hold-start", "hold-end"]);

    // 3. Ctrl+C (key pressed while held) cancels immediately and never taps or ends.
    expect(
      runPoller([
        { nowMs: 1000, flags: CTRL },
        { nowMs: 1060, flags: CTRL, sinceKey: 0.01 },
        { nowMs: 1120, flags: 0, sinceKey: 0.07 },
      ]),
    ).toEqual(["hold-start", "hold-cancel"]);

    // 4. Ctrl+Click (mouse click while held) cancels immediately.
    expect(
      runPoller([
        { nowMs: 1000, flags: CTRL },
        { nowMs: 1080, flags: CTRL, sinceClick: 0.02 },
        { nowMs: 1140, flags: 0, sinceClick: 0.08 },
      ]),
    ).toEqual(["hold-start", "hold-cancel"]);

    // 5. Shift+Ctrl (another modifier already down on keydown) never starts a hold or tap.
    expect(
      runPoller([
        { nowMs: 1000, flags: CTRL | SHIFT },
        { nowMs: 1100, flags: SHIFT },
      ]),
    ).toEqual([]);

    // 6. Sub-15ms bounce cancels hold without firing a tap.
    expect(
      runPoller([
        { nowMs: 1000, flags: CTRL },
        { nowMs: 1010, flags: 0 },
      ]),
    ).toEqual(["hold-start", "hold-cancel"]);

    // 7. A drag from any app: the drag pasteboard changes while the button is down, until release.
    expect(
      runPoller(
        [
          { nowMs: 1000, flags: 0, mouse: 1, dragCount: 4 },
          { nowMs: 1020, flags: 0, mouse: 1, dragCount: 5 },
          { nowMs: 1040, flags: 0, mouse: 1, dragCount: 5 },
          { nowMs: 1060, flags: 0, mouse: 0, dragCount: 5 },
        ],
        0,
      ),
    ).toEqual(["drag-start", "drag-end"]);

    // 8. A plain click (pasteboard untouched) is not a drag.
    expect(
      runPoller(
        [
          { nowMs: 1000, flags: 0, mouse: 1, dragCount: 4 },
          { nowMs: 1020, flags: 0, mouse: 0, dragCount: 4 },
        ],
        0,
      ),
    ).toEqual([]);
  });
});

describe("modifier poller", () => {
  function harness() {
    const starts: Array<{
      readonly resolve: (stop: () => void) => void;
      readonly reject: (error: Error) => void;
      readonly fail: (error: Error) => void;
    }> = [];
    const stopped: number[] = [];
    const timers: Array<{
      readonly run: () => void;
      readonly delayMs: number;
      cancelled: boolean;
    }> = [];
    let clock = 0;
    const controller = createIslandMonitorController({
      start: (_modifier, _onEvent, onFailure) =>
        new Promise((resolve, reject) => {
          starts.push({ resolve, reject, fail: onFailure });
        }),
      onEvent: () => undefined,
      schedule: (run, delayMs) => {
        const timer = { run, delayMs, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      now: () => clock,
    });
    const ready = async (index: number) => {
      starts[index]!.resolve(() => stopped.push(index));
      await Promise.resolve();
    };
    return {
      controller,
      starts,
      stopped,
      timers,
      ready,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("stops a poller that finishes starting after a newer settings change", async () => {
    const h = harness();
    h.controller.start("control");
    // A second slider step lands before the first poller printed "ready".
    h.controller.start("control");
    expect(h.starts).toHaveLength(2);
    await h.ready(0);
    expect(h.stopped).toEqual([0]);
    await h.ready(1);
    expect(h.stopped).toEqual([0]);
    h.controller.stop();
    expect(h.stopped).toEqual([0, 1]);
  });

  it("restarts a crashed poller with growing backoff, never after stop", async () => {
    const h = harness();
    h.controller.start("option");
    await h.ready(0);
    h.starts[0]!.fail(new Error("exited"));
    expect(h.timers.map((timer) => timer.delayMs)).toEqual([1000]);
    h.timers[0]!.run();
    expect(h.starts).toHaveLength(2);
    h.starts[1]!.reject(new Error("exited before ready"));
    await Promise.resolve();
    expect(h.timers.map((timer) => timer.delayMs)).toEqual([1000, 2000]);
    h.controller.stop();
    expect(h.timers[1]!.cancelled).toBe(true);
    h.timers[1]!.run();
    expect(h.starts).toHaveLength(2);
  });
});

describe("island actions", () => {
  it("forwards only the actions the island renderer may send to the main window", () => {
    expect(isIslandRendererAction({ type: "respond-approval" })).toBe(true);
    expect(isIslandRendererAction({ type: "submit-capture" })).toBe(true);
    expect(isIslandRendererAction({ type: "composer-dictation-hold", phase: "start" })).toBe(false);
    expect(isIslandRendererAction({ type: "close-panel" })).toBe(false);
    expect(isIslandRendererAction(null)).toBe(false);
    expect(isIslandRendererAction({ type: 1 })).toBe(false);
  });
});
