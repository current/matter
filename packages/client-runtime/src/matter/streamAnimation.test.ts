import { describe, expect, it } from "vite-plus/test";

import {
  advancePhrasePacer,
  lastWholeWordEnd,
  MATTER_NATIVE_STREAM_ANIMATION_IDS,
  matterNativeStreamEffect,
  parseMatterNativeStreamAnimation,
  phraseBreaks,
  stepPhrasePacer,
  wholeWordEnds,
} from "./streamAnimation.ts";

describe("wholeWordEnds", () => {
  it("leaves out a trailing word that may still be arriving, unless it ends a sentence", () => {
    expect(wholeWordEnds("Hello wor")).toEqual([5]);
    expect(wholeWordEnds("Hello world.")).toEqual([5, 12]);
  });

  it("scans from an offset with the same ends as a full scan", () => {
    const text = "One two, three four five six seven. Eight";
    const full = wholeWordEnds(text);
    expect(wholeWordEnds(text, 8)).toEqual(full.filter((end) => end > 8));
  });

  it("splits space-less scripts by word", () => {
    expect(wholeWordEnds("今日は晴れです。").length).toBeGreaterThan(1);
  });
});

describe("lastWholeWordEnd", () => {
  it("matches the last of a full scan", () => {
    for (const text of ["", "Hi", "Hi there", "Hi there ", "Hi there.", "a  b  c", "今日は晴れ"]) {
      expect(lastWholeWordEnd(text)).toBe(wholeWordEnds(text).at(-1) ?? 0);
    }
  });
});

describe("phraseBreaks", () => {
  it("ends a phrase at clause punctuation, a line break or its sixth word", () => {
    expect(phraseBreaks("Hi there, friend.\nOne two three four five six seven")).toEqual([
      { end: 9, words: 2 },
      { end: 17, words: 1 },
      { end: 45, words: 6 },
    ]);
  });
});

describe("stepPhrasePacer", () => {
  const text = "First, a clause. Then another one; and a long run of words that keeps going on";

  it("releases one phrase per step at a natural pace and never shrinks", () => {
    let step = stepPhrasePacer(text, 0, 0, 0);
    expect(step.shown).toBe(6);
    expect(step.nextInMs).toBeGreaterThan(0);
    let shown = step.shown;
    while (step.nextInMs !== null) {
      step = stepPhrasePacer(text, shown, step.wait, step.nextInMs);
      expect(step.shown).toBeGreaterThan(shown);
      shown = step.shown;
    }
    expect(shown).toBe(phraseBreaks(text).at(-1)!.end);
  });

  it("drains a backlog sooner than the natural pace", () => {
    const breaks = phraseBreaks(text);
    const one = advancePhrasePacer({ phrases: 0, wait: 0 }, breaks.slice(0, 1), 0);
    const many = advancePhrasePacer({ phrases: 0, wait: 0 }, breaks, 0);
    expect(many.wait).toBeLessThanOrEqual(one.wait);
  });

  it("caps time owed, so a long stall releases only what fits in that cap, not all", () => {
    const step = stepPhrasePacer(text, 0, 0, 60_000);
    expect(step.shown).toBe(stepPhrasePacer(text, 0, 0, 100).shown);
    expect(step.shown).toBeLessThan(phraseBreaks(text).at(-1)!.end);
    expect(step.nextInMs).not.toBeNull();
  });

  it("does nothing when every finished phrase already shows", () => {
    expect(stepPhrasePacer("Done. Partial wor", 5, 0, 0)).toEqual({
      shown: 5,
      wait: 0,
      nextInMs: null,
    });
  });
});

describe("native styles", () => {
  it("falls back to Instant for a style the native app doesn't play", () => {
    expect(parseMatterNativeStreamAnimation("blur")).toBe("instant");
    expect(parseMatterNativeStreamAnimation(undefined)).toBe("instant");
    expect(parseMatterNativeStreamAnimation("phrase")).toBe("phrase");
  });

  it("maps each style to one stable effect, and Instant to none", () => {
    expect(matterNativeStreamEffect("instant")).toBeNull();
    for (const id of MATTER_NATIVE_STREAM_ANIMATION_IDS) {
      expect(matterNativeStreamEffect(id)).toBe(matterNativeStreamEffect(id));
    }
    expect(matterNativeStreamEffect("typewriter")?.smooth).toBe(true);
    expect(matterNativeStreamEffect("phrase")?.phrases).toBe(true);
  });
});
