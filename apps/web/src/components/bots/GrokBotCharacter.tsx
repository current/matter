import { msg } from "gt-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";

export type GrokBotActivityState =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "waiting"
  | "error"
  | "attention"
  | "offline";

export type GrokBotCharacterSize = "xs" | "sm" | "md" | "lg";

export type GrokBotShapeId =
  | "blob"
  | "squircle"
  | "square"
  | "pebble"
  | "pill"
  | "capsule"
  | "tablet"
  | "cylinder"
  | "bean"
  | "egg"
  | "cloud"
  | "clover"
  | "flower"
  | "star-blob"
  | "four-point"
  | "diamond"
  | "hex"
  | "wedge"
  | "shield"
  | "dome"
  | "arch"
  | "teardrop"
  | "leaf"
  | "heart"
  | "house";

export type GrokBotPaletteId =
  | "black"
  | "gray"
  | "brown"
  | "crimson"
  | "coral"
  | "amber"
  | "emerald"
  | "teal"
  | "cobalt"
  | "indigo"
  | "violet"
  | "magenta";

export interface GrokBotCharacterProps {
  readonly name: string;
  readonly seed?: string | null | undefined;
  readonly avatarDataUrl?: string | null | undefined;
  readonly shape?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly activityState: GrokBotActivityState;
  readonly size?: GrokBotCharacterSize;
  readonly reducedMotion?: boolean;
  readonly className?: string;
}

export interface GrokBotPaletteSpec {
  readonly id: GrokBotPaletteId;
  readonly bodyFill: string;
  readonly bodyFrom: string;
  readonly bodyTo: string;
  readonly highlightFill: string;
  readonly strokeFill: string;
  readonly eyeFill: string;
}

export interface GrokBotEyeSpec {
  readonly width: number;
  readonly height: number;
  readonly tiltDeg: number;
  readonly offsetY: number;
}

export interface GrokBotExpressionSpec {
  readonly state: GrokBotActivityState;
  readonly gazeX: number;
  readonly gazeY: number;
  readonly leftEye: GrokBotEyeSpec;
  readonly rightEye: GrokBotEyeSpec;
  readonly closedEyes: boolean;
  readonly motionEligible: boolean;
  readonly ringClassName: string;
  readonly badgeClassName: string | null;
}

interface ShapeGeometry {
  readonly path: string;
  readonly eyeCenterY: number;
  readonly eyeHalfGap: number;
  readonly eyeScale: number;
}

const MAX_AVATAR_DATA_URL_LENGTH = 512 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);

// Curated auto-hash pool matching Grok Bot's primary geometric silhouettes.
const AUTO_SHAPES: readonly GrokBotShapeId[] = [
  "blob",
  "squircle",
  "pebble",
  "cloud",
  "tablet",
  "hex",
  "teardrop",
  "diamond",
  "clover",
  "star-blob",
];

const SHAPE_ALIASES: Readonly<Record<string, GrokBotShapeId>> = {
  blob: "blob",
  sphere: "blob",
  circle: "blob",
  round: "blob",
  orb: "blob",
  squircle: "squircle",
  square: "square",
  box: "square",
  cube: "square",
  pebble: "pebble",
  pill: "pill",
  oval: "pill",
  capsule: "capsule",
  tablet: "tablet",
  cylinder: "cylinder",
  bean: "bean",
  egg: "egg",
  cloud: "cloud",
  puff: "cloud",
  clover: "clover",
  flower: "flower",
  starflower: "flower",
  "star-blob": "star-blob",
  star: "star-blob",
  star6: "star-blob",
  starblob: "star-blob",
  sun: "star-blob",
  "four-point": "four-point",
  sparkle: "four-point",
  diamond: "diamond",
  gem: "diamond",
  crystal: "diamond",
  hex: "hex",
  hexagon: "hex",
  wedge: "wedge",
  triangle: "wedge",
  shield: "shield",
  dome: "dome",
  arch: "arch",
  teardrop: "teardrop",
  drop: "teardrop",
  leaf: "leaf",
  heart: "heart",
  heartchubby: "heart",
  house: "house",
};

