import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  GrokBotCharacter,
  resolveGrokBotExpression,
  resolveGrokBotPalette,
  resolveGrokBotShape,
  sanitizeAvatarDataUrl,
  type GrokBotActivityState,
} from "./GrokBotCharacter";

const VALID_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+8J0AAAAASUVORK5CYII=";
const VALID_WEBP_DATA_URL =
  "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
const VALID_JPEG_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgK";

describe("sanitizeAvatarDataUrl", () => {
  it("accepts valid PNG, WebP, and JPEG base64 data URLs", () => {
    expect(sanitizeAvatarDataUrl(VALID_PNG_DATA_URL)).toBe(VALID_PNG_DATA_URL);
    expect(sanitizeAvatarDataUrl(VALID_WEBP_DATA_URL)).toBe(VALID_WEBP_DATA_URL);
    expect(sanitizeAvatarDataUrl(VALID_JPEG_DATA_URL)).toBe(VALID_JPEG_DATA_URL);
    expect(sanitizeAvatarDataUrl(`  ${VALID_PNG_DATA_URL}\n`)).toBe(VALID_PNG_DATA_URL);
  });

  it("strictly rejects SVG data URLs, non-image schemes, malformed base64, and oversized payloads", () => {
    const svgBase64 =
      "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==";
    const svgInline = "data:image/svg+xml,<svg onload=alert(1)></svg>";
    const htmlData = "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";
    const oversized = `data:image/png;base64,${"A".repeat(512 * 1024)}`;

    for (const candidate of [
      null,
      undefined,
      "",
      svgBase64,
      svgInline,
      htmlData,
      "javascript:alert(1)",
      "https://example.com/avatar.png",
      "data:image/png;base64,not-valid-base64!",
      "data:image/png;base64,AAA===",
      "data:image/png;base64,A=AA",
      "data:image/png,raw-not-base64",
      oversized,
    ]) {
      expect(sanitizeAvatarDataUrl(candidate)).toBeNull();
    }
  });
});

describe("deterministic shape & color mapping", () => {
  it("maps real Grok Bot shapes and aliases consistently and hashes deterministically for auto/unknown", () => {
    expect(resolveGrokBotShape("blob", "Researcher")).toBe("blob");
    expect(resolveGrokBotShape("squircle", "Researcher")).toBe("squircle");
    expect(resolveGrokBotShape("square", "Researcher")).toBe("square");
    expect(resolveGrokBotShape("diamond", "Researcher")).toBe("diamond");
    expect(resolveGrokBotShape("gem", "Researcher")).toBe("diamond");
    expect(resolveGrokBotShape("pill", "Researcher")).toBe("pill");
    expect(resolveGrokBotShape("capsule", "Researcher")).toBe("capsule");
    expect(resolveGrokBotShape("cloud", "Researcher")).toBe("cloud");
    expect(resolveGrokBotShape("star-blob", "Researcher")).toBe("star-blob");
    expect(resolveGrokBotShape("STAR", "Researcher")).toBe("star-blob");
    expect(resolveGrokBotShape("teardrop", "Researcher")).toBe("teardrop");

    const fallbackA = resolveGrokBotShape(undefined, "Release Bot");
    const fallbackB = resolveGrokBotShape("auto", "Release Bot");
    const fallbackNull = resolveGrokBotShape(null, "Release Bot");
    const fallbackUnknown = resolveGrokBotShape("unknown-shape-v9", "Release Bot");
    expect(fallbackA).toBe(fallbackB);
    expect(fallbackA).toBe(fallbackNull);
    expect(fallbackA).toBe(fallbackUnknown);
  });

  it("maps explicit Grok Bot colors including black, red, gray, brown, blue, and auto deterministically", () => {
    const black = resolveGrokBotPalette("black", "Nightwatch");
    expect(black.id).toBe("black");
    expect(black.eyeFill).toBe("#ffffff");
    expect(black.bodyTo).toBe("#14161a");

    const red = resolveGrokBotPalette("red", "Alert Bot");
    expect(red.id).toBe("crimson");
    expect(red.eyeFill).toBe("#ffffff");

    const cobalt = resolveGrokBotPalette("blue", "Bot");
    expect(cobalt.id).toBe("cobalt");

    const emerald = resolveGrokBotPalette("emerald", "Bot");
    expect(emerald.id).toBe("emerald");

    const gray = resolveGrokBotPalette("gray", "Bot");
    expect(gray.id).toBe("gray");

    const brown = resolveGrokBotPalette("brown", "Bot");
    expect(brown.id).toBe("brown");

    const fallbackAuto = resolveGrokBotPalette("auto", "Daily Triage");
    const fallbackUndefined = resolveGrokBotPalette(undefined, "Daily Triage");
    const fallbackUnknown = resolveGrokBotPalette("not-a-color", "Daily Triage");
    expect(fallbackAuto).toEqual(fallbackUndefined);
    expect(fallbackAuto).toEqual(fallbackUnknown);
    expect(fallbackAuto.id).not.toBe("black");
  });
});

