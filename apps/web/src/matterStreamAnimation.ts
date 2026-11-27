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

import {
  advancePhrasePacer,
  MATTER_STREAM_ANIMATION_IDS,
  MATTER_STREAM_ANIMATION_STORAGE_KEY,
  PHRASE_HOLD_MS,
  phraseBreaks,
  type PhrasePace,
  STREAM_CLAUSE_END,
  STREAM_MAX_DEBT_MS,
  STREAM_SENTENCE_END,
  wholeWordEnds,
} from "@t3tools/client-runtime/matter/stream-animation";

import { STREAM_CARET_CLASS, STREAM_WORD_CLASS } from "./components/chat/matterStreamHast";

import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
} from "./hooks/useLocalStorage";

export {
  advancePhrasePacer,
  MATTER_STREAM_ANIMATION_STORAGE_KEY,
  phraseBreaks,
  type PhraseBreak,
  type PhrasePace,
  wholeWordEnds,
} from "@t3tools/client-runtime/matter/stream-animation";

export const MatterStreamAnimation = Schema.Literals(MATTER_STREAM_ANIMATION_IDS);
export type MatterStreamAnimation = typeof MatterStreamAnimation.Type;
export type MatterAnimatedStream = Exclude<MatterStreamAnimation, "instant">;

export const DEFAULT_MATTER_STREAM_ANIMATION: MatterStreamAnimation = "instant";

export const MATTER_STREAM_ANIMATIONS: ReadonlyArray<{
  readonly id: MatterStreamAnimation;
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
  {
    id: "ink",
    name: msg("Ink", { $context: "streaming text animation" }),
    description: msg("Each word develops quickly from a fine blur", {
      $context: "streaming text animation",
    }),
  },
  {
    id: "line",
    name: msg("Line settle", { $context: "streaming text animation" }),
    description: msg("The line being written sits light and settles once it is done", {
      $context: "streaming text animation",
    }),
  },
  {
    id: "phrase",
    name: msg("Phrase", { $context: "streaming text animation" }),
    description: msg("A whole phrase lands at once, so nothing moves while you read", {
      $context: "streaming text animation",
    }),
  },
];

export function readMatterStreamAnimation(): MatterStreamAnimation {
  return readLocalStorageValue(
    MATTER_STREAM_ANIMATION_STORAGE_KEY,
    DEFAULT_MATTER_STREAM_ANIMATION,
    MatterStreamAnimation,
  );
}

