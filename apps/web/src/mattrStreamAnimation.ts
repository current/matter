import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
} from "./hooks/useLocalStorage";

export const MATTR_STREAM_ANIMATION_STORAGE_KEY = "mattr:stream-animation:v1";

export const MattrStreamAnimation = Schema.Literals([
  "instant",
  "blur",
  "fade",
  "rise",
  "typewriter",
]);
export type MattrStreamAnimation = typeof MattrStreamAnimation.Type;
export type MattrAnimatedStream = Exclude<MattrStreamAnimation, "instant">;

export const DEFAULT_MATTR_STREAM_ANIMATION: MattrStreamAnimation = "instant";

export const MATTR_STREAM_ANIMATIONS: ReadonlyArray<{
  readonly id: MattrStreamAnimation;
  readonly name: string;
  readonly description: string;
}> = [
  {
    id: "instant",
    name: msg("Instant", { $context: "streaming text animation" }),
    description: msg("Text appears as it arrives, with no motion", {
      $context: "streaming text animation",
    }),
  },
  {
    id: "blur",
    name: msg("Blur Reveal", { $context: "streaming text animation" }),
    description: msg("New words settle in from a soft blur, with a caret", {
      $context: "streaming text animation",
    }),
  },
  {
    id: "fade",
    name: msg("Soft Fade", { $context: "streaming text animation" }),
    description: msg("New words glide in with a light fade", {
      $context: "streaming text animation",
    }),
  },
  {
    id: "rise",
    name: msg("Rise & Settle", { $context: "streaming text animation" }),
    description: msg("New words lift gently into place", {
      $context: "streaming text animation",
    }),
  },
  {
    id: "typewriter",
    name: msg("Smooth Pace", { $context: "streaming text animation" }),
    description: msg("Evens out bursts into a steady flow, with a caret", {
      $context: "streaming text animation",
    }),
  },
];

export function readMattrStreamAnimation(): MattrStreamAnimation {
  return readLocalStorageValue(
    MATTR_STREAM_ANIMATION_STORAGE_KEY,
    DEFAULT_MATTR_STREAM_ANIMATION,
    MattrStreamAnimation,
  );
}

export function useMattrStreamAnimationSetting() {
  return useLocalStorage(
    MATTR_STREAM_ANIMATION_STORAGE_KEY,
    DEFAULT_MATTR_STREAM_ANIMATION,
    MattrStreamAnimation,
  );
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

/** The mode streaming text plays in: Instant whenever the system asks for reduced motion. */
export function readEffectiveMattrStreamAnimation(): MattrStreamAnimation {
  if (reducedMotionQuery()?.matches) return "instant";
  return readMattrStreamAnimation();
}

function subscribeEffectiveMattrStreamAnimation(onChange: () => void): () => void {
  const stopStorage = subscribeLocalStorageKey(MATTR_STREAM_ANIMATION_STORAGE_KEY, onChange);
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => {
    stopStorage();
    query?.removeEventListener("change", onChange);
  };
}

const subscribeNothing = () => () => {};
const readInstant = (): MattrStreamAnimation => "instant";

/** The animated mode for a message, or null when it renders exactly as upstream does. */
export function useEffectiveMattrStreamAnimation(active: boolean): MattrAnimatedStream | null {
  const mode = useSyncExternalStore(
    active ? subscribeEffectiveMattrStreamAnimation : subscribeNothing,
    active ? readEffectiveMattrStreamAnimation : readInstant,
    readInstant,
  );
  return mode === "instant" ? null : mode;
}

// Smooth Pace: the shown length chases the arrived length at a speed proportional to the
// backlog, so a burst drains in a few hundred milliseconds and a trickle reads at a steady pace.
const PACE_MIN_CHARS_PER_SECOND = 140;
const PACE_CATCH_UP_PER_SECOND = 7;

/** Where the paced cursor is after `elapsedMs`, never past `target`. */
export function advancePacedCursor(cursor: number, target: number, elapsedMs: number): number {
  if (cursor >= target) return target;
  const backlog = target - cursor;
  const speed = Math.max(PACE_MIN_CHARS_PER_SECOND, backlog * PACE_CATCH_UP_PER_SECOND);
  return Math.min(target, cursor + (speed * Math.max(0, elapsedMs)) / 1000);
}

/** Shows whole words: the cursor extends to the end of the word it is in. */
export function pacedVisibleLength(text: string, cursor: number): number {
  const start = Math.floor(cursor);
  if (start >= text.length) return text.length;
  if (start <= 0) return 0;
  for (let index = start; index < text.length; index++) {
    if (/\s/.test(text[index]!)) return index;
  }
  return text.length;
}

/**
 * The prefix of `text` Smooth Pace shows. It advances on animation frames only while it trails
 * the arrived text, and returns the full text the moment pacing stops.
 */
export function usePacedText(text: string, pacing: boolean): string {
  const [shown, setShown] = useState(text.length);
  // Starts at whatever already arrived, so opening a running thread doesn't replay it.
  const cursor = useRef(text.length);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paces against animation frames, an external clock; it stops once caught up.
  useEffect(() => {
    if (!pacing) {
      cursor.current = text.length;
      return;
    }
    if (cursor.current > text.length) cursor.current = text.length;
    if (cursor.current >= text.length) {
      setShown(text.length);
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      cursor.current = advancePacedCursor(cursor.current, text.length, now - last);
      last = now;
      setShown(pacedVisibleLength(text, cursor.current));
      if (cursor.current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pacing, text]);

  if (!pacing) return text;
  const length = Math.min(shown, text.length);
  return length >= text.length ? text : text.slice(0, length);
}

/** What ChatMarkdown renders for a message: the (paced) text and its animation, if any. */
export function useMattrStreamingText(
  text: string,
  streaming: boolean,
): { readonly text: string; readonly animation: MattrAnimatedStream | null } {
  const animation = useEffectiveMattrStreamAnimation(streaming);
  const paced = usePacedText(text, animation === "typewriter");
  return { text: paced, animation };
}
