import "~/index.css";
import "../../../../../antimatter/questions-plan.css";

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import type { PendingUserInput } from "../../session-logic";
import { MattrQuestionsCard, mattrQuestionShortcutIndex } from "./MattrQuestionsCard.mattr";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("questions"),
  createdAt: "2026-11-26T00:00:00.000Z",
  dismissible: true,
  responseCapability: "live",
  questions: [
    {
      id: "auth",
      header: "Auth",
      question: "Which auth approach should we use?",
      options: [
        { label: "Session cookies", description: "" },
        { label: "JWT bearer", description: "" },
        { label: "OAuth only", description: "" },
      ],
      multiSelect: false,
    },
    {
      id: "secrets",
      header: "Secrets",
      question: "Where should secrets live?",
      options: [
        { label: ".env.local", description: "" },
        { label: "Vault", description: "" },
      ],
      multiSelect: true,
    },
    {
      id: "flag",
      header: "Questions",
      question: "Ship behind a feature flag?",
      options: [
        { label: "Yes - gradual rollout", description: "" },
        { label: "No - full release", description: "" },
      ],
      multiSelect: false,
    },
  ],
};

/** Holds answers and the step the way usePendingThreadRequests does. */
function Harness(props: {
  readonly onSubmit: (answers: Record<string, PendingUserInputDraftAnswer>) => void;
  readonly onDismiss: () => void;
  readonly initialIndex?: number;
}) {
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [index, setIndex] = useState(props.initialIndex ?? 0);
  const question = (id: string) => prompt.questions.find((entry) => entry.id === id)!;
  return (
    <MattrQuestionsCard
      prompt={prompt}
      cwd={undefined}
      threadRef={threadRef}
      disabled={false}
      isResponding={false}
      answers={answers}
      questionIndex={index}
      onToggleOption={(id, value) =>
        setAnswers((current) => ({
          ...current,
          [id]: togglePendingUserInputOptionSelection(question(id), current[id], value),
        }))
      }
      onChangeCustomAnswer={(id, value) =>
        setAnswers((current) => ({
          ...current,
          [id]: setPendingUserInputCustomAnswer(question(id), current[id], value),
        }))
      }
      onAdvance={() => {
        if (index === prompt.questions.length - 1) props.onSubmit(answers);
        else setIndex(index + 1);
      }}
      onPrevious={() => setIndex(Math.max(0, index - 1))}
      onDismiss={props.onDismiss}
    />
  );
}

