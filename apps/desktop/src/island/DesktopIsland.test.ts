import { describe, expect, it } from "vite-plus/test";
import { buildIslandHtml } from "../../../../antimatter/island/islandHtml.ts";
import { shouldKeepIslandWindowAlive } from "../../../../antimatter/island/islandVisibility.ts";
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

  it("keeps the floating capsule up for running agents while mattr is in the background", () => {
    const running = makeSnapshot({ recentThreads: [makeThread("running")] });
    expect(shouldKeepIslandWindowAlive(running, false, false)).toBe(true);
    expect(shouldKeepIslandWindowAlive({ ...running, mainWindowFocused: true }, false, false)).toBe(
      false,
    );
    expect(
      shouldKeepIslandWindowAlive(
        makeSnapshot({ recentThreads: [makeThread("idle")] }),
        false,
        false,
      ),
    ).toBe(false);
  });
});