// Sculptural 48x48 silhouettes calibrated with Grok Bot's optical eye placement per body form.
const SHAPE_GEOMETRY: Readonly<Record<GrokBotShapeId, ShapeGeometry>> = {
  blob: {
    path: "M24.2 5.2C34.4 5.2 42.4 11.8 42.6 23.2C42.8 34.4 35.4 42.8 23.8 42.8C12.6 42.8 5.4 35 5.4 23.8C5.4 12.6 13.8 5.2 24.2 5.2Z",
    eyeCenterY: 24.5,
    eyeHalfGap: 6.1,
    eyeScale: 1,
  },
  squircle: {
    path: "M24 5C37.5 5 43 10.5 43 24C43 37.5 37.5 43 24 43C10.5 43 5 37.5 5 24C5 10.5 10.5 5 24 5Z",
    eyeCenterY: 24.4,
    eyeHalfGap: 6.3,
    eyeScale: 1,
  },
  square: {
    path: "M13.2 6H34.8C38.8 6 42 9.2 42 13.2V34.8C42 38.8 38.8 42 34.8 42H13.2C9.2 42 6 38.8 6 34.8V13.2C6 9.2 9.2 6 13.2 6Z",
    eyeCenterY: 24.4,
    eyeHalfGap: 6.2,
    eyeScale: 0.98,
  },
  pebble: {
    path: "M24 7.5C35.2 7.5 43.2 13.6 43.2 24.2C43.2 34.8 35.4 40.5 24 40.5C12.6 40.5 4.8 34.8 4.8 24.2C4.8 13.6 12.8 7.5 24 7.5Z",
    eyeCenterY: 24.4,
    eyeHalfGap: 6.4,
    eyeScale: 0.98,
  },
  pill: {
    path: "M24 4.5C33 4.5 39 10.5 39 19.5V28.5C39 37.5 33 43.5 24 43.5C15 43.5 9 37.5 9 28.5V19.5C9 10.5 15 4.5 24 4.5Z",
    eyeCenterY: 24.2,
    eyeHalfGap: 5.5,
    eyeScale: 0.96,
  },
  capsule: {
    path: "M19.5 8.5H28.5C37.5 8.5 43.5 14.5 43.5 24C43.5 33.5 37.5 39.5 28.5 39.5H19.5C10.5 39.5 4.5 33.5 4.5 24C4.5 14.5 10.5 8.5 19.5 8.5Z",
    eyeCenterY: 24.2,
    eyeHalfGap: 6.4,
    eyeScale: 0.95,
  },
  tablet: {
    path: "M15 5H33C37.4 5 40.5 8.1 40.5 12.5V35.5C40.5 39.9 37.4 43 33 43H15C10.6 43 7.5 39.9 7.5 35.5V12.5C7.5 8.1 10.6 5 15 5Z",
    eyeCenterY: 23.6,
    eyeHalfGap: 6,
    eyeScale: 0.96,
  },
  cylinder: {
    path: "M24 5.5C33.4 5.5 39.5 8.4 39.5 14.8V33.2C39.5 39.6 33.4 42.5 24 42.5C14.6 42.5 8.5 39.6 8.5 33.2V14.8C8.5 8.4 14.6 5.5 24 5.5Z",
    eyeCenterY: 24.4,
    eyeHalfGap: 5.8,
    eyeScale: 0.98,
  },
  bean: {
    path: "M24.8 6.4C34.2 5.4 42.2 12.2 42 22.8C41.8 33.8 33.6 42.4 22.8 42C12.8 41.6 5.6 34.4 6.2 24.2C6.8 14.2 15.2 7.4 24.8 6.4Z",
    eyeCenterY: 24.4,
    eyeHalfGap: 5.8,
    eyeScale: 0.96,
  },
  egg: {
    path: "M24 5C31.8 5 40.5 15.6 40.5 27.2C40.5 36.8 33.4 43 24 43C14.6 43 7.5 36.8 7.5 27.2C7.5 15.6 16.2 5 24 5Z",
    eyeCenterY: 26,
    eyeHalfGap: 5.6,
    eyeScale: 0.96,
  },
  cloud: {
    path: "M17.2 11.8C19.8 7.2 28.2 7.2 30.8 11.8C36.8 10.8 42.6 15.6 41.8 22.2C44.4 26.8 41.4 33.6 35.8 35C33.4 40.2 26.8 42.4 22 39.8C17 42.2 10.6 39.4 9.6 33.8C4.8 31.6 3.8 24.6 7.4 20.6C7 14.4 12 10.8 17.2 11.8Z",
    eyeCenterY: 25,
    eyeHalfGap: 5.7,
    eyeScale: 0.92,
  },
  clover: {
    path: "M24 11.8C27.2 5.2 38.2 6.8 38.2 15.6C38.2 18.6 36.8 21.4 34.8 23.4C41.8 24.2 43.2 35.2 35.4 38.6C31.8 40.2 27.4 39.2 24 36.2C20.6 39.2 16.2 40.2 12.6 38.6C4.8 35.2 6.2 24.2 13.2 23.4C11.2 21.4 9.8 18.6 9.8 15.6C9.8 6.8 20.8 5.2 24 11.8Z",
    eyeCenterY: 24.6,
    eyeHalfGap: 5.8,
    eyeScale: 0.94,
  },
  flower: {
    path: "M24 5C28.2 5 31 8.4 31.6 11.8C35 10.4 39.6 12 41 16C42.4 20 40 23.8 37.6 25.8C40.4 28.2 41.6 32.8 39 36.2C36.4 39.6 31.8 39.2 28.8 37.4C27.8 40.8 24.2 43.2 20.2 42.4C16.2 41.6 14.4 37.8 14.8 34.6C11.2 35.2 7.2 32.8 6.4 28.6C5.6 24.4 8.2 21 11 19.6C8.6 16.8 8.2 12.2 11.2 9.2C14.2 6.2 18.4 7.2 20.6 9.4C21.4 6.8 22.4 5 24 5Z",
    eyeCenterY: 24.6,
    eyeHalfGap: 5.4,
    eyeScale: 0.9,
  },
  "star-blob": {
    path: "M24 4.8C27.2 4.8 29.2 8.4 32.2 9.8C35.2 11.2 39.4 10.4 41.2 13.2C43 16 40.8 19.8 41.2 23C41.6 26.2 44.2 29.4 42.6 32.6C41 35.8 36.8 35.4 34 37.6C31.2 39.8 30 43.4 26.6 43.6C23.2 43.8 21 40.4 17.8 39.4C14.6 38.4 10.6 40 8.2 37.4C5.8 34.8 7.6 31 6.8 27.6C6 24.2 3.8 21.4 5.2 18C6.6 14.6 10.6 14.8 13.2 12.4C15.8 10 17 6.4 20.4 5.4C21.6 5 22.8 4.8 24 4.8Z",
    eyeCenterY: 24.8,
    eyeHalfGap: 5.4,
    eyeScale: 0.9,
  },
  "four-point": {
    path: "M24 4.2C26.4 14.6 33.4 21.6 43.8 24C33.4 26.4 26.4 33.4 24 43.8C21.6 33.4 14.6 26.4 4.2 24C14.6 21.6 21.6 14.6 24 4.2Z",
    eyeCenterY: 24,
    eyeHalfGap: 4.5,
    eyeScale: 0.78,
  },
  diamond: {
    path: "M24 5.2C26.2 5.2 28.2 6.2 29.8 7.8L40.2 18.2C43.4 21.4 43.4 26.6 40.2 29.8L29.8 40.2C26.6 43.4 21.4 43.4 18.2 40.2L7.8 29.8C4.6 26.6 4.6 21.4 7.8 18.2L18.2 7.8C19.8 6.2 21.8 5.2 24 5.2Z",
    eyeCenterY: 24.2,
    eyeHalfGap: 5.4,
    eyeScale: 0.9,
  },
  hex: {
    path: "M21.2 5.8C22.9 4.8 25.1 4.8 26.8 5.8L38.6 12.6C40.3 13.6 41.4 15.4 41.4 17.4V30.6C41.4 32.6 40.3 34.4 38.6 35.4L26.8 42.2C25.1 43.2 22.9 43.2 21.2 42.2L9.4 35.4C7.7 34.4 6.6 32.6 6.6 30.6V17.4C6.6 15.4 7.7 13.6 9.4 12.6L21.2 5.8Z",
    eyeCenterY: 24.4,
    eyeHalfGap: 6.2,
    eyeScale: 0.98,
  },
  wedge: {
    path: "M20.4 8.2C22 5.4 26 5.4 27.6 8.2L41.8 33C43.4 35.8 41.4 39.4 38.2 39.4H9.8C6.6 39.4 4.6 35.8 6.2 33L20.4 8.2Z",
    eyeCenterY: 27.8,
    eyeHalfGap: 5.5,
    eyeScale: 0.9,
  },
  shield: {
    path: "M24 5.5C31.2 5.5 38.6 7.8 40.4 10.6C41.4 12.2 41.6 14.4 41.4 18.2C40.8 29.8 34.8 38.4 26.4 42.4C24.9 43.1 23.1 43.1 21.6 42.4C13.2 38.4 7.2 29.8 6.6 18.2C6.4 14.4 6.6 12.2 7.6 10.6C9.4 7.8 16.8 5.5 24 5.5Z",
    eyeCenterY: 23.4,
    eyeHalfGap: 5.7,
    eyeScale: 0.96,
  },
  dome: {
    path: "M24 6.5C34.4 6.5 42 14.2 42 25.2V34.5C42 38.4 38.8 41.5 34.9 41.5H13.1C9.2 41.5 6 38.4 6 34.5V25.2C6 14.2 13.6 6.5 24 6.5Z",
    eyeCenterY: 25.2,
    eyeHalfGap: 5.8,
    eyeScale: 0.95,
  },
  arch: {
    path: "M24 5C33.4 5 40.2 11.8 40.2 21.4V36.4C40.2 39.8 37.4 42.5 34 42.5H14C10.6 42.5 7.8 39.8 7.8 36.4V21.4C7.8 11.8 14.6 5 24 5Z",
    eyeCenterY: 24.4,
    eyeHalfGap: 5.6,
    eyeScale: 0.95,
  },
  teardrop: {
    path: "M24 5.4C26 5.4 39.8 18.6 39.8 28.4C39.8 37.2 32.8 43 24 43C15.2 43 8.2 37.2 8.2 28.4C8.2 18.6 22 5.4 24 5.4Z",
    eyeCenterY: 27.6,
    eyeHalfGap: 5.4,
    eyeScale: 0.92,
  },
  leaf: {
    path: "M37.4 8.2C40 10.8 42.2 17.8 40.2 26C38.2 34.6 31.2 41.4 22.6 42.2C15.8 42.8 10.2 40.2 8.2 38C5.8 35.4 5.4 28.4 7.8 20.6C10.2 12.8 17.6 6.8 26.8 6C31.8 5.6 35.4 6.4 37.4 8.2Z",
    eyeCenterY: 24.6,
    eyeHalfGap: 5.6,
    eyeScale: 0.92,
  },
  heart: {
    path: "M24 12.6C27.2 6.8 36.6 6.2 40.8 12.4C44.6 18 42.2 26.8 35.6 33.4L27.4 41.2C25.5 43 22.5 43 20.6 41.2L12.4 33.4C5.8 26.8 3.4 18 7.2 12.4C11.4 6.2 20.8 6.8 24 12.6Z",
    eyeCenterY: 24.2,
    eyeHalfGap: 5.5,
    eyeScale: 0.9,
  },
  house: {
    path: "M21.4 6.8C22.9 5.6 25.1 5.6 26.6 6.8L39.8 17.6C41.2 18.7 42 20.4 42 22.2V35.8C42 39.2 39.2 42 35.8 42H12.2C8.8 42 6 39.2 6 35.8V22.2C6 20.4 6.8 18.7 8.2 17.6L21.4 6.8Z",
    eyeCenterY: 27.2,
    eyeHalfGap: 5.8,
    eyeScale: 0.94,
  },
};

