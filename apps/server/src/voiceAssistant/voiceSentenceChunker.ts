// Abbreviations whose trailing period never ends a spoken sentence.
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "jr",
  "sr",
  "approx",
  "no",
  "fig",
  "inc",
  "ltd",
  "co",
]);

// Em and en dashes by code point.
const CLAUSE_PUNCTUATION = new Set([
  ",",
  ";",
  ":",
  String.fromCharCode(0x2014),
  String.fromCharCode(0x2013),
]);
const CLOSERS = new Set(['"', "'", ")", "]", "”", "’"]);

export interface SentenceChunkerOptions {
  /** A comma or clause break only splits once the chunk is at least this long. */
  readonly minClauseChars?: number;
  /** A chunk with no boundary is cut at the last space once it reaches this length. */
  readonly maxChars?: number;
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function endsWithAbbreviation(text: string): boolean {
  const match = /([A-Za-z][A-Za-z.]*)$/.exec(text);
  if (!match) return false;
  const word = (match[1] ?? "").toLowerCase();
  // A single letter before the period is an initial ("J. R."), not a sentence end.
  return ABBREVIATIONS.has(word) || /^[a-z]$/.test(word);
}

/**
 * Splits streamed reply text into speakable chunks so the first sentence reaches TTS while the
 * model is still writing the rest. A boundary needs the character after it, so "v2.5" and "e.g."
 * never split mid-token; `flush` releases whatever is left at the end of the stream.
 */
export function createSentenceChunker(options: SentenceChunkerOptions = {}) {
  const minClauseChars = options.minClauseChars ?? 60;
  const maxChars = options.maxChars ?? 240;
  let buffer = "";

  const take = (end: number, out: string[]) => {
    const chunk = buffer.slice(0, end).trim();
    buffer = buffer.slice(end);
    if (chunk.length > 0) out.push(chunk);
  };

  const drain = (final: boolean): string[] => {
    const out: string[] = [];
    let index = 0;
    while (index < buffer.length) {
      const char = buffer[index]!;
      if (char === "\n") {
        take(index + 1, out);
        index = 0;
        continue;
      }
      if (char === "." || char === "!" || char === "?" || CLAUSE_PUNCTUATION.has(char)) {
        let end = index + 1;
        while (end < buffer.length && (CLOSERS.has(buffer[end]!) || buffer[end] === char)) end += 1;
        if (end >= buffer.length && !final) break;
        const next = buffer[end];
        const boundary = next === undefined || isWhitespace(next);
        const clause = CLAUSE_PUNCTUATION.has(char);
        if (
          boundary &&
          (clause
            ? end >= minClauseChars
            : char !== "." || !endsWithAbbreviation(buffer.slice(0, index)))
        ) {
          take(end, out);
          index = 0;
          continue;
        }
      }
      index += 1;
    }
    if (buffer.length >= maxChars) {
      const cut = buffer.lastIndexOf(" ", maxChars);
      take(cut > 0 ? cut : maxChars, out);
      return [...out, ...drain(final)];
    }
    if (final) take(buffer.length, out);
    return out;
  };

  return {
    /** Adds streamed text and returns every chunk it completed. */
    push(delta: string): string[] {
      buffer += delta;
      return drain(false);
    },
    /** Ends the stream and returns the remaining text as chunks. */
    flush(): string[] {
      return drain(true);
    },
  };
}

export type SentenceChunker = ReturnType<typeof createSentenceChunker>;

/**
 * Reads one string field out of a JSON object while it streams, decoding escapes split across
 * deltas. `prefix` is the raw text before the field started, so callers can inspect the fields
 * the model wrote first (for example an empty `actions` array).
 */
export function createJsonStringFieldReader(field: string) {
  const opener = new RegExp(`"${field}"\\s*:\\s*"`);
  let raw = "";
  let started = false;
  let done = false;
  let prefix = "";
  let pendingEscape = "";

  const decode = (text: string): string => {
    let out = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index]!;
      if (pendingEscape.length > 0 || char === "\\") {
        pendingEscape += char;
        index += 1;
        if (pendingEscape.length === 1) continue;
        const kind = pendingEscape[1];
        if (kind === "u") {
          if (pendingEscape.length < 6) continue;
          const code = Number.parseInt(pendingEscape.slice(2), 16);
          out += Number.isNaN(code) ? "" : String.fromCharCode(code);
        } else {
          out +=
            kind === "n"
              ? "\n"
              : kind === "t"
                ? " "
                : kind === "r"
                  ? ""
                  : kind === "b" || kind === "f"
                    ? ""
                    : (kind ?? "");
        }
        pendingEscape = "";
        continue;
      }
      if (char === '"') {
        done = true;
        return out;
      }
      out += char;
      index += 1;
    }
    return out;
  };

  return {
    push(delta: string): string {
      if (done) return "";
      if (started) return decode(delta);
      raw += delta;
      const match = opener.exec(raw);
      if (!match) return "";
      started = true;
      prefix = raw.slice(0, match.index);
      return decode(raw.slice(match.index + match[0].length));
    },
    get started() {
      return started;
    },
    get done() {
      return done;
    },
    get prefix() {
      return prefix;
    },
  };
}
