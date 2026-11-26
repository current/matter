import { describe, expect, it } from "vite-plus/test";
import { buildIslandHtml } from "../../../../antimatter/island/islandHtml.ts";
import {
  ISLAND_WINDOW_HEIGHT,
  ISLAND_WINDOW_WIDTH,
  NOTCHED_DISPLAY_NOTCH_WIDTH,
  computeIslandPlacement,
} from "../../../../antimatter/island/islandPlacement.ts";
import { shouldKeepIslandWindowAlive } from "../../../../antimatter/island/islandVisibility.ts";
import {
  MODIFIER_POLLER_SCRIPT,
  MODIFIER_TAP_MAX_SECONDS,
  parseModifierMonitorLine,
  type MacModifierEvent,
} from "../../../../antimatter/island/MacControlTapMonitor.ts";
import { buildIslandWindowOptions, resolveModifierEvent } from "./DesktopIsland.ts";
import {
  DEFAULT_ISLAND_SETTINGS,
  type IslandSnapshot,
  type IslandThreadSummary,
} from "../../../../antimatter/island/types.ts";
import {
  SIRI_FLUID_DOTS_FRAG,
  SIRI_WAVE_FRAG,
  SIRI_WAVE_VERT,
  siriWaveStretch,
} from "../../../../antimatter/island/siriWaveShaders.ts";

describe("mattr Island HTML & Lilt Siri Wave shaders", () => {
  it("embeds the 1:1 Lilt Siri Wave GLSL shaders in the self-contained Island HTML", () => {
    const html = buildIslandHtml();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("mattr Island");
    expect(html).toContain("siri-wave-canvas");
    expect(html).toContain("mainImage");
    expect(html).toContain("spectral4");
    expect(html).toContain("GATHER_PERIOD");
    expect(SIRI_WAVE_VERT).toContain("gl_Position");
    expect(SIRI_WAVE_FRAG).toContain("max(c.r, max(c.g, c.b))");
    expect(SIRI_FLUID_DOTS_FRAG).toContain("max(c.r, max(c.g, c.b))");
  });

  it("renders the concave-ear NotchShape SVG, coupled spring physics, and valid embedded JS", () => {
    const html = buildIslandHtml();
    expect(html).toContain('id="island-svg"');
    expect(html).toContain('id="island-shape-path"');
    expect(html).toContain('id="island-rim-path"');
    expect(html).toContain('id="notch-clip"');
    expect(html).toContain('id="island-clip-path"');
    expect(html).toContain("buildNotchShapePath");
    expect(html).toContain("buildCapsulePath");
    expect(html).toContain("stepSpring");
    expect(html).toContain("configureSpring");
    expect(html).toContain("onDisplayMetrics");
    expect(html).toContain("notifyAnimationIdle");
    expect(html).toContain("prefers-reduced-motion");

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => new Function(scriptMatch![1]!)).not.toThrow();
  });

  it("uses WWDC-style asymmetric springs, blur-scale morphs and attention rims", () => {
    const html = buildIslandHtml();
    expect(html).toContain("w: [0.34, 0.78, 0]");
    expect(html).toContain("h: [0.4, 0.74, 25]");
    expect(html).toContain("w: [0.28, 0.88, 18]");
    expect(html).toContain("w: nW + 10, h: nH + 5");
    expect(html).toContain("@keyframes island-morph-in");
    expect(html).toContain("filter: blur(10px); transform: scale(0.94) translateY(-6px)");
    expect(html).toContain("filter: blur(8px); transform: scale(0.93) translateY(-4px)");
    expect(html).toContain("transform: scale(0.95)");
    expect(html).toContain("rgba(251, 146, 60, 0.42)");
    expect(html).toContain("rgba(52, 211, 153, 0.34)");
    // No looping animations: everything that moves at rest is one-shot.
    expect(html).not.toMatch(/animation:[^;]*infinite/);
  });

  it("renders the agent switcher, attention carousel and done review states", () => {
    const html = buildIslandHtml();
    for (const marker of [
      "renderAgentsCard",
      "renderAttention",
      "renderDoneCard",
      "attention-next",
      "agents-prev",
      "select-agent",
      "dismiss-done-item",
      "data-since",
      "trackAttention",
    ]) {
      expect(html).toContain(marker);
    }
  });

  it("keeps live activity pills visible while mattr is focused and flanks the physical camera notch", () => {
    const html = buildIslandHtml();
    // Passive pill rendering must NOT suppress when mattr's main window is focused.
    const resolveMatch = html.match(/function resolveEffectiveView\(\) \{[\s\S]*?\n  \}/);
    expect(resolveMatch).not.toBeNull();
    expect(resolveMatch![0]).not.toContain("snapshot.mainWindowFocused");

    // Compact notched pill places status on left/right wings flanking the center notch cutout.
    expect(html).toContain("grid-template-columns:1fr ${notchW}px 1fr");
    expect(html).toContain('<div class="pill-wing left">');
    expect(html).toContain('<div class="notch-cutout"></div>');
    expect(html).toContain('<div class="pill-wing right">');
    expect(html).toContain(`notchWidth: ${NOTCHED_DISPLAY_NOTCH_WIDTH}`);
  });

  it("matches Lilt's state-to-stretch curve for Siri Wave", () => {
    expect(siriWaveStretch("idle", 0.9)).toBe(0.45);
    expect(siriWaveStretch("error", 0.9)).toBe(0.45);
    expect(siriWaveStretch("thinking", 0.9)).toBe(1);
    expect(siriWaveStretch("listening", 0)).toBeCloseTo(0.55);
    expect(siriWaveStretch("listening", 1)).toBeCloseTo(1.45);
    expect(siriWaveStretch("listening", 2)).toBeCloseTo(1.45);
  });
});