// Auto-hash color pool excludes black (matching Grok Bot's own deterministic auto palette).
const AUTO_PALETTE_ORDER: readonly GrokBotPaletteId[] = [
  "cobalt",
  "emerald",
  "amber",
  "crimson",
  "violet",
  "indigo",
  "teal",
  "coral",
];

const PALETTE_ALIASES: Readonly<Record<string, GrokBotPaletteId>> = {
  black: "black",
  obsidian: "black",
  charcoal: "black",
  noir: "black",
  mono: "black",
  gray: "gray",
  grey: "gray",
  slate: "gray",
  silver: "gray",
  zinc: "gray",
  brown: "brown",
  bronze: "brown",
  espresso: "brown",
  sand: "brown",
  crimson: "crimson",
  red: "crimson",
  vermilion: "crimson",
  rose: "crimson",
  coral: "coral",
  orange: "coral",
  peach: "coral",
  salmon: "coral",
  amber: "amber",
  yellow: "amber",
  gold: "amber",
  emerald: "emerald",
  green: "emerald",
  mint: "emerald",
  lime: "emerald",
  teal: "teal",
  cyan: "teal",
  aqua: "teal",
  turquoise: "teal",
  cobalt: "cobalt",
  blue: "cobalt",
  sky: "cobalt",
  azure: "cobalt",
  indigo: "indigo",
  periwinkle: "indigo",
  violet: "violet",
  purple: "violet",
  lavender: "violet",
  magenta: "magenta",
  pink: "magenta",
  fuchsia: "magenta",
};