export function useMatterStreamAnimationSetting() {
  return useLocalStorage(
    MATTER_STREAM_ANIMATION_STORAGE_KEY,
    DEFAULT_MATTER_STREAM_ANIMATION,
    MatterStreamAnimation,
  );
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

/** The mode streaming text plays in: Instant whenever the system asks for reduced motion. */
export function readEffectiveMatterStreamAnimation(): MatterStreamAnimation {
  if (reducedMotionQuery()?.matches) return "instant";
  return readMatterStreamAnimation();
}

function subscribeEffectiveMatterStreamAnimation(onChange: () => void): () => void {
  const stopStorage = subscribeLocalStorageKey(MATTER_STREAM_ANIMATION_STORAGE_KEY, onChange);
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => {
    stopStorage();
    query?.removeEventListener("change", onChange);
  };
}

const subscribeNothing = () => () => {};
const readInstant = (): MatterStreamAnimation => "instant";

/** The animated mode for a message, or null when it renders exactly as upstream does. */
export function useEffectiveMatterStreamAnimation(active: boolean): MatterAnimatedStream | null {
  const mode = useSyncExternalStore(
    active ? subscribeEffectiveMatterStreamAnimation : subscribeNothing,
    active ? readEffectiveMatterStreamAnimation : readInstant,
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

export interface BurstPace {
  /** Whole words shown so far. */
  readonly words: number;
  /** Milliseconds until the next chunk may land; at or below zero, it lands now. */
  readonly wait: number;
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
  let wait = Math.max(pace.wait - Math.max(0, elapsedMs), -STREAM_MAX_DEBT_MS);
  while (wait <= 0 && words < ends.length) {
    const backlog = ends.length - words;
    const chunk = Math.min(
      backlog,
      1 + Math.floor(random() * BURST_MAX_CHUNK) + Math.floor(backlog / BURST_CATCH_UP),
    );
    words += chunk;
    const tail = text[ends[words - 1]! - 1] ?? "";
    const pause = STREAM_SENTENCE_END.test(tail)
      ? BURST_SENTENCE_PAUSE_MS
      : STREAM_CLAUSE_END.test(tail)
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

/**
 * The prefix of `text` Phrase shows: whole phrases released on animation frames, plus a held
 * clause once no text has arrived for a moment. Returns the full text the moment pacing stops.
 */
export function usePhrasePacedText(text: string, pacing: boolean): string {
  // Starts at whatever already arrived, so opening a running thread doesn't replay it.
  const [shown, setShown] = useState<number>(() =>
    pacing ? (wholeWordEnds(text).at(-1) ?? 0) : text.length,
  );
  const [wasPacing, setWasPacing] = useState(pacing);
  if (pacing !== wasPacing) {
    setWasPacing(pacing);
    setShown(pacing ? (wholeWordEnds(text).at(-1) ?? 0) : text.length);
  }
  const pacer = useRef<{ pace: PhrasePace; at: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paces against animation frames and a hold timer, external clocks; both stop once caught up.
  useEffect(() => {
    if (!pacing) {
      pacer.current = null;
      return;
    }
    const breaks = phraseBreaks(text);
    let state = pacer.current ?? {
      pace: { phrases: breaks.length, wait: 0 },
      at: performance.now(),
    };
    pacer.current = state;
    let frame = 0;
    let hold: ReturnType<typeof setTimeout> | undefined;
    // Shown text never shrinks: a held clause that was flushed stays up while its phrase completes.
    const showUpTo = (end: number) => setShown((current) => Math.max(current, end));
    const tick = (now: number) => {
      state = { pace: advancePhrasePacer(state.pace, breaks, now - state.at), at: now };
      pacer.current = state;
      showUpTo(breaks[state.pace.phrases - 1]?.end ?? 0);
      if (state.pace.phrases < breaks.length) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const lastWord = wholeWordEnds(text).at(-1) ?? 0;
      if (lastWord > (breaks.at(-1)?.end ?? 0)) {
        hold = setTimeout(() => showUpTo(lastWord), PHRASE_HOLD_MS);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(hold);
    };
  }, [pacing, text]);

  if (!pacing) return text;
  const length = Math.min(shown, text.length);
  return length >= text.length ? text : text.slice(0, length);
}

/** What ChatMarkdown renders for a message: the (paced) text and its animation, if any. */
export function useMatterStreamingText(
  text: string,
  streaming: boolean,
): { readonly text: string; readonly animation: MatterAnimatedStream | null } {
  const animation = useEffectiveMatterStreamAnimation(streaming);
  const paced = usePacedText(text, animation === "typewriter");
  const burst = useBurstPacedText(paced, animation === "rareui");
  const phrased = usePhrasePacedText(burst, animation === "phrase");
  return { text: phrased, animation };
}

const STREAM_LINE_SETTLED_CLASS = "matter-sw-settled";

/**
 * Line settle: the line being written sits light, and every word on a line a later word has
 * wrapped below settles. Reads only the unsettled words' boxes.
 * The words present when it first runs settle without a transition, so opening a thread
 * mid-reply doesn't fade its text in again.
 */
export function useMatterLineSettle(rootRef: RefObject<HTMLElement | null>, active: boolean): void {
  const settledOnce = useRef(false);
  // Runs after every render: the owner re-renders as text arrives, and only unsettled words are read.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads where words wrapped in the DOM after each update, which React can't know
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!active || root === null) {
      settledOnce.current = false;
      return;
    }
    const live = root.querySelectorAll<HTMLElement>(
      `span.${STREAM_WORD_CLASS}:not(.${STREAM_LINE_SETTLED_CLASS})`,
    );
    const last = live[live.length - 1];
    if (last === undefined) return;
    const lastTop = last.getBoundingClientRect().top;
    for (const word of live) {
      if (word.getBoundingClientRect().top < lastTop - 1) {
        word.classList.add(STREAM_LINE_SETTLED_CLASS);
      }
    }
    if (settledOnce.current) return;
    settledOnce.current = true;
    for (const word of live) {
      for (const transition of word.getAnimations()) {
        if (transition instanceof CSSTransition) transition.finish();
      }
    }
  });
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
