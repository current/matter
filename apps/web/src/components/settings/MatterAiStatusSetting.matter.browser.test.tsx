import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import "../../index.css";
import "../../../../../matter/rareui-chat.css";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  MATTER_AI_STATUS_STYLE_STORAGE_KEY,
  MatterAiStatusStyle,
  readMatterAiStatusStyle,
} from "../../matterAiStatus";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ children, resetAction }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
}));

import { AI_STATUS_PREVIEW_STEPS, MatterAiStatusSetting } from "./MatterAiStatusSetting";

function aiStatusStyle(style: MatterAiStatusStyle): Disposable {
  setLocalStorageItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY, style, MatterAiStatusStyle);
  return { [Symbol.dispose]: () => localStorage.removeItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY) };
}

const PREVIEW_MS = AI_STATUS_PREVIEW_STEPS.reduce((total, step) => total + step.ms, 0);

describe("MatterAiStatusSetting", () => {
  it("switches between Default and RareUI and resets", async () => {
    using _style = aiStatusStyle("default");
    await using _screen = await render(<MatterAiStatusSetting />, { router: false });
    const fallback = page.getByRole("radio", { name: /^Default/ });
    const rareui = page.getByRole("radio", { name: /^RareUI/ });
    await expect.element(fallback).toBeChecked();

    await userEvent.click(rareui);
    await expect.element(rareui).toBeChecked();
    expect(readMatterAiStatusStyle()).toBe("rareui");
    expect(localStorage.getItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY)).toBe(JSON.stringify("rareui"));

    await userEvent.click(page.getByRole("button", { name: "Reset AI status to default" }));
    expect(readMatterAiStatusStyle()).toBe("default");
    await expect.element(fallback).toBeChecked();
  });

  it("plays the RareUI turn once, ends done and still, and replays", async () => {
    using _style = aiStatusStyle("rareui");
    const timers = fakeTimers();
    await using screen = await render(<MatterAiStatusSetting />, { router: false });
    const icon = () =>
      screen.container.querySelector<HTMLElement>(".matter-ais")?.dataset.matterAiStatus;
    expect(icon()).toBe("thinking");

    await act(() => vi.advanceTimersByTime(AI_STATUS_PREVIEW_STEPS[0]!.ms));
    expect(icon()).toBe("researching");
    expect(screen.container.textContent).toContain("Searching");

    await act(() => vi.advanceTimersByTime(PREVIEW_MS));
    expect(icon()).toBe("done");
    expect(screen.container.textContent).toMatch(/Worked for \d+s/);
    expect(vi.getTimerCount()).toBe(0);
    const looping = screen.container
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity);
    expect(looping).toEqual([]);

    timers[Symbol.dispose]();
    await userEvent.click(page.getByRole("button", { name: "Replay preview" }));
    await expect.poll(icon).toBe("thinking");
  });

  it("previews upstream's working timer for Default", async () => {
    using _style = aiStatusStyle("default");
    using _timers = fakeTimers();
    await using screen = await render(<MatterAiStatusSetting />, { router: false });
    const preview = () =>
      screen.container.querySelector('[data-matter-ai-status-preview="default"]')?.firstChild
        ?.textContent;
    expect(preview()).toBe("Working for 0s");
    await act(() => vi.advanceTimersByTime(2000));
    expect(preview()).toBe("Working for 2s");
    await act(() => vi.advanceTimersByTime(PREVIEW_MS));
    expect(preview()).toMatch(/^Worked for \d+s$/);
    expect(screen.container.querySelector(".matter-ais")).toBeNull();
  });
});
