import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const reduceMotion = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../../lib/appState", () => ({
  subscribeReduceMotion: () => () => {},
  readReduceMotionEnabled: () => reduceMotion.enabled,
}));
vi.mock("expo-file-system", () => {
  throw new Error("no file system in tests");
});

import {
  MatterStreamingTextScope,
  useMatterStreamingMarkdown,
  type MatterStreamingMarkdownProps,
} from "./MatterStreamingText.matter";
import { setMatterStreamAnimation } from "./matterStreamAnimationStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renders: MatterStreamingMarkdownProps[] = [];

function Probe(props: { readonly markdown: string }) {
  renders.push(useMatterStreamingMarkdown(props.markdown));
  return null;
}

let root: Root;
let container: HTMLDivElement;

function show(markdown: string, streaming: boolean | null) {
  act(() => {
    root.render(
      streaming === null ? (
        <Probe markdown={markdown} />
      ) : (
        <MatterStreamingTextScope streaming={streaming}>
          <Probe markdown={markdown} />
        </MatterStreamingTextScope>
      ),
    );
  });
  return renders.at(-1)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  reduceMotion.enabled = false;
  renders.length = 0;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  setMatterStreamAnimation("instant");
  vi.useRealTimers();
});

describe("useMatterStreamingMarkdown", () => {
  it("adds nothing outside a streaming message, for Instant, or under Reduce Motion", () => {
    setMatterStreamAnimation("fade");
    expect(show("Hello", null)).toEqual({});
    expect(show("Hello", false)).toEqual({});
    reduceMotion.enabled = true;
    expect(show("Hello there", true)).toEqual({});
    reduceMotion.enabled = false;
    setMatterStreamAnimation("instant");
    expect(show("Hello there again", true)).toEqual({});
  });

  it("draws the text it mounts with unanimated, then fades only later words", () => {
    setMatterStreamAnimation("fade");
    show("Already here", true);
    expect(renders.at(-1)).toMatchObject({
      markdown: "Already here",
      streaming: true,
      streamingConfig: { animation: "none", smooth: false },
    });
    act(() => vi.advanceTimersByTime(32));
    expect(renders.at(-1)?.streamingConfig).toEqual({
      animation: { type: "fade", duration: 180 },
      smooth: false,
    });
    const config = renders.at(-1)?.streamingConfig;
    expect(show("Already here and more", true).streamingConfig).toBe(config);
  });

  it("asks the native view to pace Smooth Pace, and drops every prop when streaming ends", () => {
    setMatterStreamAnimation("typewriter");
    show("Some text", true);
    act(() => vi.advanceTimersByTime(32));
    expect(renders.at(-1)?.streamingConfig).toEqual({
      animation: { type: "fade", duration: 120 },
      smooth: true,
    });
    expect(show("Some text, finished.", false)).toEqual({});
  });

  it("releases Phrase text a clause at a time without replaying what was there", () => {
    setMatterStreamAnimation("phrase");
    expect(show("Opened mid reply", true).markdown).toBe("Opened mid");

    const markdown = "Opened mid reply, then a clause; and the next one arrives.";
    show(markdown, true);
    expect(renders.at(-1)?.markdown).toBe("Opened mid reply,");
    for (let ms = 0; ms < 1_000; ms += 10) act(() => vi.advanceTimersByTime(10));
    expect(renders.at(-1)?.markdown).toBe(markdown);

    const shown = [...new Set(renders.map((render) => render.markdown))];
    expect(shown).toEqual([
      "Opened mid",
      "Opened mid reply,",
      "Opened mid reply, then a clause;",
      markdown,
    ]);
  });

  it("shows a clause left open after a pause, and the whole text once streaming ends", () => {
    setMatterStreamAnimation("phrase");
    show("Start.", true);
    show("Start. Then a long pause wh", true);
    act(() => vi.advanceTimersByTime(1_000));
    expect(renders.at(-1)?.markdown).toBe("Start. Then a long pause");
    expect(show("Start. Then a long pause wh", false)).toEqual({});
  });
});
