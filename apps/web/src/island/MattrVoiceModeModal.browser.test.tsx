import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";

vi.mock("./SiriWave", () => ({
  SiriWaveVisual: () => <div data-testid="siri-wave" />,
}));

import { MattrVoiceModeModal } from "./MattrVoiceModeModal";
import {
  getVoiceAssistantState,
  openThreadVoiceMode,
  resetVoiceAssistantStoreForTests,
  setVoiceAssistantModalOpen,
} from "./voiceAssistantStore";

function voiceStoreScope(): Disposable {
  resetVoiceAssistantStoreForTests();
  return {
    [Symbol.dispose]() {
      resetVoiceAssistantStoreForTests();
    },
  };
}

function renderModal() {
  return render(
    <MattrVoiceModeModal
      activeThreads={[
        {
          key: "env-1:thread-42",
          environmentId: "env-1",
          threadId: "thread-42",
          title: "Antimatter setup check",
          projectTitle: "mattr",
          status: "running",
          updatedAt: "2026-11-25T16:00:00.000Z",
          latestUserMessage: "Check setup",
          latestAssistantMessage: "Checking worktree setup now.",
          toolCallCount: 1,
          isStreaming: false,
          providerInstanceId: "claude-main",
          model: "claude-opus-4-6",
          branch: "main",
          runStartedAt: null,
          runCompletedAt: null,
          currentActivity: null,
          recentActivities: [],
          plan: null,
        },
      ]}
      pendingApprovals={[]}
      pendingUserInputs={[]}
      voiceLevel={0}
      onApprove={vi.fn()}
      onOpenThread={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
}

it("shows the active thread pill when launched from a thread and toggles cleanly to All workspace and back", async () => {
  using _store = voiceStoreScope();
  openThreadVoiceMode(
    {
      environmentId: "env-1",
      threadId: "thread-42",
      title: "Antimatter setup check",
    },
    { autoStartHandsFree: false },
  );

  await using screen = await renderModal();

  const scopePill = screen.container.querySelector('[data-voice-thread-scope="thread"]');
  expect(scopePill?.textContent).toContain("Antimatter setup check");
  expect(
    screen.getByPlaceholder("Message or ask about Antimatter setup check…").query(),
  ).not.toBeNull();

  const allWorkspaceBtn = screen
    .getByRole("button", { name: "Switch to all workspace" })
    .element() as HTMLButtonElement;
  await act(() => allWorkspaceBtn.click());

  expect(getVoiceAssistantState().scopedThread).toBeNull();
  expect(
    screen.container.querySelector('[data-voice-thread-scope="workspace"]')?.textContent,
  ).toContain("All workspace");

  const refocusBtn = screen
    .getByRole("button", { name: "Focus Antimatter setup check" })
    .element() as HTMLButtonElement;
  await act(() => refocusBtn.click());

  expect(getVoiceAssistantState().scopedThread).toEqual({
    environmentId: "env-1",
    threadId: "thread-42",
    title: "Antimatter setup check",
  });
  expect(
    screen.container.querySelector('[data-voice-thread-scope="thread"]')?.textContent,
  ).toContain("Antimatter setup check");
});

it("keeps global Voice Mode unscoped when opened outside a thread", async () => {
  using _store = voiceStoreScope();
  setVoiceAssistantModalOpen(true);

  await using screen = await renderModal();

  expect(screen.container.querySelector("[data-voice-thread-scope]")).toBeNull();
  expect(screen.container.textContent).toContain("1 active · 0 waiting");
});
