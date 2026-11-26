import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";
import "../../../../../matter/stream-animation.css";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  DEFAULT_MATTER_STREAM_ANIMATION,
  MATTER_STREAM_ANIMATION_STORAGE_KEY,
  MATTER_STREAM_ANIMATIONS,
  MatterStreamAnimation,
  readEffectiveMatterStreamAnimation,
  readMatterStreamAnimation,
  useEffectiveMatterStreamAnimation,
} from "../../matterStreamAnimation";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ children, resetAction }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
}));

import { MatterStreamAnimationSetting, previewArrivals } from "./MatterStreamAnimationSetting";

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

describe("streaming text animation store", () => {
  it("defaults to Instant and reads the saved mode", () => {
    expect(DEFAULT_MATTER_STREAM_ANIMATION).toBe("instant");
    expect(readMatterStreamAnimation()).toBe("instant");
    using _mode = streamMode("blur");
    expect(localStorage.getItem(MATTER_STREAM_ANIMATION_STORAGE_KEY)).toBe(JSON.stringify("blur"));
    expect(readMatterStreamAnimation()).toBe("blur");
  });

  it("falls back to Instant on a value it doesn't know", () => {
    using _mode = streamMode("blur");
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(MATTER_STREAM_ANIMATION_STORAGE_KEY, JSON.stringify("confetti"));
    expect(readMatterStreamAnimation()).toBe("instant");
    expect(consoleError).toHaveBeenCalled();
  });

  it("plays Instant under reduced motion", () => {
    using _mode = streamMode("rise");
    {
      using _motion = reduceMotion(false);
      expect(readEffectiveMatterStreamAnimation()).toBe("rise");
    }
    using _motion = reduceMotion(true);
    expect(readEffectiveMatterStreamAnimation()).toBe("instant");
  });

  it("follows changes only while a message streams", async () => {
    function Probe({ active }: { active: boolean }) {
      return (
        <output data-active={active}>{useEffectiveMatterStreamAnimation(active) ?? "none"}</output>
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
      setLocalStorageItem(MATTER_STREAM_ANIMATION_STORAGE_KEY, "fade", MatterStreamAnimation);
      // Another window's write arrives as a storage event.
      window.dispatchEvent(
        new StorageEvent("storage", { key: MATTER_STREAM_ANIMATION_STORAGE_KEY }),
      );
    });
    await expect.poll(() => value(true)).toBe("fade");
    expect(value(false)).toBe("none");
  });
});

describe("MatterStreamAnimationSetting", () => {
  it("lists all six modes and saves a pick", async () => {
    using _mode = streamMode("instant");
    await using _screen = await render(<MatterStreamAnimationSetting />, { router: false });
    const options = page.getByRole("radio");
    await expect.poll(() => options.elements().length).toBe(MATTER_STREAM_ANIMATIONS.length);
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
    expect(readMatterStreamAnimation()).toBe("blur");

    await userEvent.click(page.getByRole("button", { name: "Reset streaming text to default" }));
    expect(readMatterStreamAnimation()).toBe("instant");
  });

  it("replays the preview in the picked mode, then leaves it at rest", async () => {
    using _mode = streamMode("blur");
    await using screen = await render(<MatterStreamAnimationSetting />, { router: false });
    const live = () => screen.container.querySelector<HTMLElement>("[data-matter-stream]");
    await expect.poll(() => live()?.dataset.matterStream).toBe("blur");
    await expect.poll(() => live(), { timeout: 5000 }).toBeNull();
    expect(screen.container.querySelector(".matter-sw")).toBeNull();
    expect(screen.container.querySelector(".matter-stream-caret")).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Replay preview" }));
    await expect.poll(() => live()?.dataset.matterStream).toBe("blur");
  });

  it("saves RareUI and previews it in bursts with no dot or caret, then rests plain", async () => {
    using _mode = streamMode("instant");
    await using screen = await render(<MatterStreamAnimationSetting />, { router: false });
    const rareui = page.getByRole("radio", { name: /^RareUI/ });
    await userEvent.click(rareui);
    await expect.element(rareui).toBeChecked();
    expect(localStorage.getItem(MATTER_STREAM_ANIMATION_STORAGE_KEY)).toBe(
      JSON.stringify("rareui"),
    );

    const live = () => screen.container.querySelector<HTMLElement>("[data-matter-stream]");
    const dot = () => screen.container.querySelector(".matter-stream-dot");
    await expect.poll(() => live()?.dataset.matterStream).toBe("rareui");
    await expect.poll(() => screen.container.querySelector(".matter-sw")).not.toBeNull();
    expect(dot()).toBeNull();
    expect(screen.container.querySelector(".matter-stream-caret")).toBeNull();
    await expect.poll(() => live(), { timeout: 10_000 }).toBeNull();
    expect(dot()).toBeNull();
    expect(screen.container.querySelector(".matter-sw")).toBeNull();
    expect(screen.container.querySelector(".matter-stream-caret")).toBeNull();
  });

  it("splits the sample into arrivals that end at the whole text", () => {
    const sample = "One two `three()` four five six";
    const arrivals = previewArrivals(sample);
    expect(arrivals.at(-1)).toBe(sample.length);
    expect(arrivals).toEqual([...arrivals].sort((a, b) => a - b));
  });
});
