import { describe, expect, it } from "vite-plus/test";

import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";

const hiddenSize = { width: 1280, height: 800 };
const rect = { x: 320, y: 48, width: 900, height: 700 };

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("parks a capture-active guest inside the viewport without painting it", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: true,
      rect,
      hiddenSize,
    });

    expect(style).toMatchObject({ left: 0, top: 0, zIndex: -1, pointerEvents: "none" });
    expect(style.visibility).toBe("visible");
    // Opacity 0 stops the guest's frames; it must stay above 0 but invisible over a translucent shell.
    const opacity = style.opacity ?? 1;
    expect(opacity).toBeGreaterThan(0);
    expect(opacity * 255).toBeLessThan(0.5);
  });

  it("shows the active guest at full opacity over its slot", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: true,
      renderingActive: true,
      cornerRadius: 8,
      rect,
      hiddenSize,
    });

    expect(style).toEqual({
      left: 320,
      top: 48,
      width: 900,
      height: 700,
      zIndex: 30,
      pointerEvents: "auto",
      borderRadius: 8,
    });
  });

  it("moves a suspended guest offscreen", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      keepPaintableWhenInactive: true,
      rect,
      hiddenSize,
    });

    expect(style).toMatchObject({ left: -100_000, top: -100_000, visibility: "visible" });
    expect(style.opacity).toBeUndefined();
  });
});