function makeThread(status: IslandThreadSummary["status"]): IslandThreadSummary {
  return {
    key: "env:thread",
    environmentId: "env",
    threadId: "thread",
    title: "Thread",
    projectTitle: null,
    status,
    updatedAt: "2026-11-25T00:00:00.000Z",
    latestUserMessage: null,
    latestAssistantMessage: null,
    toolCallCount: 0,
    isStreaming: false,
    providerInstanceId: "claudeAgent",
    model: "claude-opus-5-5",
    branch: null,
    runStartedAt: "2026-11-25T00:00:00.000Z",
    runCompletedAt: null,
    currentActivity: null,
    recentActivities: [],
    plan: null,
  };
}

function makeSnapshot(overrides: Partial<IslandSnapshot> = {}): IslandSnapshot {
  return {
    theme: "dark",
    mainWindowFocused: false,
    settings: DEFAULT_ISLAND_SETTINGS,
    doneNotifications: [],
    pendingApprovals: [],
    pendingUserInputs: [],
    recentThreads: [],
    selectedThreadKey: null,
    voice: {
      phase: "idle",
      level: 0,
      previewCommitted: "",
      previewTentative: "",
      draftText: "",
      error: null,
      available: true,
    },
    assistant: {
      mode: "smart",
      phase: "idle",
      handsFreeActive: false,
      muted: false,
      speaking: false,
      outputLevel: 0,
      liveTranscript: "",
      statusLabel: null,
      lastReply: null,
      lastToolResults: [],
      recentTurns: [],
      activeBriefingLabel: null,
      pendingBriefingCount: 0,
      error: null,
    },
    ...overrides,
  };
}

describe("computeIslandPlacement & buildIslandWindowOptions", () => {
  it("anchors the window flush to display.bounds.y (never workArea.y) and clears the hardware notch", () => {
    const macBookPro14 = {
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 34, width: 1512, height: 881 },
    };
    const placement = computeIslandPlacement(macBookPro14, true);
    expect(placement.bounds).toEqual({
      x: Math.round((1512 - ISLAND_WINDOW_WIDTH) / 2),
      y: 0,
      width: ISLAND_WINDOW_WIDTH,
      height: ISLAND_WINDOW_HEIGHT,
    });
    expect(placement.bounds.y).not.toBe(macBookPro14.workArea.y);
    expect(placement.metrics.hasNotch).toBe(true);
    // Must exceed physical 185-192pt MacBook Pro/Air camera notch width so wings never overlap it.
    expect(placement.metrics.notchWidth).toBeGreaterThanOrEqual(200);
    expect(placement.metrics.notchHeight).toBe(34);
  });

  it("anchors external and secondary displays to display.bounds.y without notch ears", () => {
    const externalDisplay = {
      bounds: { x: 1512, y: -120, width: 2560, height: 1440 },
      workArea: { x: 1512, y: -95, width: 2560, height: 1415 },
    };
    const placement = computeIslandPlacement(externalDisplay, true);
    expect(placement.bounds.x).toBe(1512 + Math.round((2560 - ISLAND_WINDOW_WIDTH) / 2));
    expect(placement.bounds.y).toBe(-120);
    expect(placement.bounds.y).not.toBe(externalDisplay.workArea.y);
    expect(placement.metrics.hasNotch).toBe(false);
  });

  it("configures macOS panel options so AppKit never clamps the window below the menu bar", () => {
    const bounds = { x: 476, y: 0, width: ISLAND_WINDOW_WIDTH, height: ISLAND_WINDOW_HEIGHT };
    const macOptions = buildIslandWindowOptions(bounds, "/tmp/island-preload.cjs", true);
    expect(macOptions.y).toBe(0);
    expect(macOptions.enableLargerThanScreen).toBe(true);
    expect(macOptions.type).toBe("panel");
    expect(macOptions.roundedCorners).toBe(false);
    expect(macOptions.hiddenInMissionControl).toBe(true);
    expect(macOptions.frame).toBe(false);
    expect(macOptions.transparent).toBe(true);
    expect(macOptions.hasShadow).toBe(false);
  });
});

