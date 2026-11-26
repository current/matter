import { describe, expect, it } from "vite-plus/test";

import {
  SIRI_FLUID_DOTS_FRAG,
  SIRI_WAVE_FRAG,
  SIRI_WAVE_VERT,
  siriWaveStretch,
} from "../../../../../matter/island/siriWaveShaders";
import {
  buildSiriWaveHtml,
  siriWaveCanvasHeight,
  siriWavePageState,
  siriWaveStateForMode,
  siriWaveStretchWorklet,
} from "./siriWaveMobileLogic";

describe("Siri Wave on mobile", () => {
  it("renders Lilt's shaders unchanged", () => {
    const html = buildSiriWaveHtml();
    for (const source of [SIRI_WAVE_VERT, SIRI_WAVE_FRAG, SIRI_FLUID_DOTS_FRAG]) {
      expect(html).toContain(JSON.stringify(source).slice(1, -1));
    }
    expect(html.split("</script>")).toHaveLength(2);
  });

  it("maps voice phases onto the shared wave states", () => {
    expect(siriWaveStateForMode("hearing")).toBe("listening");
    expect(siriWaveStateForMode("muted")).toBe("idle");
    expect(siriWavePageState({ mode: "thinking", active: true, reducedMotion: false })).toEqual({
      variant: "fluid-dots",
      paused: false,
      reducedMotion: false,
      opacity: 1,
      error: false,
    });
    expect(siriWavePageState({ mode: "listening", active: false, reducedMotion: true })).toEqual(
      expect.objectContaining({ variant: "wave", paused: true, reducedMotion: true }),
    );
  });

  it("stretches with the level exactly as web does", () => {
    for (const state of ["idle", "listening", "thinking", "speaking", "error"] as const) {
      for (const level of [0, 0.4, 1, 2]) {
        expect(siriWaveStretchWorklet(state, level)).toBe(siriWaveStretch(state, level));
      }
    }
  });

  it("gives a wide strip a taller canvas so the wave's peaks are not clipped", () => {
    expect(siriWaveCanvasHeight(300, 32)).toBe(120);
    expect(siriWaveCanvasHeight(360, 220)).toBe(220);
  });
});
