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

export type GrokBotShapeId = "blob" | "squircle" | "pill" | "capsule" | "cloud" | "star-blob";

export type GrokBotPaletteId =
  | "cobalt"
  | "emerald"
  | "amber"
  | "crimson"
  | "violet"
  | "indigo"
  | "teal"
  | "coral";

export interface GrokBotCharacterProps {
  readonly name: string;
  readonly avatarDataUrl?: string | null;
  readonly shape?: string | null;
  readonly color?: string | null;
  readonly activityState: GrokBotActivityState;
  readonly size?: GrokBotCharacterSize;
  readonly reducedMotion?: boolean;
  readonly className?: string;
}

export interface GrokBotPaletteSpec {
  readonly id: GrokBotPaletteId;
  readonly bodyFill: string;
  readonly highlightFill: string;
  readonly strokeFill: string;
  readonly eyeFill: string;
  readonly pupilFill: string;
}

export interface GrokBotExpressionSpec {
  readonly state: GrokBotActivityState;
  readonly eyeOffsetX: number;
  readonly eyeOffsetY: number;
  readonly eyeRadiusX: number;
  readonly eyeRadiusY: number;
  readonly pupilOffsetX: number;
  readonly pupilOffsetY: number;
  readonly showGlint: boolean;
  readonly closedEyes: boolean;
  readonly concernedBrows: boolean;
  readonly mouthPath: string;
  readonly motionEligible: boolean;
  readonly ringClassName: string;
  readonly badgeClassName: string | null;
}

const MAX_AVATAR_DATA_URL_LENGTH = 512 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);

const SHAPES: readonly GrokBotShapeId[] = [
  "blob",
  "squircle",
  "pill",
  "capsule",
  "cloud",
  "star-blob",
];

const SHAPE_ALIASES: Readonly<Record<string, GrokBotShapeId>> = {
  blob: "blob",
  circle: "blob",
  round: "blob",
  orb: "blob",
  drop: "blob",
  squircle: "squircle",
  square: "squircle",
  box: "squircle",
  cube: "squircle",
  pill: "pill",
  oval: "pill",
  egg: "pill",
  capsule: "capsule",
  pebble: "capsule",
  bean: "capsule",
  cloud: "cloud",
  clover: "cloud",
  puff: "cloud",
  "star-blob": "star-blob",
  star: "star-blob",
  starblob: "star-blob",
  sun: "star-blob",
  flower: "star-blob",
  gem: "star-blob",
  hex: "star-blob",
};

// Original clean-room silhouettes drawn in a 48x48 viewBox.
const SHAPE_PATHS: Readonly<Record<GrokBotShapeId, string>> = {
  blob: "M24 5C34.2 5 42.5 11.4 42.8 22.4C43.1 33.8 35.6 42.8 24.4 43C12.8 43.2 5.2 35.4 5.2 24.2C5.2 12.6 13.8 5 24 5Z",
  squircle:
    "M24 5C37.2 5 43 10.8 43 24C43 37.2 37.2 43 24 43C10.8 43 5 37.2 5 24C5 10.8 10.8 5 24 5Z",
  pill: "M24 4C33.4 4 39.5 10.2 39.5 19.5V28.5C39.5 37.8 33.4 44 24 44C14.6 44 8.5 37.8 8.5 28.5V19.5C8.5 10.2 14.6 4 24 4Z",
  capsule:
    "M19.5 8.5H28.5C37.8 8.5 44 14.6 44 24C44 33.4 37.8 39.5 28.5 39.5H19.5C10.2 39.5 4 33.4 4 24C4 14.6 10.2 8.5 19.5 8.5Z",
  cloud:
    "M17.5 11.5C20.2 7.4 27.8 7.4 30.5 11.5C36.5 10.8 42.4 15.6 41.8 22.2C44.2 26.8 41.2 33.8 35.6 35.2C33.4 40.4 26.6 42.6 21.8 39.8C16.8 42.2 10.4 39.4 9.6 33.8C4.8 31.6 3.8 24.6 7.4 20.6C7.2 14.4 12.2 10.6 17.5 11.5Z",
  "star-blob":
    "M24 4.5C27.4 4.5 29.4 8.2 32.5 9.6C35.6 11 39.8 10.2 41.6 13.1C43.4 16 41.2 19.8 41.6 23.2C42 26.6 44.8 29.6 43.2 32.8C41.6 36 37.2 35.6 34.4 37.8C31.6 40 30.4 43.8 26.8 44C23.2 44.2 21 40.8 17.6 39.8C14.2 38.8 10.2 40.4 7.8 37.8C5.4 35.2 7.2 31.2 6.4 27.8C5.6 24.4 3.4 21.6 4.8 18.2C6.2 14.8 10.4 15 13 12.6C15.6 10.2 16.8 6.4 20.2 5.4C21.5 5 22.8 4.5 24 4.5Z",
};