describe("GrokBotCharacter rendering & activity states", () => {
  const ALL_STATES: readonly GrokBotActivityState[] = [
    "idle",
    "working",
    "thinking",
    "searching",
    "waiting",
    "error",
    "attention",
    "offline",
  ];

  it("renders a sanitized raster avatar image and falls back to geometric SVG on SVG XSS data URLs", () => {
    const validHtml = renderToStaticMarkup(
      createElement(GrokBotCharacter, {
        name: "Ops Bot",
        avatarDataUrl: VALID_PNG_DATA_URL,
        activityState: "working",
        size: "md",
      }),
    );
    expect(validHtml).toContain("<img");
    expect(validHtml).toContain(VALID_PNG_DATA_URL);
    expect(validHtml).not.toContain("<svg");

    const rejectedHtml = renderToStaticMarkup(
      createElement(GrokBotCharacter, {
        name: "Ops Bot",
        avatarDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        shape: "cloud",
        color: "black",
        activityState: "idle",
        size: "md",
      }),
    );
    expect(rejectedHtml).not.toContain("<img");
    expect(rejectedHtml).toContain("<svg");
    expect(rejectedHtml).toContain('data-shape="cloud"');
    expect(rejectedHtml).toContain('data-palette="black"');
    expect(rejectedHtml).toContain('fill="#ffffff"');
  });

  it("draws sculptural capsule eyes without emoji mouths and covers all 8 activity states with distinct expressions", () => {
    const expressions = ALL_STATES.map((state) => resolveGrokBotExpression(state));
    const distinctSignatures = new Set(
      expressions.map(
        (spec) =>
          `${spec.gazeX}:${spec.gazeY}:${spec.leftEye.width}:${spec.leftEye.height}:${spec.leftEye.tiltDeg}:${spec.rightEye.width}:${spec.rightEye.height}:${spec.rightEye.tiltDeg}:${spec.closedEyes}`,
      ),
    );
    expect(distinctSignatures.size).toBe(ALL_STATES.length);

    for (const state of ALL_STATES) {
      const html = renderToStaticMarkup(
        createElement(GrokBotCharacter, {
          name: "Atlas",
          color: "black",
          activityState: state,
          size: "lg",
        }),
      );
      expect(html).toContain('role="img"');
      expect(html).toContain(`data-activity-state="${state}"`);
      expect(html).toContain("Atlas");
      expect(html).toContain("<svg");
      // Never renders cartoony pupils/ellipses from the old emoji-smiley design.
      expect(html).not.toContain("<ellipse");
      expect(html).not.toContain("<circle");

      if (state === "idle" || state === "offline" || state === "error") {
        expect(html).toContain('data-animated="false"');
      } else {
        expect(html).toContain('data-animated="true"');
      }
    }

    const reducedHtml = renderToStaticMarkup(
      createElement(GrokBotCharacter, {
        name: "Atlas",
        activityState: "working",
        reducedMotion: true,
      }),
    );
    expect(reducedHtml).toContain('data-animated="false"');
    expect(reducedHtml).not.toContain("animate-status-pulse");
  });

  it("omits subtle sheen at xs sidebar size while preserving crisp capsule eyes", () => {
    const xsHtml = renderToStaticMarkup(
      createElement(GrokBotCharacter, {
        name: "Tiny",
        shape: "squircle",
        color: "amber",
        activityState: "idle",
        size: "xs",
      }),
    );
    const lgHtml = renderToStaticMarkup(
      createElement(GrokBotCharacter, {
        name: "Tiny",
        shape: "squircle",
        color: "amber",
        activityState: "idle",
        size: "lg",
      }),
    );
    expect(xsHtml).toContain("size-4");
    expect(lgHtml).toContain("size-12");
    expect(xsHtml).not.toContain("radialGradient");
    expect(lgHtml).toContain("radialGradient");
  });
});
