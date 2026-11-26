import type { Element, Root } from "hast";
import { describe, expect, it } from "vite-plus/test";

import {
  STREAM_CARET_CLASS,
  STREAM_WORD_CLASS,
  matterStreamHast,
  splitStreamWords,
} from "./components/chat/matterStreamHast";
import type { MarkdownIslandOptions } from "./components/chat/markdownIslands";
import * as Schema from "effect/Schema";

import {
  type BurstPace,
  MatterStreamAnimation,
  advanceBurstPacer,
  advancePacedCursor,
  pacedVisibleLength,
  wholeWordEnds,
} from "./matterStreamAnimation";

const text = (value: string) => ({ type: "text" as const, value });
const element = (tagName: string, children: Element["children"], properties = {}): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});
const root = (...children: Root["children"]): Root => ({ type: "root", children });

const baseOptions: MarkdownIslandOptions = {
  components: {},
  variant: "0",
  isIsland: (node) => node.tagName === "pre" || node.tagName === "a",
  staticElement: (node) => node,
};

function classesOf(node: Element): string[] {
  const className = node.properties.className;
  return Array.isArray(className) ? className.map(String) : [];
}

function words(node: Root | Element): string[] {
  const found: string[] = [];
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (classesOf(child).includes(STREAM_WORD_CLASS)) {
      found.push(
        child.children.map((inner) => (inner.type === "text" ? inner.value : "")).join(""),
      );
    } else {
      found.push(...words(child));
    }
  }
  return found;
}

function hasCaret(node: Root | Element): boolean {
  return node.children.some(
    (child) =>
      child.type === "element" &&
      (classesOf(child).includes(STREAM_CARET_CLASS) || hasCaret(child)),
  );
}

describe("Smooth Pace cursor", () => {
  it("chases the arrived text faster the further behind it is, and never passes it", () => {
    const small = advancePacedCursor(0, 20, 16) - 0;
    const burst = advancePacedCursor(0, 2000, 16) - 0;
    expect(burst).toBeGreaterThan(small * 10);
    expect(advancePacedCursor(0, 20, 10_000)).toBe(20);
    expect(advancePacedCursor(30, 20, 16)).toBe(20);
  });

  it("drains a burst within half a second of frames", () => {
    let cursor = 0;
    let elapsed = 0;
    while (cursor < 600 && elapsed < 2000) {
      cursor = advancePacedCursor(cursor, 600, 16);
      elapsed += 16;
    }
    expect(elapsed).toBeLessThan(1000);
  });

  it("shows whole words only", () => {
    const sample = "Hello brave new world";
    expect(pacedVisibleLength(sample, 0)).toBe(0);
    expect(pacedVisibleLength(sample, 2)).toBe("Hello".length);
    expect(pacedVisibleLength(sample, 7.4)).toBe("Hello brave".length);
    expect(pacedVisibleLength(sample, 99)).toBe(sample.length);
  });
});

const isStreamAnimation = Schema.is(MatterStreamAnimation);

/** A repeatable random source: a small linear congruential generator. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Steps the burst pacer frame by frame and records each chunk it lands. */
function landings(text: string, frames: number, random: () => number, frameMs = 16) {
  const ends = wholeWordEnds(text);
  let pace: BurstPace = { words: 0, wait: 0 };
  const chunks: Array<{ words: number; at: number }> = [];
  for (let frame = 1; frame <= frames && pace.words < ends.length; frame++) {
    const next = advanceBurstPacer(pace, text, ends, frameMs, random);
    if (next.words > pace.words)
      chunks.push({ words: next.words - pace.words, at: frame * frameMs });
    pace = next;
  }
  return { ends, chunks, pace };
}