function makePalette(
  id: GrokBotPaletteId,
  bodyFrom: string,
  bodyTo: string,
  strokeFill: string,
  eyeFill = "#ffffff",
  highlightFill = "#ffffff",
): GrokBotPaletteSpec {
  return {
    id,
    bodyFill: bodyTo,
    bodyFrom,
    bodyTo,
    highlightFill,
    strokeFill,
    eyeFill,
  };
}

// Calibrated against Grok Bot v1.3.0's 135deg gradient palette, refined for dark and light mattr cards.
const PALETTES: Readonly<Record<GrokBotPaletteId, GrokBotPaletteSpec>> = {
  black: makePalette("black", "#34373e", "#14161a", "rgb(255 255 255 / 0.16)"),
  gray: makePalette("gray", "#9499a3", "#60656f", "rgb(255 255 255 / 0.16)"),
  brown: makePalette("brown", "#aa815b", "#755132", "rgb(255 255 255 / 0.14)"),
  crimson: makePalette("crimson", "#f54354", "#c41b2c", "rgb(255 255 255 / 0.14)"),
  coral: makePalette("coral", "#ff7e29", "#d65100", "rgb(255 255 255 / 0.14)"),
  amber: makePalette("amber", "#f8a523", "#cf7800", "rgb(255 255 255 / 0.14)"),
  emerald: makePalette("emerald", "#15c978", "#058f50", "rgb(255 255 255 / 0.14)"),
  teal: makePalette("teal", "#1dc4b2", "#068c7d", "rgb(255 255 255 / 0.14)"),
  cobalt: makePalette("cobalt", "#3a97ff", "#0e6fe0", "rgb(255 255 255 / 0.16)"),
  indigo: makePalette("indigo", "#6b78f7", "#444ec9", "rgb(255 255 255 / 0.16)"),
  violet: makePalette("violet", "#9b6bff", "#6a3ad6", "rgb(255 255 255 / 0.16)"),
  magenta: makePalette("magenta", "#f04e9f", "#bd1c6f", "rgb(255 255 255 / 0.14)"),
};

