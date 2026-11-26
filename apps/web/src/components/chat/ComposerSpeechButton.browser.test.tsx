import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

import { ComposerSpeechButton } from "./ComposerSpeechButton";

const settings = vi.hoisted(() => ({ mode: "auto" as "hold" | "auto" | "toggle" }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));

const idle = { phase: "idle" as const, error: null, errorAction: null };

async function renderButton(mode: typeof settings.mode) {
  settings.mode = mode;
  const started = Promise.resolve();
  const onStart = vi.fn(() => started);
  const onStop = vi.fn();
  const screen = await render(
    <ComposerSpeechButton state={idle} onStart={onStart} onStop={onStop} />,
  );
  const button = screen.getByRole("button", { name: "Start voice input" }).element();
  if (!(button instanceof HTMLButtonElement)) throw new Error("expected the mic button");
  const press = () =>
    act(() =>
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
        }),
      ),
    );
  const release = () => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  return { screen, button, onStart, onStop, started, press, release };
}

it.each([
  { mode: "auto", heldMs: 300, stops: 1 },
  { mode: "auto", heldMs: 299, stops: 0 },
  { mode: "hold", heldMs: 0, stops: 1 },
  { mode: "toggle", heldMs: 2_000, stops: 0 },
] as const)(
  "starts on press and finishes a $mode press released after $heldMs ms accordingly",
  async ({ mode, heldMs, stops }) => {
    using clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const { screen, onStart, onStop, started, press, release } = await renderButton(mode);
    await using _screen = screen;
    await press();
    expect(onStart).toHaveBeenCalledOnce();
    clock.mockReturnValue(heldMs);
    release();
    await started;
    expect(onStop).toHaveBeenCalledTimes(stops);
  },
);

it("keeps the composer focused and does not restart on the click that follows a press", async () => {
  const { screen, button, onStart, press, release } = await renderButton("auto");
  await using _screen = screen;
  await press();
  release();
  await act(() =>
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })),
  );
  expect(onStart).toHaveBeenCalledOnce();
  const pointerDown = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerId: 2,
  });
  button.dispatchEvent(pointerDown);
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2 }));
  expect(pointerDown.defaultPrevented).toBe(true);
});

it("starts from keyboard activation, which has no pointer press", async () => {
  const { screen, button, onStart, onStop } = await renderButton("auto");
  await using _screen = screen;
  await act(() => button.click());
  expect(onStart).toHaveBeenCalledOnce();
  expect(onStop).not.toHaveBeenCalled();
});

it("treats a canceled pointer as a release", async () => {
  using clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const { screen, onStop, started, press } = await renderButton("auto");
  await using _screen = screen;
  await press();
  clock.mockReturnValue(500);
  window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
  await started;
  expect(onStop).toHaveBeenCalledOnce();
});