describe("shouldKeepIslandWindowAlive", () => {
  it("stays docked on notched displays and hides when disabled", () => {
    expect(shouldKeepIslandWindowAlive(makeSnapshot(), false, true)).toBe(true);
    expect(
      shouldKeepIslandWindowAlive(
        makeSnapshot({ settings: { ...DEFAULT_ISLAND_SETTINGS, enabled: false } }),
        true,
        true,
      ),
    ).toBe(false);
  });

  it("keeps the Island visible for active agents whether mattr is focused or in the background", () => {
    const running = makeSnapshot({ recentThreads: [makeThread("running")] });
    expect(shouldKeepIslandWindowAlive(running, false, false)).toBe(true);
    expect(shouldKeepIslandWindowAlive({ ...running, mainWindowFocused: true }, false, false)).toBe(
      true,
    );
    expect(shouldKeepIslandWindowAlive({ ...running, mainWindowFocused: true }, false, true)).toBe(
      true,
    );
    expect(
      shouldKeepIslandWindowAlive(
        makeSnapshot({
          mainWindowFocused: true,
          doneNotifications: [
            {
              key: "env:thread",
              environmentId: "env",
              threadId: "thread",
              threadTitle: "Done thread",
              completedAt: 1_700_000_000_000,
            },
          ],
        }),
        false,
        false,
      ),
    ).toBe(true);
    expect(
      shouldKeepIslandWindowAlive(
        makeSnapshot({ recentThreads: [makeThread("idle")] }),
        false,
        false,
      ),
    ).toBe(false);
    expect(
      shouldKeepIslandWindowAlive(
        makeSnapshot({
          mainWindowFocused: true,
          recentThreads: [makeThread("running")],
          settings: { ...DEFAULT_ISLAND_SETTINGS, showNotifications: false },
        }),
        false,
        false,
      ),
    ).toBe(false);
  });
});

describe("modifier tap and hold events", () => {
  it("parses only the poller's event lines", () => {
    expect(parseModifierMonitorLine("tap")).toBe("tap");
    expect(parseModifierMonitorLine(" hold-start\r")).toBe("hold-start");
    expect(parseModifierMonitorLine("hold-end")).toBe("hold-end");
    expect(parseModifierMonitorLine("hold-cancel")).toBe("hold-cancel");
    expect(parseModifierMonitorLine("ready")).toBeNull();
    expect(parseModifierMonitorLine("tapped")).toBeNull();
    expect(parseModifierMonitorLine("")).toBeNull();
  });

  it("keeps taps opening the Island whatever window has focus", () => {
    expect(resolveModifierEvent("tap", false, false)).toEqual({ kind: "tap" });
    expect(resolveModifierEvent("tap", false, true)).toEqual({ kind: "tap" });
  });

  it("dictates a hold only when it starts over the focused main window", () => {
    expect(resolveModifierEvent("hold-start", false, true)).toEqual({
      kind: "hold",
      phase: "start",
      holdActive: true,
    });
    expect(resolveModifierEvent("hold-end", true, false)).toEqual({
      kind: "hold",
      phase: "end",
      holdActive: false,
    });
    expect(resolveModifierEvent("hold-cancel", true, true)).toEqual({
      kind: "hold",
      phase: "cancel",
      holdActive: false,
    });
  });

  it("ignores a hold that started elsewhere through its release", () => {
    expect(resolveModifierEvent("hold-start", false, false)).toBeNull();
    expect(resolveModifierEvent("hold-end", false, true)).toBeNull();
    expect(resolveModifierEvent("hold-cancel", false, true)).toBeNull();
  });

  it("handles instant hold-start -> quick hold-cancel -> tap without leaving hold active", () => {
    const started = resolveModifierEvent("hold-start", false, true);
    expect(started).toEqual({ kind: "hold", phase: "start", holdActive: true });
    const cancelled = resolveModifierEvent(
      "hold-cancel",
      started?.kind === "hold" && started.holdActive,
      true,
    );
    expect(cancelled).toEqual({ kind: "hold", phase: "cancel", holdActive: false });
    expect(resolveModifierEvent("tap", false, true)).toEqual({ kind: "tap" });
    // Unfocused quick tap ignores hold-start & hold-cancel, still opens Island on tap.
    expect(resolveModifierEvent("hold-start", false, false)).toBeNull();
    expect(resolveModifierEvent("hold-cancel", false, false)).toBeNull();
    expect(resolveModifierEvent("tap", false, false)).toEqual({ kind: "tap" });
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
    };

    const runPoller = (frames: ReadonlyArray<Frame>): MacModifierEvent[] => {
      let index = 0;
      const logs: string[] = [];
      const fake$ = {
        NSApplication: {
          sharedApplication: { setActivationPolicy: () => {} },
        },
        NSApplicationActivationPolicyProhibited: 2,
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
      runFn([String(CTRL), String(ALL)]);
      expect(logs[0]).toBe("ready");
      return logs
        .slice(1)
        .map(parseModifierMonitorLine)
        .filter((event): event is MacModifierEvent => event !== null);
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
  });
});
