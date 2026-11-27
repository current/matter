import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  View: ({ children, pointerEvents }: Children & { pointerEvents?: string }) => (
    <div data-pointer-events={pointerEvents}>{children}</div>
  ),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children, numberOfLines }: Children & { numberOfLines?: number }) => (
    <span data-lines={numberOfLines}>{children}</span>
  ),
}));

import { MatterPredictionGhost } from "./MatterPredictionGhost.matter";

function render(text: string | null, onAccept = vi.fn()) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <MatterPredictionGhost
        text={text}
        editorHeight={38}
        inset={4}
        textStyle={{ fontSize: 16, lineHeight: 22 }}
        onAccept={onAccept}
      />,
    ),
  );
  return { container, root, onAccept };
}

describe("MatterPredictionGhost", () => {
  it("shows the prediction clamped to three lines, passing taps through to the editor", () => {
    const { container, root } = render("Run the tests and fix what fails");
    const text = container.querySelector("[data-lines]");
    expect(text?.textContent).toBe("Run the tests and fix what fails");
    expect(text?.getAttribute("data-lines")).toBe("3");
    expect(text?.closest("[data-pointer-events]")?.getAttribute("data-pointer-events")).toBe(
      "none",
    );
    act(() => root.unmount());
  });

  it("accepts from the Use chip", () => {
    const { container, root, onAccept } = render("Run the tests");
    const chip = container.querySelector("button");
    expect(chip?.getAttribute("aria-label")).toBe("Use suggested prompt: Run the tests");
    act(() => chip?.click());
    expect(onAccept).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("renders nothing without a prediction", () => {
    const { container, root } = render(null);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
  });
});