const PALETTE_ORDER: readonly GrokBotPaletteId[] = [
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
  cobalt: "cobalt",
  blue: "cobalt",
  sky: "cobalt",
  cyan: "cobalt",
  azure: "cobalt",
  emerald: "emerald",
  green: "emerald",
  mint: "emerald",
  lime: "emerald",
  amber: "amber",
  yellow: "amber",
  gold: "amber",
  orange: "amber",
  crimson: "crimson",
  red: "crimson",
  rose: "crimson",
  violet: "violet",
  purple: "violet",
  lavender: "violet",
  magenta: "violet",
  pink: "violet",
  indigo: "indigo",
  periwinkle: "indigo",
  teal: "teal",
  aqua: "teal",
  turquoise: "teal",
  coral: "coral",
  peach: "coral",
  salmon: "coral",
};

function makeSemanticPalette(
  id: GrokBotPaletteId,
  bodyFill: string,
  eyeFill: string,
): GrokBotPaletteSpec {
  return {
    id,
    bodyFill,
    highlightFill: `color-mix(in oklch, ${bodyFill} 70%, var(--background))`,
    strokeFill: `color-mix(in oklch, ${bodyFill} 76%, var(--foreground))`,
    eyeFill,
    pupilFill: "var(--foreground)",
  };
}

const PALETTES: Readonly<Record<GrokBotPaletteId, GrokBotPaletteSpec>> = {
  cobalt: makeSemanticPalette("cobalt", "var(--info)", "var(--background)"),
  emerald: makeSemanticPalette("emerald", "var(--success)", "var(--background)"),
  amber: makeSemanticPalette("amber", "var(--warning)", "var(--background)"),
  crimson: makeSemanticPalette("crimson", "var(--error)", "var(--background)"),
  violet: makeSemanticPalette("violet", "var(--guest)", "var(--background)"),
  indigo: makeSemanticPalette("indigo", "var(--update)", "var(--background)"),
  teal: makeSemanticPalette(
    "teal",
    "color-mix(in oklch, var(--success) 56%, var(--info))",
    "var(--background)",
  ),
  coral: makeSemanticPalette(
    "coral",
    "color-mix(in oklch, var(--warning) 44%, var(--error))",
    "var(--background)",
  ),
};

const OFFLINE_PALETTE: GrokBotPaletteSpec = {
  id: "cobalt",
  bodyFill: "var(--muted)",
  highlightFill: "var(--secondary)",
  strokeFill: "var(--border)",
  eyeFill: "var(--muted-foreground)",
  pupilFill: "var(--muted-foreground)",
};

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
    const mapped = SHAPE_ALIASES[normalized];
    if (mapped) return mapped;
  }
  return SHAPES[hashSeed(`shape:${fallbackSeed}`) % SHAPES.length]!;
}

export function resolveGrokBotPalette(
  color: string | null | undefined,
  fallbackSeed: string,
): GrokBotPaletteSpec {
  if (typeof color === "string") {
    const normalized = color.trim().toLowerCase();
    const mapped = PALETTE_ALIASES[normalized];
    if (mapped) return PALETTES[mapped];
  }
  const id = PALETTE_ORDER[hashSeed(`color:${fallbackSeed}`) % PALETTE_ORDER.length]!;
  return PALETTES[id];
}

