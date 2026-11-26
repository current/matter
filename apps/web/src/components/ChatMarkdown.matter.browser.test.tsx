import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import "../index.css";
import "../../../../matter/stream-animation.css";

import { STREAM_CARET_CLASS, STREAM_WORD_CLASS } from "./chat/matterStreamHast";
import { setLocalStorageItem } from "../hooks/useLocalStorage";
import {
  MATTER_STREAM_ANIMATION_STORAGE_KEY,
  MatterStreamAnimation,
} from "../matterStreamAnimation";

import ChatMarkdown from "./ChatMarkdown";

function message(text: string, isStreaming: boolean) {
  return <ChatMarkdown cwd="/tmp/project" text={text} isStreaming={isStreaming} />;
}

const words = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(`.${STREAM_WORD_CLASS}`));
const caret = (container: HTMLElement) => container.querySelector(`.${STREAM_CARET_CLASS}`);
const markdownRoot = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".chat-markdown")!;
const entrances = (root: HTMLElement) =>
  root
    .getAnimations({ subtree: true })
    .filter(
      (animation) =>
        !(animation.effect as KeyframeEffect | null)?.target?.classList.contains(
          STREAM_CARET_CLASS,
        ),
    );

function streamMode(mode: MatterStreamAnimation): Disposable {
  setLocalStorageItem(MATTER_STREAM_ANIMATION_STORAGE_KEY, mode, MatterStreamAnimation);
  return { [Symbol.dispose]: () => localStorage.removeItem(MATTER_STREAM_ANIMATION_STORAGE_KEY) };
}

function reduceMotion(matches: boolean): Disposable {
  const real = window.matchMedia.bind(window);
  const spy = vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "(prefers-reduced-motion: reduce)"
      ? ({
          matches,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        } as unknown as MediaQueryList)
      : real(query),
  );
  return { [Symbol.dispose]: () => spy.mockRestore() };
}

