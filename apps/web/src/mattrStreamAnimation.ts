import * as Schema from "effect/Schema";
import { msg } from "gt-react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { STREAM_CARET_CLASS } from "./components/chat/mattrStreamHast";

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
  "rareui",
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
  {
    id: "rareui",
    name: msg("RareUI", { $context: "streaming text animation; a component library name" }),
    description: msg("Words land in uneven bursts and sharpen from a blur", {
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

// RareUI: whole words land in uneven chunks after uneven gaps, like tokens off a real model. A
// backlog drains within BURST_DRAIN_MS, faster the deeper it is (its time scales with
// BURST_DRAIN_WORDS / backlog), so fast output trails by a few words, not a paragraph.
const BURST_WORDS_PER_SECOND = 8;
const BURST_MAX_CHUNK = 3;
const BURST_CATCH_UP = 16;
const BURST_DRAIN_MS = 500;
const BURST_DRAIN_WORDS = 8;
const BURST_SENTENCE_PAUSE_MS = 240;
const BURST_CLAUSE_PAUSE_MS = 90;
/** Time owed past a gap is capped, so a stalled frame or hidden tab releases one chunk, not all. */
const BURST_MAX_DEBT_MS = 100;
const SENTENCE_END = /[.!?。！？]/;
const CLAUSE_END = /[,;:，、；：]/;

export interface BurstPace {
  /** Whole words shown so far. */
  readonly words: number;
  /** Milliseconds until the next chunk may land; at or below zero, it lands now. */
  readonly wait: number;
}

const WORD_TOKEN = /\S+/g;
const SPACELESS_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const wordSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/**
 * Where each whole word of streaming `text` ends. The word at the very end may still be arriving,
 * so it counts only once it ends a sentence. Space-less scripts (CJK, Thai) split by word.
 */
export function wholeWordEnds(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(WORD_TOKEN)) {
    const token = match[0];
    let end = match.index + token.length;
    if (wordSegmenter && SPACELESS_SCRIPT.test(token)) {
      end = match.index;
      let sawWord = false;
      for (const { segment, isWordLike } of wordSegmenter.segment(token)) {
        // Punctuation stays with the word before it.
        if (isWordLike && sawWord) ends.push(end);
        if (isWordLike) sawWord = true;
        end += segment.length;
      }
    }
    if (end < text.length || SENTENCE_END.test(text[end - 1]!)) ends.push(end);
  }
  return ends;
}

/** The pace after `elapsedMs`: chunks land while the wait has run out, never past `ends`. */
export function advanceBurstPacer(
  pace: BurstPace,
  text: string,
  ends: ReadonlyArray<number>,
  elapsedMs: number,
  random: () => number,
): BurstPace {
  let words = Math.min(pace.words, ends.length);
  let wait = Math.max(pace.wait - Math.max(0, elapsedMs), -BURST_MAX_DEBT_MS);
  while (wait <= 0 && words < ends.length) {
    const backlog = ends.length - words;
    const chunk = Math.min(
      backlog,
      1 + Math.floor(random() * BURST_MAX_CHUNK) + Math.floor(backlog / BURST_CATCH_UP),
    );
    words += chunk;
    const tail = text[ends[words - 1]! - 1] ?? "";
    const pause = SENTENCE_END.test(tail)
      ? BURST_SENTENCE_PAUSE_MS
      : CLAUSE_END.test(tail)
        ? BURST_CLAUSE_PAUSE_MS
        : 0;
    const natural = ((chunk * 1000) / BURST_WORDS_PER_SECOND) * (0.5 + random()) + pause;
    const drain = (chunk * BURST_DRAIN_MS * Math.min(1, BURST_DRAIN_WORDS / backlog)) / backlog;
    wait += Math.min(natural, drain);
  }
  return { words, wait };
}

/**
 * The prefix of `text` RareUI shows: whole words released in bursts on animation frames, only
 * while it trails the arrived text. Returns the full text the moment pacing stops.
 */
export function useBurstPacedText(text: string, pacing: boolean): string {
  // Start at the whole words already present on mount/activation (no replay, and immediate
  // subsequent chunks still pace even if they arrive before the first animation frame).
  const [shown, setShown] = useState<number>(() =>
    pacing ? (wholeWordEnds(text).at(-1) ?? 0) : text.length,
  );
  const [wasPacing, setWasPacing] = useState(pacing);
  if (pacing !== wasPacing) {
    setWasPacing(pacing);
    setShown(pacing ? (wholeWordEnds(text).at(-1) ?? 0) : text.length);
  }
  const pacer = useRef<{ pace: BurstPace; at: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paces against animation frames, an external clock; it stops once caught up.
  useEffect(() => {
    if (!pacing) {
      pacer.current = null;
      return;
    }
    const ends = wholeWordEnds(text);
    let state = pacer.current ?? { pace: { words: ends.length, wait: 0 }, at: performance.now() };
    pacer.current = state;
    let frame = 0;
    const tick = (now: number) => {
      // Time since the last frame counts, idle time included, so a pause already waited out
      // doesn't hold back text that arrives after it.
      state = {
        pace: advanceBurstPacer(state.pace, text, ends, now - state.at, Math.random),
        at: now,
      };
      pacer.current = state;
      setShown(ends[state.pace.words - 1] ?? 0);
      if (state.pace.words < ends.length) frame = requestAnimationFrame(tick);
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
  const burst = useBurstPacedText(paced, animation === "rareui");
  return { text: burst, animation };
}

/**
 * A streaming message that mounts while the app is navigating (opening a running thread) shows
 * as it is: its words' entrances and upstream's block fade finish before paint. Only text that
 * arrives afterwards animates, and a message that starts streaming in the open thread animates
 * from its first word. `data-panel-animations` is "false" for the first frames of a navigation.
 */
export function useSettledOpeningStreamText(
  rootRef: RefObject<HTMLElement | null>,
  streaming: boolean,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finishes CSS entrances in the DOM before paint when a running message opens with its thread
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!streaming || root === null) return;
    const navigating = root.closest("[data-panel-animations]");
    if (navigating?.getAttribute("data-panel-animations") !== "false") return;
    for (const entrance of root.getAnimations({ subtree: true })) {
      const target = (entrance.effect as KeyframeEffect | null)?.target;
      if (target?.classList.contains(STREAM_CARET_CLASS)) continue;
      if (Number.isFinite(entrance.effect?.getComputedTiming().endTime)) entrance.finish();
    }
  }, [rootRef, streaming]);
}