describe("MattrQuestionsCard", () => {
  it("letters each option and adds an inline Something else row", async () => {
    await using screen = await render(<Harness onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    await expect.element(screen.getByText("Which auth approach should we use?")).toBeVisible();
    const keys = [...screen.container.querySelectorAll("[data-mattr-qp-key]")].map(
      (key) => key.textContent,
    );
    expect(keys).toEqual(["A", "B", "C", "D"]);
    await expect.element(screen.getByPlaceholder("Something else…")).toBeVisible();
    await expect.element(screen.getByText("1/3")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });

  it("selects with A–I and 1–9 and advances a single-select question", async () => {
    await using screen = await render(<Harness onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    await expect.element(screen.getByText("1/3")).toBeVisible();
    await userEvent.keyboard("b");
    await expect
      .element(screen.getByRole("button", { name: "JWT bearer" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByText("2/3")).toBeVisible();
    await expect.element(screen.getByText("Select all that apply")).toBeVisible();

    await userEvent.keyboard("1");
    await userEvent.keyboard("B");
    await expect
      .element(screen.getByRole("button", { name: ".env.local" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: "Vault" }))
      .toHaveAttribute("aria-pressed", "true");
    // Multi-select waits for Continue.
    await expect.element(screen.getByText("2/3")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });

  it("steps back and forward with the chevrons", async () => {
    await using screen = await render(<Harness onSubmit={vi.fn()} onDismiss={vi.fn()} />);
    await expect.element(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Next question" })).toBeDisabled();
    await screen.getByRole("button", { name: "Session cookies" }).click();
    await expect.element(screen.getByText("2/3")).toBeVisible();
    await expect
      .element(screen.container.querySelector<HTMLElement>("[data-mattr-qp-step]"))
      .toHaveAttribute("data-mattr-qp-step", "forward");

    await screen.getByRole("button", { name: "Previous question" }).click();
    await expect.element(screen.getByText("1/3")).toBeVisible();
    await expect
      .element(screen.container.querySelector<HTMLElement>("[data-mattr-qp-step]"))
      .toHaveAttribute("data-mattr-qp-step", "backward");
    await screen.getByRole("button", { name: "Next question" }).click();
    await expect.element(screen.getByText("2/3")).toBeVisible();
  });

  it("typing into Something else lights its key and Submit sends the typed answer", async () => {
    const onSubmit = vi.fn();
    await using screen = await render(<Harness onSubmit={onSubmit} onDismiss={vi.fn()} />);
    await expect.element(screen.getByText("1/3")).toBeVisible();
    await userEvent.keyboard("a");
    await expect.element(screen.getByText("2/3")).toBeVisible();
    await userEvent.keyboard("1");
    await screen.getByRole("button", { name: /Continue/ }).click();
    await expect.element(screen.getByText("Ship behind a feature flag?")).toBeVisible();
    // The header that repeats "Questions" gets no extra pill.
    expect(screen.container.querySelector<HTMLElement>("[data-mattr-qp-pill]")).toBeNull();
    const submit = screen.getByRole("button", { name: /Submit/ });
    await expect.element(submit).not.toHaveAttribute("data-ready");

    // C is the custom row: its letter focuses the field instead of typing.
    await userEvent.keyboard("c");
    const field = screen.getByPlaceholder("Something else…");
    await expect.element(field).toHaveFocus();
    await expect.element(field).toHaveValue("");
    await userEvent.keyboard("This is an example");

    const customRow = screen.container.querySelector<HTMLElement>("[data-mattr-qp-custom]");
    await expect.element(customRow).toHaveAttribute("data-selected", "");
    await expect.element(submit).toHaveAttribute("data-ready", "");
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      auth: { selectedOptionValues: ["Session cookies"] },
      flag: { customAnswer: "This is an example" },
    });
  });

  it("Skip dismisses the request", async () => {
    const onDismiss = vi.fn();
    await using screen = await render(<Harness onSubmit={vi.fn()} onDismiss={onDismiss} />);
    await screen.getByRole("button", { name: "Skip" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ignores letter shortcuts while typing in another field", async () => {
    await using screen = await render(
      <>
        <input aria-label="Elsewhere" />
        <Harness onSubmit={vi.fn()} onDismiss={vi.fn()} />
      </>,
    );
    await screen.getByLabelText("Elsewhere").click();
    await userEvent.keyboard("a");
    await expect
      .element(screen.getByRole("button", { name: "Session cookies" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("clears the 200ms single-select auto-advance timer when typing a custom answer or clicking Skip", async () => {
    using _timers = fakeTimers();
    const onAdvance = vi.fn();
    const onDismiss = vi.fn();
    const onChangeCustomAnswer = vi.fn();
    const onToggleOption = vi.fn();

    {
      await using screen = await render(
        <MattrQuestionsCard
          prompt={prompt}
          cwd={undefined}
          threadRef={threadRef}
          disabled={false}
          isResponding={false}
          answers={{}}
          questionIndex={0}
          onToggleOption={onToggleOption}
          onAdvance={onAdvance}
          onPrevious={vi.fn()}
          onChangeCustomAnswer={onChangeCustomAnswer}
          onDismiss={onDismiss}
        />,
      );
      await screen.getByRole("button", { name: "Session cookies" }).click();
      await screen.getByPlaceholder("Something else…").fill("Custom");
      expect(onChangeCustomAnswer).toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(300));
      expect(onAdvance).not.toHaveBeenCalled();
    }

    {
      await using screen = await render(
        <MattrQuestionsCard
          prompt={prompt}
          cwd={undefined}
          threadRef={threadRef}
          disabled={false}
          isResponding={false}
          answers={{}}
          questionIndex={0}
          onToggleOption={onToggleOption}
          onAdvance={onAdvance}
          onPrevious={vi.fn()}
          onChangeCustomAnswer={onChangeCustomAnswer}
          onDismiss={onDismiss}
        />,
      );
      await screen.getByRole("button", { name: "Session cookies" }).click();
      await screen.getByRole("button", { name: "Skip" }).click();
      expect(onDismiss).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTime(300));
      expect(onAdvance).not.toHaveBeenCalled();
    }
  });

  it("disables options and ignores clicks when prompt is not resumable", async () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    await using screen = await render(
      <MattrQuestionsCard
        prompt={{ ...prompt, responseCapability: "not_resumable" }}
        cwd={undefined}
        threadRef={threadRef}
        disabled={false}
        isResponding={false}
        answers={{}}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={onAdvance}
        onPrevious={vi.fn()}
        onChangeCustomAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    await expect.element(screen.getByRole("button", { name: "Session cookies" })).toBeDisabled();
    await expect.element(screen.getByPlaceholder("Something else…")).toBeDisabled();
    await userEvent.keyboard("a");
    expect(onToggleOption).not.toHaveBeenCalled();
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("submits or continues multi-select on Enter and ignores repeated keydown events", async () => {
    await using screen = await render(
      <Harness onSubmit={vi.fn()} onDismiss={vi.fn()} initialIndex={1} />,
    );
    await expect.element(screen.getByText("2/3")).toBeVisible();

    // Repeated keydown events should be ignored.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", repeat: true, bubbles: true }));
    await expect
      .element(screen.getByRole("button", { name: ".env.local" }))
      .toHaveAttribute("aria-pressed", "false");

    // Pick a multi-select option and press Enter to trigger Continue.
    await screen.getByRole("button", { name: ".env.local" }).click();
    await expect
      .element(screen.getByRole("button", { name: ".env.local" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("3/3")).toBeVisible();
  });

  it("keeps stacked banner top corners square, clears mobile 48px editor gap, and preserves dictation submit visibility", async () => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    try {
      await using screen = await render(
        <form data-chat-composer-form="true">
          <div data-slot="composer-banner-attachment">
            <div data-composer-banner-surface="attached">Notice above</div>
          </div>
          <div data-slot="composer-banner-attachment">
            <div data-composer-banner-surface="attached">
              <Harness onSubmit={vi.fn()} onDismiss={vi.fn()} />
            </div>
          </div>
          <div data-testid="composer-editor" className="p-1 max-sm:pb-12">
            Editor
          </div>
          <div data-chat-composer-mobile-pending-actions="true">
            <button type="button" data-pending-question-action="advance">
              Mobile Next
            </button>
          </div>
          <button
            type="submit"
            data-pending-question-action="advance"
            data-voice-input-active="true"
          >
            Dictation Submit
          </button>
        </form>,
      );

      const editor = screen.container.querySelector<HTMLElement>(
        '[data-testid="composer-editor"]',
      )!;
      expect(getComputedStyle(editor).paddingBottom).toBe("4px");

      const mobileOverlay = screen.container.querySelector<HTMLElement>(
        "[data-chat-composer-mobile-pending-actions]",
      )!;
      expect(getComputedStyle(mobileOverlay).display).toBe("none");

      const dictationSubmit = screen.getByRole("button", { name: "Dictation Submit" });
      await expect.element(dictationSubmit).toBeVisible();

      const stackedSurface = screen.container.querySelectorAll<HTMLElement>(
        '[data-composer-banner-surface="attached"]',
      )[1]!;
      expect(getComputedStyle(stackedSurface, "::before").borderTopLeftRadius).toBe("0px");
    } finally {
      await page.viewport(previousViewport.width, previousViewport.height);
    }
  });
});

describe("mattrQuestionShortcutIndex", () => {
  it("maps 1–9 and A–I to rows and ignores other keys", () => {
    expect(mattrQuestionShortcutIndex("1")).toBe(0);
    expect(mattrQuestionShortcutIndex("9")).toBe(8);
    expect(mattrQuestionShortcutIndex("a")).toBe(0);
    expect(mattrQuestionShortcutIndex("I")).toBe(8);
    expect(mattrQuestionShortcutIndex("j")).toBeNull();
    expect(mattrQuestionShortcutIndex("0")).toBeNull();
    expect(mattrQuestionShortcutIndex("Enter")).toBeNull();
  });
});