describe("RareUI burst pacer", () => {
  it("is a saved streaming text mode", () => {
    expect(isStreamAnimation("rareui")).toBe(true);
  });

  it("counts whole words only, and a last word once it ends a sentence", () => {
    expect(wholeWordEnds("Hello brave wor")).toEqual([5, 11]);
    expect(wholeWordEnds("Hello brave world ")).toEqual([5, 11, 17]);
    expect(wholeWordEnds("Hello brave world.")).toEqual([5, 11, 18]);
    expect(wholeWordEnds("")).toEqual([]);
    const cjk = wholeWordEnds("日本語のテストを実行します。");
    expect(cjk.length).toBeGreaterThan(1);
    expect(cjk.at(-1)).toBe("日本語のテストを実行します。".length);
  });

  it("lands uneven chunks of whole words after uneven gaps", () => {
    const text = `${Array.from({ length: 12 }, (_, index) => `word${index}`).join(" ")} `;
    const { ends, chunks } = landings(text, 2000, seeded(7));
    expect(chunks.reduce((sum, chunk) => sum + chunk.words, 0)).toBe(ends.length);
    expect(new Set(chunks.map((chunk) => chunk.words)).size).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.words))).toBeLessThanOrEqual(3);
    const gaps = chunks.slice(1).map((chunk, index) => chunk.at - chunks[index]!.at);
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it("pauses longer after a sentence than a clause, and longer after a clause than a word", () => {
    const ends = [3];
    const text = (tail: string) => `abc${tail} next`;
    const wait = (tail: string) =>
      advanceBurstPacer({ words: 0, wait: 0 }, text(tail), [ends[0]! + tail.length], 0, () => 0)
        .wait;
    expect(wait(".")).toBeGreaterThan(wait(","));
    expect(wait(",")).toBeGreaterThan(wait(""));
    expect(wait(".") - wait("")).toBeCloseTo(240);
  });

  it("catches up on a large backlog in bigger, quicker chunks", () => {
    const text = `${Array.from({ length: 400 }, (_, index) => `w${index}`).join(" ")} `;
    const fast = landings(text, 100_000, seeded(3));
    expect(fast.pace.words).toBe(400);
    expect(fast.chunks[0]!.words).toBeGreaterThan(3);
    // 400 words at 8 a second would take 50s; the backlog drains far faster.
    expect(fast.chunks.at(-1)!.at).toBeLessThan(20_000);
  });

  it("trails fast steady output by a few words, not a paragraph", () => {
    for (const wordsPerSecond of [30, 60, 100]) {
      const random = seeded(wordsPerSecond);
      const all = `${Array.from({ length: 1200 }, (_, index) => `w${index}`).join(" ")} `;
      let pace: BurstPace = { words: 0, wait: 0 };
      let worst = 0;
      for (let frame = 1; frame <= 600; frame++) {
        const arrived = Math.min(1200, Math.floor((frame * 16 * wordsPerSecond) / 1000));
        const text = `${all.split(" ").slice(0, arrived).join(" ")} `;
        const ends = wholeWordEnds(text);
        pace = advanceBurstPacer(pace, text, ends, 16, random);
        if (frame > 120) worst = Math.max(worst, ends.length - pace.words);
      }
      expect(worst).toBeLessThanOrEqual(25);
    }
  });

  it("never passes the arrived text and holds a word that is still arriving", () => {
    const text = "One two thr";
    const ends = wholeWordEnds(text);
    let pace: BurstPace = { words: 0, wait: 0 };
    for (let frame = 0; frame < 500; frame++) {
      pace = advanceBurstPacer(pace, text, ends, 16, seeded(frame));
      expect(ends[pace.words - 1] ?? 0).toBeLessThanOrEqual(text.length);
    }
    expect(pace.words).toBe(2);
    expect(text.slice(0, ends[pace.words - 1])).toBe("One two");
    // Fewer words than it had (a replaced message) clamps rather than overruns.
    expect(advanceBurstPacer({ words: 9, wait: 50 }, text, ends, 16, Math.random).words).toBe(2);
  });

  it("caps time owed after a stall, so a hidden tab releases one chunk rather than all", () => {
    const text = `${Array.from({ length: 30 }, (_, index) => `w${index}`).join(" ")} `;
    const ends = wholeWordEnds(text);
    const after = advanceBurstPacer({ words: 0, wait: 100 }, text, ends, 60_000, () => 0.5);
    expect(after.words).toBeLessThan(ends.length);
  });
});

