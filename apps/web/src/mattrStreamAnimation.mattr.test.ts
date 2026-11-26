import type { Element, Root } from "hast";
import { describe, expect, it } from "vite-plus/test";

import {
  STREAM_CARET_CLASS,
  STREAM_WORD_CLASS,
  mattrStreamHast,
  splitStreamWords,
} from "./components/chat/mattrStreamHast";
import type { MarkdownIslandOptions } from "./components/chat/markdownIslands";
import { advancePacedCursor, pacedVisibleLength } from "./mattrStreamAnimation";

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

describe("mattrStreamHast", () => {
  it("leaves finished messages exactly as parsed", () => {
    const tree = root(element("p", [text("Hello world")]));
    const [rendered, options] = mattrStreamHast(tree, baseOptions, null, true);
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
    const [rendered, options] = mattrStreamHast(tree, baseOptions, "fade", false);
    expect(words(rendered)).toEqual(["Hello", "bold", "move"]);
    const paragraph = rendered.children[0] as Element;
    const wordSpan = paragraph.children[0] as Element;
    expect(options.isIsland(wordSpan)).toBe(true);
    expect(options.isIsland(paragraph)).toBe(false);
    expect(paragraph.children[1]).toEqual(text(" "));
  });

  it("keeps settled words in the same positions as text arrives", () => {
    const first = mattrStreamHast(
      root(element("p", [text("The quick brown")])),
      baseOptions,
      "blur",
      false,
    )[0];
    const second = mattrStreamHast(
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
    expect(mattrStreamHast(tree, baseOptions, "rise", false)[0]).toBe(
      mattrStreamHast(tree, baseOptions, "rise", false)[0],
    );
  });

  it("leaves code blocks and links alone and animates inline code as one unit", () => {
    const pre = element("pre", [element("code", [text("const a = 1")])]);
    const link = element("a", [text("a link")], { href: "https://example.com" });
    const tree = root(
      element("p", [text("See "), link, text(" and "), element("code", [text("x()")])]),
      pre,
    );
    const [rendered] = mattrStreamHast(tree, baseOptions, "blur", true);
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
    const [blur] = mattrStreamHast(tree(), baseOptions, "blur", true);
    const lastItem = (blur.children[0] as Element).children[1] as Element;
    const caret = lastItem.children.at(-1) as Element;
    expect(classesOf(caret)).toContain(STREAM_CARET_CLASS);
    expect((lastItem.children.at(-2) as Element).tagName).toBe("span");

    expect(hasCaret(mattrStreamHast(tree(), baseOptions, "typewriter", true)[0])).toBe(true);
    expect(hasCaret(mattrStreamHast(tree(), baseOptions, "fade", true)[0])).toBe(false);
    expect(hasCaret(mattrStreamHast(tree(), baseOptions, "blur", false)[0])).toBe(false);
  });
});