const OFFLINE_PALETTE: GrokBotPaletteSpec = makePalette(
  "gray",
  "#4c515b",
  "#33373f",
  "rgb(255 255 255 / 0.10)",
  "#cbd1db",
  "#ffffff",
);

const SIZE_CLASSES: Readonly<Record<GrokBotCharacterSize, string>> = {
  xs: "size-4",
  sm: "size-6",
  md: "size-8",
  lg: "size-12",
};

const BADGE_SIZE_CLASSES: Readonly<Record<GrokBotCharacterSize, string>> = {
  xs: "size-1.5",
  sm: "size-2",
  md: "size-2.5",
  lg: "size-3",
};

const ACTIVITY_LABELS: Readonly<Record<GrokBotActivityState, string>> = {
  idle: msg("idle"),
  working: msg("working"),
  thinking: msg("thinking"),
  searching: msg("searching"),
  waiting: msg("waiting"),
  error: msg("error"),
  attention: msg("needs attention"),
  offline: msg("offline"),
};

function hashSeed(input: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x3d
  );
}

function isBase64WhitespaceCode(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

// Linear scanner avoids regex backtracking on large base64 payloads and rejects SVG/script vectors.
export function sanitizeAvatarDataUrl(dataUrl: string | null | undefined): string | null {
  if (typeof dataUrl !== "string") return null;
  const trimmed = dataUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AVATAR_DATA_URL_LENGTH) return null;
  if (trimmed.slice(0, 5).toLowerCase() !== "data:") return null;

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex === -1) return null;

  const headerParts = trimmed
    .slice(5, commaIndex)
    .split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (headerParts.length !== 2 || headerParts[1] !== "base64") return null;

  const mimeType = headerParts[0];
  if (!mimeType || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return null;

  const payload = trimmed.slice(commaIndex + 1);
  const runs: string[] = [];
  let runStart = -1;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (isBase64Code(code)) {
      if (runStart === -1) runStart = index;
      continue;
    }
    if (!isBase64WhitespaceCode(code)) return null;
    if (runStart !== -1) {
      runs.push(payload.slice(runStart, index));
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    runs.push(payload.slice(runStart));
  }
  const base64 = runs.length === 1 ? runs[0]! : runs.join("");
  if (base64.length === 0 || base64.length % 4 !== 0) return null;

  const firstPad = base64.indexOf("=");
  if (firstPad !== -1) {
    if (base64.length - firstPad > 2) return null;
    for (let index = firstPad; index < base64.length; index += 1) {
      if (base64.charCodeAt(index) !== 0x3d) return null;
    }
  }

  return `data:${mimeType};base64,${base64}`;
}