describe("matterStreamHast", () => {
  it("leaves finished messages exactly as parsed", () => {
    const tree = root(element("p", [text("Hello world")]));
    const [rendered, options] = matterStreamHast(tree, baseOptions, null, true);
    expect(rendered).toBe(tree);
    expect(options).toBe(baseOptions);
  });

  it("splits prose into word spans with space kept between them", () => {
    expect(splitStreamWords(" Hello  brave\nworld ")).toEqual([
      " ",
      "Hello",
      "  ",
      "brave",
      "\n",
      "world",
      " ",
    ]);
    const tree = root(element("p", [text("Hello "), element("strong", [text("bold move")])]));
    const [rendered, options] = matterStreamHast(tree, baseOptions, "fade", false);
    expect(words(rendered)).toEqual(["Hello", "bold", "move"]);
    const paragraph = rendered.children[0] as Element;
    const wordSpan = paragraph.children[0] as Element;
    expect(options.isIsland(wordSpan)).toBe(true);
    expect(options.isIsland(paragraph)).toBe(false);
    expect(paragraph.children[1]).toEqual(text(" "));
  });

  it("keeps settled words in the same positions as text arrives", () => {
    const first = matterStreamHast(
      root(element("p", [text("The quick brown")])),
      baseOptions,
      "blur",
      false,
    )[0];
    const second = matterStreamHast(
      root(element("p", [text("The quick brown fox jumps")])),
      baseOptions,
      "blur",
      false,
    )[0];
    const before = (first.children[0] as Element).children;
    const after = (second.children[0] as Element).children;
    // React keys these children by index: same index and tag keeps the mounted span.
    before.forEach((child, index) => {
      expect(after[index]?.type).toBe(child.type);
      if (child.type === "element") expect((after[index] as Element).tagName).toBe(child.tagName);
    });
    expect(words(second).slice(0, words(first).length)).toEqual(words(first));
  });

  it("returns the same rebuilt tree for an unchanged block", () => {
    const tree = root(element("p", [text("Stable block")]));
    expect(matterStreamHast(tree, baseOptions, "rise", false)[0]).toBe(
      matterStreamHast(tree, baseOptions, "rise", false)[0],
    );
  });

  it("leaves code blocks and links alone and animates inline code as one unit", () => {
    const pre = element("pre", [element("code", [text("const a = 1")])]);
    const link = element("a", [text("a link")], { href: "https://example.com" });
    const tree = root(
      element("p", [text("See "), link, text(" and "), element("code", [text("x()")])]),
      pre,
    );
    const [rendered] = matterStreamHast(tree, baseOptions, "blur", true);
    const paragraph = rendered.children[0] as Element;
    expect(paragraph.children).toContain(link);
    const code = paragraph.children.find(
      (child): child is Element => child.type === "element" && child.tagName === "code",
    );
    expect(code && classesOf(code)).toContain(STREAM_WORD_CLASS);
    expect(rendered.children[1]).toBe(pre);
    // The text ends in a code block, so there is no line for the caret to ride.
    expect(hasCaret(rendered)).toBe(false);
  });

  it("rides the caret after the last word of the live block, for Blur and Smooth Pace only", () => {
    const tree = () =>
      root(element("ul", [element("li", [text("one")]), element("li", [text("two  ")])]));
    const [blur] = matterStreamHast(tree(), baseOptions, "blur", true);
    const lastItem = (blur.children[0] as Element).children[1] as Element;
    const caret = lastItem.children.at(-1) as Element;
    expect(classesOf(caret)).toContain(STREAM_CARET_CLASS);
    expect((lastItem.children.at(-2) as Element).tagName).toBe("span");

    expect(hasCaret(matterStreamHast(tree(), baseOptions, "typewriter", true)[0])).toBe(true);
    expect(hasCaret(matterStreamHast(tree(), baseOptions, "fade", true)[0])).toBe(false);
    expect(hasCaret(matterStreamHast(tree(), baseOptions, "blur", false)[0])).toBe(false);
  });

  it("ends RareUI's live block on its last word, with no dot or caret", () => {
    const tree = root(element("p", [text("No dot")]));
    const [rendered, options] = matterStreamHast(tree, baseOptions, "rareui", true);
    const paragraph = rendered.children[0] as Element;
    const last = paragraph.children.at(-1) as Element;
    expect(classesOf(last)).toContain(STREAM_WORD_CLASS);
    expect(last.children).toEqual([text("dot")]);
    expect(hasCaret(rendered)).toBe(false);
    expect(options.components).toBe(baseOptions.components);
    // Same options object per base, so rendered blocks stay cached.
    expect(matterStreamHast(tree, baseOptions, "rareui", true)[1]).toBe(options);
  });
});
