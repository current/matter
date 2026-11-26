import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";

vi.mock("./SiriWave", () => ({
  SiriWaveVisual: () => <div data-testid="siri-wave" />,
}));

import { MattrVoiceModeBar } from "./MattrVoiceModeBar";
import {
  getVoiceAssistantState,
  openThreadVoiceMode,
  resetVoiceAssistantStoreForTests,
  setVoiceModeOpen,
} from "./voiceAssistantStore";

function voiceStoreScope(): Disposable {
  resetVoiceAssistantStoreForTests();
  return {
    [Symbol.dispose]() {
      resetVoiceAssistantStoreForTests();
    },
  };
}

const scope = { environmentId: "env-1", threadId: "thread-42", title: "Antimatter setup check" };

it("hides the scope label in its own thread and shows it once switched to All workspace", async () => {
  using _store = voiceStoreScope();
  openThreadVoiceMode(scope, { autoStartHandsFree: false });

  await using screen = await render(
    <MattrVoiceModeBar variant="composer" hostThreadKey="env-1:thread-42" />,
  );
  expect(screen.container.textContent).not.toContain("Antimatter setup check");
  expect(screen.container.textContent).toContain("Paused");

  await screen.getByRole("button", { name: "Voice Mode options" }).click();
  await page.getByRole("menuitemradio", { name: "All workspace" }).click();

  expect(getVoiceAssistantState().scopedThread).toBeNull();
  await expect
    .poll(() => screen.container.querySelector('[role="status"]')?.textContent)
    .toContain("All workspace");

  await screen.getByRole("button", { name: "Voice Mode options" }).click();
  await page.getByRole("menuitemradio", { name: "Antimatter setup check" }).click();
  expect(getVoiceAssistantState().scopedThread).toEqual(scope);
});

it("names the scoped thread when shown outside it, and End closes the session", async () => {
  using _store = voiceStoreScope();
  openThreadVoiceMode(scope, { autoStartHandsFree: false });

  await using screen = await render(<MattrVoiceModeBar variant="floating" />);
  expect(screen.container.textContent).toContain("Antimatter setup check");

  await act(() => (screen.getByRole("button", { name: "End" }).element() as HTMLElement).click());
  expect(getVoiceAssistantState().sessionOpen).toBe(false);
});

it("opens unscoped outside a thread", async () => {
  using _store = voiceStoreScope();
  setVoiceModeOpen(true, { autoStartHandsFree: false });

  await using screen = await render(<MattrVoiceModeBar variant="floating" />);
  expect(getVoiceAssistantState().scopedThread).toBeNull();
  expect(screen.container.textContent).toContain("All workspace");
});
