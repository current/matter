/**
 * Speech-verified barge-in, after LiveKit Agents' interruption handling: a sound while the
 * assistant talks only pauses the reply, and the reply is cancelled once real words confirm it.
 * When nothing confirms it in time (a car door, a cough, a road bump) the reply resumes where it
 * paused. Time is passed in so every rule is deterministic to test.
 */
export interface InterruptionGuardConfig {
  /** Transcribed words that confirm an interruption. */
  readonly minInterruptionWords: number;
  /** A pause with no confirmation for this long resumes the reply. */
  readonly falseInterruptionTimeoutMs: number;
  /** Without a transcript, voiced energy must last this long to count as speech. */
  readonly minSustainedSpeechMs: number;
  /** Quieter readings shorter than this (between syllables) do not break a voiced run. */
  readonly maxSpeechGapMs: number;
}

export const DEFAULT_INTERRUPTION_GUARD: InterruptionGuardConfig = {
  minInterruptionWords: 2,
  falseInterruptionTimeoutMs: 900,
  minSustainedSpeechMs: 420,
  maxSpeechGapMs: 140,
};

/** One of these alone is enough to interrupt. */
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "stop",
  "wait",
  "hold",
  "cancel",
  "pause",
  "hey",
  "quiet",
  "enough",
  "shush",
]);

export function interruptionWords(transcript: string): ReadonlyArray<string> {
  return transcript.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** Whether a transcript heard over the reply is a person talking to the assistant. */
export function confirmsInterruption(
  transcript: string,
  config: InterruptionGuardConfig = DEFAULT_INTERRUPTION_GUARD,
): boolean {
  const words = interruptionWords(transcript);
  return (
    words.length >= config.minInterruptionWords || words.some((word) => COMMAND_WORDS.has(word))
  );
}

/**
 * - `pause`: something may be speech; hold the reply.
 * - `resume`: it was not; continue the reply from where it paused.
 * - `interrupt`: confirmed speech; cancel the reply and keep listening to the user.
 */
export type InterruptionDecision = "none" | "pause" | "resume" | "interrupt";

export type InterruptionGuardState = "idle" | "pending" | "interrupted";

/**
 * `transcript` mode trusts streaming recognition (Deepgram Flux): only words interrupt.
 * `energy` mode is the local-VAD fallback: only a sustained voiced run interrupts, so a short
 * percussive transient never does.
 */
export function createInterruptionGuard(
  mode: "transcript" | "energy",
  config: InterruptionGuardConfig = DEFAULT_INTERRUPTION_GUARD,
) {
  let state: InterruptionGuardState = "idle";
  let lastActivityAt = 0;
  let runStartedAt: number | null = null;
  let lastVoicedAt = 0;

  const begin = (now: number): InterruptionDecision => {
    lastActivityAt = now;
    if (state !== "idle") return "none";
    state = "pending";
    return "pause";
  };
  const confirm = (): InterruptionDecision => {
    state = "interrupted";
    return "interrupt";
  };

  return {
    get state() {
      return state;
    },

    /** Speech onset: Flux `StartOfTurn`, or the local detector's onset. */
    speechStart(now: number): InterruptionDecision {
      if (state === "interrupted") return "none";
      return begin(now);
    },

    /** The words heard so far in the current turn. */
    transcript(text: string, now: number): InterruptionDecision {
      if (state === "interrupted") return "none";
      if (confirmsInterruption(text, config)) return confirm();
      return interruptionWords(text).length > 0 ? begin(now) : "none";
    },

    /** One microphone reading in `energy` mode; `voiced` means above the speech floor. */
    level(voiced: boolean, now: number): InterruptionDecision {
      if (mode !== "energy" || state === "interrupted") return "none";
      if (!voiced) {
        if (runStartedAt !== null && now - lastVoicedAt > config.maxSpeechGapMs) {
          runStartedAt = null;
        }
        return "none";
      }
      const decision = begin(now);
      if (runStartedAt === null || now - lastVoicedAt > config.maxSpeechGapMs) runStartedAt = now;
      lastVoicedAt = now;
      if (now - runStartedAt >= config.minSustainedSpeechMs) return confirm();
      return decision;
    },

    /** Call on a timer while pending; resumes once nothing confirmed the pause in time. */
    tick(now: number): InterruptionDecision {
      if (state !== "pending" || now - lastActivityAt < config.falseInterruptionTimeoutMs) {
        return "none";
      }
      state = "idle";
      runStartedAt = null;
      return "resume";
    },

    /** Forget everything (a new reply started). */
    reset() {
      state = "idle";
      runStartedAt = null;
    },
  };
}

export type InterruptionGuard = ReturnType<typeof createInterruptionGuard>;