describe("ChatMarkdown streaming text animation", () => {
  it("animates each new word once and keeps settled words mounted", async () => {
    using _mode = streamMode("blur");
    await using screen = await render(message("The quick brown", true));
    const { container, rerender } = screen;
    expect(markdownRoot(container).dataset.matterStream).toBe("blur");
    const settled = words(container);
    expect(settled.map((node) => node.textContent)).toEqual(["The", "quick", "brown"]);
    expect(caret(container)).not.toBeNull();

    await rerender(message("The quick brown fox jumps", true));
    const next = words(container);
    expect(next.map((node) => node.textContent)).toEqual(["The", "quick", "brown", "fox", "jumps"]);
    // Same DOM nodes: their animation already ran and does not start again.
    settled.forEach((node, index) => expect(next[index]).toBe(node));
    expect(getComputedStyle(next[4]!).animationName).toBe("matter-stream-blur");

    await rerender(message("The quick brown fox jumps.\n\nA second paragraph", true));
    words(container)
      .slice(0, 5)
      .forEach((node, index) => expect(node).toBe(next[index]));
    // The caret rides only the live paragraph.
    expect(caret(container)?.parentElement?.textContent).toContain("second paragraph");
    expect(container.querySelectorAll(`.${STREAM_CARET_CLASS}`)).toHaveLength(1);
  });

  it.each(["instant", "blur", "fade", "rise", "typewriter"] as const)(
    "%s: opening a running thread shows its streaming message without replaying it",
    async (mode) => {
      using _mode = streamMode(mode);
      const arrived = "Words that arrived before this thread was opened";
      // The app turns panel animations off for the first frames of a navigation.
      const opening = (text: string, navigating: boolean) => (
        <div data-panel-animations={navigating ? "false" : "true"}>{message(text, true)}</div>
      );
      await using screen = await render(opening(arrived, true));
      const { container, rerender } = screen;
      expect(container.textContent).toContain(arrived);
      // Neither the words nor their blocks fade, blur or rise in again; the caret may breathe.
      expect(entrances(markdownRoot(container))).toEqual([]);
      for (const node of [...words(container), ...markdownRoot(container).children]) {
        expect(getComputedStyle(node).opacity).toBe("1");
      }

      if (mode === "instant" || mode === "typewriter") return;
      await rerender(opening(`${arrived} and then more`, false));
      const fresh = words(container).at(-1)!;
      expect(fresh.textContent).toBe("more");
      expect(fresh.getAnimations()).not.toEqual([]);
    },
  );

  it("animates a message that starts streaming in the open thread from its first words", async () => {
    using _mode = streamMode("blur");
    await using screen = await render(
      <div data-panel-animations="true">{message("Hello there", true)}</div>,
    );
    for (const node of words(screen.container)) expect(node.getAnimations()).not.toEqual([]);
  });

  it("keeps markdown formatting while streaming", async () => {
    using _mode = streamMode("fade");
    await using screen = await render(
      message("Some **bold words** and `inline()` code\n\n- first item\n- second", true),
    );
    const { container } = screen;
    expect(container.querySelector("strong")?.textContent).toBe("bold words");
    expect(container.querySelector("strong .matter-sw")).not.toBeNull();
    expect(container.querySelector("code")?.classList.contains(STREAM_WORD_CLASS)).toBe(true);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    // Soft Fade has no caret.
    expect(caret(container)).toBeNull();
  });

  it("renders finished messages with no spans, caret or stream mode", async () => {
    using _mode = streamMode("blur");
    await using screen = await render(message("Done streaming now", true));
    const { container, rerender } = screen;
    expect(words(container).length).toBeGreaterThan(0);
    await rerender(message("Done streaming now", false));
    expect(words(container)).toHaveLength(0);
    expect(caret(container)).toBeNull();
    expect(markdownRoot(container).dataset.matterStream).toBeUndefined();
    expect(container.textContent).toContain("Done streaming now");
  });

  it("adds nothing in Instant mode", async () => {
    await using screen = await render(message("Plain streaming text", true));
    expect(words(screen.container)).toHaveLength(0);
    expect(caret(screen.container)).toBeNull();
    expect(markdownRoot(screen.container).dataset.matterStream).toBeUndefined();
  });

  it("plays Instant while the system asks for reduced motion", async () => {
    using _mode = streamMode("rise");
    using _motion = reduceMotion(true);
    await using screen = await render(message("Calm streaming text", true));
    expect(words(screen.container)).toHaveLength(0);
    expect(markdownRoot(screen.container).dataset.matterStream).toBeUndefined();
  });

  it("Smooth Pace trails a burst, then snaps to the full text when the stream ends", async () => {
    using _mode = streamMode("typewriter");
    await using screen = await render(message("", true));
    const { container, rerender } = screen;
    const burst = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
    await rerender(message(burst, true));
    expect(container.textContent?.length ?? 0).toBeLessThan(burst.length);
    await expect.poll(() => words(container).length).toBeGreaterThan(0);

    await rerender(message(burst, false));
    expect(container.textContent).toContain("word119");
    expect(words(container)).toHaveLength(0);
    expect(caret(container)).toBeNull();
  });

  it("segments CJK prose into individual animated words and keeps settled segments mounted", async () => {
    using _mode = streamMode("blur");
    await using screen = await render(message("日本語のテスト", true));
    const { container, rerender } = screen;
    const settled = words(container);
    expect(settled.length).toBeGreaterThan(1);
    expect(settled.map((node) => node.textContent).join("")).toBe("日本語のテスト");

    await rerender(message("日本語のテストを実行します", true));
    const next = words(container);
    expect(next.length).toBeGreaterThan(settled.length);
    settled.forEach((node, index) => expect(next[index]).toBe(node));
  });

  it("keeps strikethrough spans inline under Rise & Settle so line-through paints while streaming", async () => {
    using _mode = streamMode("rise");
    await using screen = await render(message("Keep ~~old code~~ now", true));
    const struckWord = screen.container.querySelector<HTMLElement>(`del .${STREAM_WORD_CLASS}`);
    expect(struckWord).not.toBeNull();
    expect(getComputedStyle(struckWord!).display).toBe("inline");
  });

  describe("RareUI", () => {
    const dots = (container: HTMLElement) =>
      container.querySelectorAll<HTMLElement>(".matter-stream-dot");

    it("lands words in bursts with no dot or caret, keeping settled words mounted", async () => {
      using _mode = streamMode("rareui");
      await using screen = await render(message("The quick brown ", true));
      const { container, rerender } = screen;
      expect(markdownRoot(container).dataset.matterStream).toBe("rareui");
      const settled = words(container);
      expect(settled.map((node) => node.textContent)).toEqual(["The", "quick", "brown"]);
      expect(dots(container)).toHaveLength(0);
      expect(caret(container)).toBeNull();
      const names = getComputedStyle(settled[0]!).animationName;
      expect(names).toBe("matter-stream-sharpen, matter-stream-fade");

      await rerender(message("The quick brown fox jumps over the lazy dog and keeps going ", true));
      // Words arrive paced, not all at once.
      expect(words(container).length).toBeLessThan(12);
      await expect.poll(() => words(container).length, { timeout: 5000 }).toBe(12);
      const next = words(container);
      settled.forEach((node, index) => expect(next[index]).toBe(node));
      expect(dots(container)).toHaveLength(0);
      expect(caret(container)).toBeNull();

      await rerender(message("The quick brown fox jumps over the lazy dog and keeps going", false));
      expect(words(container)).toHaveLength(0);
      expect(dots(container)).toHaveLength(0);
      expect(markdownRoot(container).dataset.matterStream).toBeUndefined();
    });

    it("never shows half a word, then snaps to the full text when the stream ends", async () => {
      using _mode = streamMode("rareui");
      await using screen = await render(message("Whole words onl", true));
      const { container, rerender } = screen;
      await expect.poll(() => words(container).length).toBe(2);
      expect(container.textContent).not.toContain("onl");

      await rerender(message("Whole words only", false));
      expect(container.textContent).toContain("Whole words only");
      expect(words(container)).toHaveLength(0);
    });

    it("keeps links, inline code and code blocks rendering while streaming", async () => {
      using _mode = streamMode("rareui");
      await using screen = await render(
        message(
          "See [the docs](https://example.com) and `inline()` code.\n\n```ts\nconst a = 1;\n```\n\nAfter the block ",
          true,
        ),
      );
      const { container } = screen;
      const link = container.querySelector("a");
      expect(link?.textContent).toBe("the docs");
      expect(link?.getAttribute("href")).toBe("https://example.com");
      expect(
        Array.from(container.querySelectorAll("code")).some(
          (code) => code.textContent === "inline()" && code.classList.contains(STREAM_WORD_CLASS),
        ),
      ).toBe(true);
      expect(container.querySelector("pre")?.textContent).toContain("const a = 1;");
      expect(container.textContent).toContain("After the block");
      expect(dots(container)).toHaveLength(0);
      expect(caret(container)).toBeNull();
    });

    it("renders a finished message with no word spans and no dot", async () => {
      using _mode = streamMode("rareui");
      await using screen = await render(message("Finished reply, nothing moving.", false));
      expect(words(screen.container)).toHaveLength(0);
      expect(dots(screen.container)).toHaveLength(0);
      expect(markdownRoot(screen.container).dataset.matterStream).toBeUndefined();
    });
  });
});