export function resolveGrokBotExpression(
  activityState: GrokBotActivityState,
): GrokBotExpressionSpec {
  switch (activityState) {
    case "working":
      return {
        state: "working",
        eyeOffsetX: 0,
        eyeOffsetY: 0,
        eyeRadiusX: 3.1,
        eyeRadiusY: 2.3,
        pupilOffsetX: 0.4,
        pupilOffsetY: 0,
        showGlint: true,
        closedEyes: false,
        concernedBrows: false,
        mouthPath: "M20.5 31.2H27.5",
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-primary/50",
        badgeClassName: "bg-primary",
      };
    case "thinking":
      return {
        state: "thinking",
        eyeOffsetX: 0.8,
        eyeOffsetY: -1.6,
        eyeRadiusX: 3,
        eyeRadiusY: 3.2,
        pupilOffsetX: 0.9,
        pupilOffsetY: -1.1,
        showGlint: true,
        closedEyes: false,
        concernedBrows: false,
        mouthPath: "M21.5 31.6Q24 30.8 26.8 31.4",
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-info/50",
        badgeClassName: "bg-info",
      };
    case "searching":
      return {
        state: "searching",
        eyeOffsetX: 1.8,
        eyeOffsetY: -0.2,
        eyeRadiusX: 3.1,
        eyeRadiusY: 3.1,
        pupilOffsetX: 1.3,
        pupilOffsetY: 0,
        showGlint: true,
        closedEyes: false,
        concernedBrows: false,
        mouthPath: "M21 31.5Q24 32.3 27 31.5",
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-info/50",
        badgeClassName: "bg-info",
      };
    case "waiting":
      return {
        state: "waiting",
        eyeOffsetX: 0,
        eyeOffsetY: 0,
        eyeRadiusX: 3.2,
        eyeRadiusY: 3.6,
        pupilOffsetX: 0,
        pupilOffsetY: 0.2,
        showGlint: true,
        closedEyes: false,
        concernedBrows: false,
        mouthPath: "M21.8 31.6A2.2 1.2 0 0 0 26.2 31.6",
        motionEligible: true,
        ringClassName: "ring-1 ring-inset ring-warning/50",
        badgeClassName: "bg-warning",
      };
    case "error":
      return {
        state: "error",
        eyeOffsetX: 0,
        eyeOffsetY: 0.6,
        eyeRadiusX: 2.8,
        eyeRadiusY: 2.8,
        pupilOffsetX: 0,
        pupilOffsetY: 0.4,
        showGlint: false,
        closedEyes: false,
        concernedBrows: true,
        mouthPath: "M20.5 33Q24 30.4 27.5 33",
        motionEligible: false,
        ringClassName: "ring-1 ring-inset ring-error/70",
        badgeClassName: "bg-error",
      };
    case "attention":
      return {
        state: "attention",
        eyeOffsetX: 0,
        eyeOffsetY: -0.5,
        eyeRadiusX: 3.4,
        eyeRadiusY: 3.8,
        pupilOffsetX: 0,
        pupilOffsetY: -0.3,
        showGlint: true,
        closedEyes: false,
        concernedBrows: false,
        mouthPath: "M21.5 31.4Q24 33.4 26.5 31.4",
        motionEligible: true,
        ringClassName: "ring-2 ring-inset ring-warning",
        badgeClassName: "bg-warning",
      };
    case "offline":
      return {
        state: "offline",
        eyeOffsetX: 0,
        eyeOffsetY: 0.5,
        eyeRadiusX: 3,
        eyeRadiusY: 1.5,
        pupilOffsetX: 0,
        pupilOffsetY: 0,
        showGlint: false,
        closedEyes: true,
        concernedBrows: false,
        mouthPath: "M21.5 31.8H26.5",
        motionEligible: false,
        ringClassName: "ring-1 ring-inset ring-border",
        badgeClassName: null,
      };
    case "idle":
      return {
        state: "idle",
        eyeOffsetX: 0,
        eyeOffsetY: 0,
        eyeRadiusX: 3,
        eyeRadiusY: 3.3,
        pupilOffsetX: 0,
        pupilOffsetY: 0,
        showGlint: true,
        closedEyes: false,
        concernedBrows: false,
        mouthPath: "M20.6 31.2Q24 33.4 27.4 31.2",
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
  const clipId = `grok-bot-clip-${useId().replaceAll(":", "")}`;

  const safeAvatarUrl = sanitizeAvatarDataUrl(avatarDataUrl);
  const expression = resolveGrokBotExpression(activityState);
  const shapeId = resolveGrokBotShape(shape, name);
  const palette =
    activityState === "offline" ? OFFLINE_PALETTE : resolveGrokBotPalette(color, name);
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
  const showMicroDetails = size !== "xs";

  const leftEyeX = 18.2 + expression.eyeOffsetX;
  const rightEyeX = 29.8 + expression.eyeOffsetX;
  const eyeY = 22.2 + expression.eyeOffsetY;

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
        activityState === "offline" && "opacity-65",
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
        <svg
          viewBox="0 0 48 48"
          aria-hidden="true"
          className={cn("size-full overflow-visible", shouldAnimate && "animate-status-pulse")}
        >
          <defs>
            <clipPath id={clipId}>
              <path d={SHAPE_PATHS[shapeId]} />
            </clipPath>
          </defs>

          <path
            d={SHAPE_PATHS[shapeId]}
            fill={palette.bodyFill}
            stroke={palette.strokeFill}
            strokeWidth={size === "xs" ? 1.5 : 1.2}
          />

          {showMicroDetails ? (
            <ellipse
              cx="20"
              cy="12.5"
              rx="11"
              ry="4.5"
              fill={palette.highlightFill}
              opacity="0.35"
              clipPath={`url(#${clipId})`}
            />
          ) : null}

          {expression.closedEyes ? (
            <g
              fill="none"
              stroke={palette.eyeFill}
              strokeWidth={size === "xs" ? 2.4 : 2}
              strokeLinecap="round"
            >
              <path
                d={`M${leftEyeX - 3} ${eyeY}Q${leftEyeX} ${eyeY + 2.2} ${leftEyeX + 3} ${eyeY}`}
              />
              <path
                d={`M${rightEyeX - 3} ${eyeY}Q${rightEyeX} ${eyeY + 2.2} ${rightEyeX + 3} ${eyeY}`}
              />
            </g>
          ) : (
            <g>
              <ellipse
                cx={leftEyeX}
                cy={eyeY}
                rx={expression.eyeRadiusX}
                ry={expression.eyeRadiusY}
                fill={palette.eyeFill}
              />
              <ellipse
                cx={rightEyeX}
                cy={eyeY}
                rx={expression.eyeRadiusX}
                ry={expression.eyeRadiusY}
                fill={palette.eyeFill}
              />
              <circle
                cx={leftEyeX + expression.pupilOffsetX}
                cy={eyeY + expression.pupilOffsetY}
                r={size === "xs" ? 1.5 : 1.35}
                fill={palette.pupilFill}
              />
              <circle
                cx={rightEyeX + expression.pupilOffsetX}
                cy={eyeY + expression.pupilOffsetY}
                r={size === "xs" ? 1.5 : 1.35}
                fill={palette.pupilFill}
              />
              {expression.showGlint && showMicroDetails ? (
                <g fill={palette.eyeFill} opacity="0.9">
                  <circle cx={leftEyeX + 0.9} cy={eyeY - 1.1} r="0.65" />
                  <circle cx={rightEyeX + 0.9} cy={eyeY - 1.1} r="0.65" />
                </g>
              ) : null}
            </g>
          )}

          {expression.concernedBrows ? (
            <g fill="none" stroke={palette.eyeFill} strokeWidth="1.7" strokeLinecap="round">
              <path d={`M${leftEyeX - 3.2} ${eyeY - 4.2}L${leftEyeX + 2.4} ${eyeY - 5.6}`} />
              <path d={`M${rightEyeX + 3.2} ${eyeY - 4.2}L${rightEyeX - 2.4} ${eyeY - 5.6}`} />
            </g>
          ) : null}

          {showMicroDetails ? (
            <path
              d={expression.mouthPath}
              fill="none"
              stroke={palette.eyeFill}
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          ) : null}

          {activityState === "thinking" && showMicroDetails ? (
            <g fill={palette.eyeFill} opacity="0.85">
              <circle cx="35.5" cy="13.5" r="1.2" />
              <circle cx="39" cy="10.2" r="1.7" />
            </g>
          ) : null}

          {activityState === "attention" && showMicroDetails ? (
            <circle cx="36.5" cy="12" r="2.2" fill="var(--warning)" />
          ) : null}
        </svg>
      )}

      {expression.badgeClassName ? (
        <span
          aria-hidden="true"
          data-slot="grok-bot-activity-badge"
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 rounded-full ring-1 ring-inset ring-background",
            BADGE_SIZE_CLASSES[size],
            expression.badgeClassName,
            shouldAnimate && "animate-status-pulse",
          )}
        />
      ) : null}
    </span>
  );
}