export function resolveGrokBotShape(
  shape: string | null | undefined,
  fallbackSeed: string,
): GrokBotShapeId {
  if (typeof shape === "string") {
    const normalized = shape.trim().toLowerCase();
    if (normalized !== "auto") {
      const mapped = SHAPE_ALIASES[normalized];
      if (mapped) return mapped;
    }
  }
  return AUTO_SHAPES[hashSeed(`shape:${fallbackSeed}`) % AUTO_SHAPES.length]!;
}

export function resolveGrokBotPalette(
  color: string | null | undefined,
  fallbackSeed: string,
): GrokBotPaletteSpec {
  if (typeof color === "string") {
    const normalized = color.trim().toLowerCase();
    if (normalized !== "auto") {
      const mapped = PALETTE_ALIASES[normalized];
      if (mapped) return PALETTES[mapped];
    }
  }
  const id = AUTO_PALETTE_ORDER[hashSeed(`color:${fallbackSeed}`) % AUTO_PALETTE_ORDER.length]!;
  return PALETTES[id];
}

export function resolveGrokBotExpression(
  activityState: GrokBotActivityState,
): GrokBotExpressionSpec {
  switch (activityState) {
    case "working":
      return {
        state: "working",
        gazeX: 0.7,
        gazeY: 0,
        leftEye: { width: 4.5, height: 7.4, tiltDeg: 0, offsetY: 0 },
        rightEye: { width: 4.5, height: 7.4, tiltDeg: 0, offsetY: 0 },
        closedEyes: false,
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-primary/50",
        badgeClassName: "bg-primary",
      };
    case "thinking":
      return {
        state: "thinking",
        gazeX: 1.5,
        gazeY: -1.6,
        leftEye: { width: 4.4, height: 8.8, tiltDeg: -6, offsetY: 0 },
        rightEye: { width: 4.4, height: 7.4, tiltDeg: -6, offsetY: -0.4 },
        closedEyes: false,
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-info/50",
        badgeClassName: "bg-info",
      };
    case "searching":
      return {
        state: "searching",
        gazeX: 1.9,
        gazeY: -0.2,
        leftEye: { width: 5.2, height: 8.6, tiltDeg: 0, offsetY: 0 },
        rightEye: { width: 4, height: 6.8, tiltDeg: 0, offsetY: 0.2 },
        closedEyes: false,
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-info/50",
        badgeClassName: "bg-info",
      };
    case "waiting":
      return {
        state: "waiting",
        gazeX: 0,
        gazeY: 0.7,
        leftEye: { width: 4.8, height: 5.4, tiltDeg: 0, offsetY: 0 },
        rightEye: { width: 4.8, height: 5.4, tiltDeg: 0, offsetY: 0 },
        closedEyes: false,
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-warning/50",
        badgeClassName: "bg-warning",
      };
    case "error":
      return {
        state: "error",
        gazeX: 0,
        gazeY: 0.5,
        leftEye: { width: 4.2, height: 7.8, tiltDeg: -22, offsetY: 0 },
        rightEye: { width: 4.2, height: 7.8, tiltDeg: 22, offsetY: 0 },
        closedEyes: false,
        motionEligible: false,
        ringClassName: "ring-1 ring-inset ring-error/70",
        badgeClassName: "bg-error",
      };
    case "attention":
      return {
        state: "attention",
        gazeX: 0,
        gazeY: -0.7,
        leftEye: { width: 4.9, height: 11.2, tiltDeg: 0, offsetY: 0 },
        rightEye: { width: 4.9, height: 11.2, tiltDeg: 0, offsetY: 0 },
        closedEyes: false,
        motionEligible: true,
        ringClassName: "ring-2 ring-inset ring-warning",
        badgeClassName: "bg-warning",
      };
    case "offline":
      return {
        state: "offline",
        gazeX: 0,
        gazeY: 0.8,
        leftEye: { width: 5.4, height: 2.2, tiltDeg: 0, offsetY: 0 },
        rightEye: { width: 5.4, height: 2.2, tiltDeg: 0, offsetY: 0 },
        closedEyes: true,
        motionEligible: false,
        ringClassName: "ring-1 ring-inset ring-border",
        badgeClassName: null,
      };
    case "idle":
      return {
        state: "idle",
        gazeX: 0,
        gazeY: 0,
        leftEye: { width: 4.5, height: 9.8, tiltDeg: 0, offsetY: 0 },
        rightEye: { width: 4.5, height: 9.8, tiltDeg: 0, offsetY: 0 },
        closedEyes: false,
        motionEligible: false,
        ringClassName: "",
        badgeClassName: null,
      };
  }
}

