/** Streaming text (Settings → Appearance): how assistant words appear while a reply streams. */
export const MATTER_STREAM_ANIMATION_STORAGE_KEY = "mattr:stream-animation:v1";

export const MATTER_STREAM_ANIMATION_IDS = [
  "instant",
  "blur",
  "fade",
  "rise",
  "typewriter",
  "rareui",
  "ink",
  "line",
  "phrase",
] as const;
export type MatterStreamAnimationId = (typeof MATTER_STREAM_ANIMATION_IDS)[number];

export const DEFAULT_MATTER_STREAM_ANIMATION: MatterStreamAnimationId = "instant";

/**
 * The styles the native app plays. The native markdown view fades words and paces text itself;
 * it can't blur or move single words, so blur, rise, ink, RareUI and line settle stay web-only.
 */
export const MATTER_NATIVE_STREAM_ANIMATION_IDS = [
  "instant",
  "fade",
  "typewriter",
  "phrase",
] as const satisfies ReadonlyArray<MatterStreamAnimationId>;
export type MatterNativeStreamAnimationId = (typeof MATTER_NATIVE_STREAM_ANIMATION_IDS)[number];

export function parseMatterNativeStreamAnimation(value: unknown): MatterNativeStreamAnimationId {
  return MATTER_NATIVE_STREAM_ANIMATION_IDS.find((id) => id === value) ?? "instant";
}

export interface MatterNativeStreamEffect {
  /** How long each new word fades in, in milliseconds. */
  readonly fadeMs: number;
  /** The native view paces the shown text word by word. */
  readonly smooth: boolean;
  /** Whole phrases are released at once, so their words fade in together. */
  readonly phrases: boolean;
}

const NATIVE_STREAM_EFFECTS: Readonly<
  Record<MatterNativeStreamAnimationId, MatterNativeStreamEffect | null>
> = {
  instant: null,
  fade: { fadeMs: 180, smooth: false, phrases: false },
  typewriter: { fadeMs: 120, smooth: true, phrases: false },
  phrase: { fadeMs: 200, smooth: false, phrases: true },
};

/** What the native markdown view does for a style (one object per style), or null for Instant. */
export function matterNativeStreamEffect(
  animation: MatterNativeStreamAnimationId,
): MatterNativeStreamEffect | null {
  return NATIVE_STREAM_EFFECTS[animation];
}

export const STREAM_SENTENCE_END = /[.!?。！？]/;
export const STREAM_CLAUSE_END = /[,;:，、；：]/;
/** Time owed past a gap is capped, so a stalled frame or hidden tab releases one chunk, not all. */
export const STREAM_MAX_DEBT_MS = 100;

const WORD_TOKEN = /\S+/g;
const SPACELESS_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// Feature-detected: Hermes has no Intl.Segmenter, so the native app splits space-less scripts at
// spaces and sentence ends only.
const wordSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? // oxlint-disable-next-line t3code/no-hermes-unsupported-apis -- feature-detected by the typeof check
      new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/**
 * Where each whole word of streaming `text` ends, scanning from `from` (a word boundary). The word
 * at the very end may still be arriving, so it counts only once it ends a sentence. Space-less
 * scripts (CJK, Thai) split by word.
 */
export function wholeWordEnds(text: string, from = 0): number[] {
  const ends: number[] = [];
  const pattern = new RegExp(WORD_TOKEN.source, "g");
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
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
    if (end < text.length || STREAM_SENTENCE_END.test(text[end - 1]!)) ends.push(end);
  }
  return ends;
}

/** The end of the last whole word, reading only the text's last token. */
export function lastWholeWordEnd(text: string): number {
  let start = text.length;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const tokenStart = start;
  while (start > 0 && /\s/.test(text[start - 1]!)) start--;
  return wholeWordEnds(text, tokenStart).at(-1) ?? start;
}

// Phrase: words are held until their clause ends (or six words pile up), then the clause lands
// at once. A backlog drains within PHRASE_DRAIN_MS.
const PHRASE_MAX_WORDS = 6;
const PHRASE_MS_PER_WORD = 46;
const PHRASE_DRAIN_MS = 500;
const PHRASE_DRAIN_PHRASES = 4;
/** A clause the model leaves open (a pause, a tool call) shows after this long without text. */
export const PHRASE_HOLD_MS = 350;

export interface PhraseBreak {
  /** Where the phrase ends in the text. */
  readonly end: number;
  readonly words: number;
}

export interface PhrasePace {
  /** Whole phrases shown so far. */
  readonly phrases: number;
  /** Milliseconds until the next phrase may land; at or below zero, it lands now. */
  readonly wait: number;
}

/**
 * The finished phrases of streaming `text` after `from`: each ends at clause punctuation, a line
 * break or its sixth word.
 */
export function phraseBreaks(text: string, from = 0): PhraseBreak[] {
  const breaks: PhraseBreak[] = [];
  let words = 0;
  for (const end of wholeWordEnds(text, from)) {
    words++;
    const tail = text[end - 1] ?? "";
    if (
      words >= PHRASE_MAX_WORDS ||
      STREAM_SENTENCE_END.test(tail) ||
      STREAM_CLAUSE_END.test(tail) ||
      text[end] === "\n"
    ) {
      breaks.push({ end, words });
      words = 0;
    }
  }
  return breaks;
}

/** The pace after `elapsedMs`: phrases land while the wait has run out, never past `breaks`. */
export function advancePhrasePacer(
  pace: PhrasePace,
  breaks: ReadonlyArray<PhraseBreak>,
  elapsedMs: number,
): PhrasePace {
  let phrases = Math.min(pace.phrases, breaks.length);
  let wait = Math.max(pace.wait - Math.max(0, elapsedMs), -STREAM_MAX_DEBT_MS);
  while (wait <= 0 && phrases < breaks.length) {
    const backlog = breaks.length - phrases;
    const natural = breaks[phrases]!.words * PHRASE_MS_PER_WORD;
    const drain = (PHRASE_DRAIN_MS * Math.min(1, PHRASE_DRAIN_PHRASES / backlog)) / backlog;
    phrases++;
    wait += Math.min(natural, drain);
  }
  return { phrases, wait };
}

export interface PhraseStep {
  /** How much of the text shows now; it never shrinks. */
  readonly shown: number;
  readonly wait: number;
  /** When the next phrase may land, in milliseconds; null once every finished phrase shows. */
  readonly nextInMs: number | null;
}

/**
 * One step of Phrase pacing that reads only the text not shown yet, so a long reply costs no more
 * per arrival than a short one.
 */
export function stepPhrasePacer(
  text: string,
  shown: number,
  wait: number,
  elapsedMs: number,
): PhraseStep {
  const from = Math.min(shown, text.length);
  const breaks = phraseBreaks(text, from);
  const pace = advancePhrasePacer({ phrases: 0, wait }, breaks, elapsedMs);
  const next = Math.max(from, breaks[pace.phrases - 1]?.end ?? from);
  return {
    shown: next,
    wait: pace.wait,
    nextInMs: pace.phrases < breaks.length ? Math.max(0, pace.wait) : null,
  };
}
