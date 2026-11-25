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
  it("maps explicit shapes and aliases consistently and hashes deterministically when omitted", () => {
    expect(resolveGrokBotShape("blob", "Researcher")).toBe("blob");
    expect(resolveGrokBotShape("squircle", "Researcher")).toBe("squircle");
    expect(resolveGrokBotShape("pill", "Researcher")).toBe("pill");
    expect(resolveGrokBotShape("capsule", "Researcher")).toBe("capsule");
    expect(resolveGrokBotShape("cloud", "Researcher")).toBe("cloud");
    expect(resolveGrokBotShape("star-blob", "Researcher")).toBe("star-blob");
    expect(resolveGrokBotShape("STAR", "Researcher")).toBe("star-blob");
    expect(resolveGrokBotShape("square", "Researcher")).toBe("squircle");

    const fallbackA = resolveGrokBotShape(undefined, "Release Bot");
    const fallbackB = resolveGrokBotShape(null, "Release Bot");
    const fallbackUnknown = resolveGrokBotShape("unknown-shape-v9", "Release Bot");
    expect(fallbackA).toBe(fallbackB);
    expect(fallbackA).toBe(fallbackUnknown);
  });

  it("maps explicit color tokens and falls back deterministically using theme CSS variables", () => {
    const cobalt = resolveGrokBotPalette("blue", "Bot");
    expect(cobalt.id).toBe("cobalt");
    expect(cobalt.bodyFill).toContain("var(--");

    const emerald = resolveGrokBotPalette("emerald", "Bot");
    expect(emerald.id).toBe("emerald");

    const fallback1 = resolveGrokBotPalette(undefined, "Daily Triage");
    const fallback2 = resolveGrokBotPalette("not-a-color", "Daily Triage");
    expect(fallback1).toEqual(fallback2);
    expect(fallback1.bodyFill).not.toMatch(/#[0-9a-f]{3,8}/i);
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

  it("renders a sanitized raster avatar image and falls back to clean-room SVG on SVG XSS data URLs", () => {
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
        color: "violet",
        activityState: "idle",
        size: "md",
      }),
    );
    expect(rejectedHtml).not.toContain("<img");
    expect(rejectedHtml).toContain("<svg");
    expect(rejectedHtml).toContain('data-shape="cloud"');
    expect(rejectedHtml).toContain('data-palette="violet"');
  });

  it("covers all 8 activity states with distinct expressions and respects reducedMotion and idle stillness", () => {
    const expressions = ALL_STATES.map((state) => resolveGrokBotExpression(state));
    const distinctSignatures = new Set(
      expressions.map(
        (spec) =>
          `${spec.eyeOffsetX}:${spec.eyeOffsetY}:${spec.eyeRadiusX}:${spec.eyeRadiusY}:${spec.closedEyes}:${spec.concernedBrows}:${spec.mouthPath}`,
      ),
    );
    expect(distinctSignatures.size).toBe(ALL_STATES.length);

    for (const state of ALL_STATES) {
      const html = renderToStaticMarkup(
        createElement(GrokBotCharacter, {
          name: "Atlas",
          activityState: state,
          size: "lg",
        }),
      );
      expect(html).toContain('role="img"');
      expect(html).toContain(`data-activity-state="${state}"`);
      expect(html).toContain("Atlas");
      expect(html).toContain("<svg");

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

  it("simplifies micro-details at xs sidebar size while keeping bold readable eyes", () => {
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
    expect(xsHtml).not.toContain('opacity="0.35"');
    expect(lgHtml).toContain('opacity="0.35"');
  });
});