function subscribeReducedMotion(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function readReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readReducedMotionServerSnapshot(): boolean {
  return false;
}

export function GrokBotCharacter({
  name,
  seed,
  avatarDataUrl,
  shape,
  color,
  activityState,
  size = "md",
  reducedMotion,
  className,
}: GrokBotCharacterProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [isInViewport, setIsInViewport] = useState(true);
  const systemReducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotionSnapshot,
    readReducedMotionServerSnapshot,
  );
  const instanceId = useId().replaceAll(":", "");
  const gradId = `grok-bot-grad-${instanceId}`;
  const sheenId = `grok-bot-sheen-${instanceId}`;
  const clipId = `grok-bot-clip-${instanceId}`;

  const fallbackSeed = seed && seed.trim().length > 0 ? seed : name;
  const safeAvatarUrl = sanitizeAvatarDataUrl(avatarDataUrl);
  const expression = resolveGrokBotExpression(activityState);
  const shapeId = resolveGrokBotShape(shape, fallbackSeed);
  const geometry = SHAPE_GEOMETRY[shapeId];
  const palette =
    activityState === "offline" ? OFFLINE_PALETTE : resolveGrokBotPalette(color, fallbackSeed);
  const shouldAnimate =
    expression.motionEligible && reducedMotion !== true && !systemReducedMotion && isInViewport;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes IntersectionObserver viewport visibility to pause active character motion off-screen.
  useEffect(() => {
    if (!expression.motionEligible || reducedMotion === true || systemReducedMotion) return;
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setIsInViewport(entry.isIntersecting);
      },
      { threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [expression.motionEligible, reducedMotion, systemReducedMotion]);

  const statusText = m(ACTIVITY_LABELS[activityState]);
  const ariaLabel = m(msg("{name} ({status})", { name, status: statusText }));
  const showSheen = size !== "xs";
  const smallBoost = size === "xs" ? 1.12 : 1;

  const leftCx = 24 - geometry.eyeHalfGap + expression.gazeX;
  const rightCx = 24 + geometry.eyeHalfGap + expression.gazeX;
  const baseCy = geometry.eyeCenterY + expression.gazeY;

  const leftW = expression.leftEye.width * geometry.eyeScale * smallBoost;
  const leftH = expression.leftEye.height * geometry.eyeScale;
  const leftCy = baseCy + expression.leftEye.offsetY;

  const rightW = expression.rightEye.width * geometry.eyeScale * smallBoost;
  const rightH = expression.rightEye.height * geometry.eyeScale;
  const rightCy = baseCy + expression.rightEye.offsetY;

  return (
    <span
      ref={rootRef}
      role="img"
      aria-label={ariaLabel}
      data-slot="grok-bot-character"
      data-activity-state={activityState}
      data-shape={shapeId}
      data-palette={palette.id}
      data-animated={shouldAnimate ? "true" : "false"}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center rounded-full align-middle",
        SIZE_CLASSES[size],
        activityState === "offline" && "opacity-70",
        safeAvatarUrl && "overflow-hidden bg-muted",
        safeAvatarUrl && expression.ringClassName,
        className,
      )}
    >
      {safeAvatarUrl ? (
        <img
          src={safeAvatarUrl}
          alt=""
          aria-hidden="true"
          decoding="async"
          className="size-full object-cover"
        />
      ) : (
        <svg viewBox="0 0 48 48" aria-hidden="true" className="size-full overflow-visible">
          <defs>
            <linearGradient id={gradId} x1="12%" y1="8%" x2="88%" y2="92%">
              <stop offset="0%" stopColor={palette.bodyFrom} />
              <stop offset="100%" stopColor={palette.bodyTo} />
            </linearGradient>
            {showSheen ? (
              <radialGradient id={sheenId} cx="32%" cy="22%" r="58%">
                <stop offset="0%" stopColor={palette.highlightFill} stopOpacity="0.22" />
                <stop offset="60%" stopColor={palette.highlightFill} stopOpacity="0.04" />
                <stop offset="100%" stopColor={palette.highlightFill} stopOpacity="0" />
              </radialGradient>
            ) : null}
            <clipPath id={clipId}>
              <path d={geometry.path} />
            </clipPath>
          </defs>

          <path
            d={geometry.path}
            fill={`url(#${gradId})`}
            stroke={palette.strokeFill}
            strokeWidth={size === "xs" ? 1.5 : 1.1}
          />

          {showSheen ? (
            <rect
              x="0"
              y="0"
              width="48"
              height="48"
              fill={`url(#${sheenId})`}
              clipPath={`url(#${clipId})`}
            />
          ) : null}

          <g className={cn(shouldAnimate && "animate-status-pulse")}>
            {expression.closedEyes ? (
              <g
                fill="none"
                stroke={palette.eyeFill}
                strokeWidth={size === "xs" ? 2.6 : 2.2}
                strokeLinecap="round"
              >
                <path
                  d={`M${leftCx - 3} ${leftCy - 0.3}Q${leftCx} ${leftCy + 2.3} ${leftCx + 3} ${leftCy - 0.3}`}
                />
                <path
                  d={`M${rightCx - 3} ${rightCy - 0.3}Q${rightCx} ${rightCy + 2.3} ${rightCx + 3} ${rightCy - 0.3}`}
                />
              </g>
            ) : (
              <g fill={palette.eyeFill}>
                <rect
                  x={leftCx - leftW / 2}
                  y={leftCy - leftH / 2}
                  width={leftW}
                  height={leftH}
                  rx={leftW / 2}
                  ry={leftW / 2}
                  transform={
                    expression.leftEye.tiltDeg !== 0
                      ? `rotate(${expression.leftEye.tiltDeg} ${leftCx} ${leftCy})`
                      : undefined
                  }
                />
                <rect
                  x={rightCx - rightW / 2}
                  y={rightCy - rightH / 2}
                  width={rightW}
                  height={rightH}
                  rx={rightW / 2}
                  ry={rightW / 2}
                  transform={
                    expression.rightEye.tiltDeg !== 0
                      ? `rotate(${expression.rightEye.tiltDeg} ${rightCx} ${rightCy})`
                      : undefined
                  }
                />
              </g>
            )}
          </g>
        </svg>
      )}

      {expression.badgeClassName ? (
        <span
          aria-hidden="true"
          data-slot="grok-bot-activity-badge"
          className={cn(
            "pointer-events-none absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-background",
            BADGE_SIZE_CLASSES[size],
            expression.badgeClassName,
            shouldAnimate && "animate-status-pulse",
          )}
        />
      ) : null}
    </span>
  );
}
