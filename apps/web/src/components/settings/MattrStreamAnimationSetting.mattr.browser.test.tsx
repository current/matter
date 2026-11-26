import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";
import "../../../../../antimatter/stream-animation.css";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  DEFAULT_MATTR_STREAM_ANIMATION,
  MATTR_STREAM_ANIMATION_STORAGE_KEY,
  MATTR_STREAM_ANIMATIONS,
  MattrStreamAnimation,
  readEffectiveMattrStreamAnimation,
  readMattrStreamAnimation,
  useEffectiveMattrStreamAnimation,
} from "../../mattrStreamAnimation";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ children, resetAction }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
}));

import { MattrStreamAnimationSetting, previewArrivals } from "./MattrStreamAnimationSetting";

function streamMode(mode: MattrStreamAnimation): Disposable {
  setLocalStorageItem(MATTR_STREAM_ANIMATION_STORAGE_KEY, mode, MattrStreamAnimation);
  return { [Symbol.dispose]: () => localStorage.removeItem(MATTR_STREAM_ANIMATION_STORAGE_KEY) };
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

describe("streaming text animation store", () => {
  it("defaults to Instant and reads the saved mode", () => {
    expect(DEFAULT_MATTR_STREAM_ANIMATION).toBe("instant");
    expect(readMattrStreamAnimation()).toBe("instant");
    using _mode = streamMode("blur");
    expect(localStorage.getItem(MATTR_STREAM_ANIMATION_STORAGE_KEY)).toBe(JSON.stringify("blur"));
    expect(readMattrStreamAnimation()).toBe("blur");
  });

  it("falls back to Instant on a value it doesn't know", () => {
    using _mode = streamMode("blur");
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(MATTR_STREAM_ANIMATION_STORAGE_KEY, JSON.stringify("confetti"));
    expect(readMattrStreamAnimation()).toBe("instant");
    expect(consoleError).toHaveBeenCalled();
  });

  it("plays Instant under reduced motion", () => {
    using _mode = streamMode("rise");
    {
      using _motion = reduceMotion(false);
      expect(readEffectiveMattrStreamAnimation()).toBe("rise");
    }
    using _motion = reduceMotion(true);
    expect(readEffectiveMattrStreamAnimation()).toBe("instant");
  });

  it("follows changes only while a message streams", async () => {
    function Probe({ active }: { active: boolean }) {
      return (
        <output data-active={active}>{useEffectiveMattrStreamAnimation(active) ?? "none"}</output>
      );
    }
    await using screen = await render(
      <>
        <Probe active />
        <Probe active={false} />
      </>,
      { router: false },
    );
    const value = (active: boolean) =>
      screen.container.querySelector(`[data-active="${active}"]`)?.textContent;
    expect(value(true)).toBe("none");
    using _mode = streamMode("instant");
    await act(() => {
      setLocalStorageItem(MATTR_STREAM_ANIMATION_STORAGE_KEY, "fade", MattrStreamAnimation);
      // Another window's write arrives as a storage event.
      window.dispatchEvent(
        new StorageEvent("storage", { key: MATTR_STREAM_ANIMATION_STORAGE_KEY }),
      );
    });
    await expect.poll(() => value(true)).toBe("fade");
    expect(value(false)).toBe("none");
  });
});

describe("MattrStreamAnimationSetting", () => {
  it("lists all six modes and saves a pick", async () => {
    using _mode = streamMode("instant");
    await using _screen = await render(<MattrStreamAnimationSetting />, { router: false });
    const options = page.getByRole("radio");
    await expect.poll(() => options.elements().length).toBe(MATTR_STREAM_ANIMATIONS.length);
    for (const name of [
      "Instant",
      "Blur Reveal",
      "Soft Fade",
      "Rise & Settle",
      "Smooth Pace",
      "RareUI",
    ]) {
      await expect.element(page.getByRole("radio", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect.element(page.getByRole("radio", { name: /^Instant/ })).toBeChecked();

    const blur = page.getByRole("radio", { name: /^Blur Reveal/ });
    await userEvent.click(blur);
    await expect.element(blur).toBeChecked();
    expect(readMattrStreamAnimation()).toBe("blur");

    await userEvent.click(page.getByRole("button", { name: "Reset streaming text to default" }));
    expect(readMattrStreamAnimation()).toBe("instant");
  });

  it("replays the preview in the picked mode, then leaves it at rest", async () => {
    using _mode = streamMode("blur");
    await using screen = await render(<MattrStreamAnimationSetting />, { router: false });
    const live = () => screen.container.querySelector<HTMLElement>("[data-mattr-stream]");
    await expect.poll(() => live()?.dataset.mattrStream).toBe("blur");
    await expect.poll(() => live(), { timeout: 5000 }).toBeNull();
    expect(screen.container.querySelector(".mattr-sw")).toBeNull();
    expect(screen.container.querySelector(".mattr-stream-caret")).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Replay preview" }));
    await expect.poll(() => live()?.dataset.mattrStream).toBe("blur");
  });

  it("saves RareUI and previews it in bursts with no dot or caret, then rests plain", async () => {
    using _mode = streamMode("instant");
    await using screen = await render(<MattrStreamAnimationSetting />, { router: false });
    const rareui = page.getByRole("radio", { name: /^RareUI/ });
    await userEvent.click(rareui);
    await expect.element(rareui).toBeChecked();
    expect(localStorage.getItem(MATTR_STREAM_ANIMATION_STORAGE_KEY)).toBe(JSON.stringify("rareui"));

    const live = () => screen.container.querySelector<HTMLElement>("[data-mattr-stream]");
    const dot = () => screen.container.querySelector(".mattr-stream-dot");
    await expect.poll(() => live()?.dataset.mattrStream).toBe("rareui");
    await expect.poll(() => screen.container.querySelector(".mattr-sw")).not.toBeNull();
    expect(dot()).toBeNull();
    expect(screen.container.querySelector(".mattr-stream-caret")).toBeNull();
    await expect.poll(() => live(), { timeout: 10_000 }).toBeNull();
    expect(dot()).toBeNull();
    expect(screen.container.querySelector(".mattr-sw")).toBeNull();
    expect(screen.container.querySelector(".mattr-stream-caret")).toBeNull();
  });

  it("splits the sample into arrivals that end at the whole text", () => {
    const sample = "One two `three()` four five six";
    const arrivals = previewArrivals(sample);
    expect(arrivals.at(-1)).toBe(sample.length);
    expect(arrivals).toEqual([...arrivals].sort((a, b) => a - b));
  });
});
