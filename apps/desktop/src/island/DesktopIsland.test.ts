import { describe, expect, it } from "vite-plus/test";
import { buildIslandHtml } from "../../../../antimatter/island/islandHtml.ts";
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
    expect(html).toContain("onDisplayMetrics");
    expect(html).toContain("notifyAnimationIdle");
    expect(html).toContain("prefers-reduced-motion");

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => new Function(scriptMatch![1]!)).not.toThrow();
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
