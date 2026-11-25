import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

import { ComposerVoiceModeButton } from "./ComposerVoiceModeButton";

it("renders the native voice mode button and triggers onOpen on click", async () => {
  const onOpen = vi.fn();
  await using screen = await render(<ComposerVoiceModeButton onOpen={onOpen} />);

  const button = screen
    .getByRole("button", { name: "Start voice mode" })
    .element() as HTMLButtonElement;
  expect(button).toBeEnabled();

  await act(() => button.click());
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("does not trigger onOpen when disabled", async () => {
  const onOpen = vi.fn();
  await using screen = await render(<ComposerVoiceModeButton disabled onOpen={onOpen} />);

  const button = screen
    .getByRole("button", { name: "Start voice mode" })
    .element() as HTMLButtonElement;
  expect(button).toBeDisabled();

  await act(() => button.click());
  expect(onOpen).not.toHaveBeenCalled();
});
