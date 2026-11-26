import type { RuntimeRequestId, ScopedThreadRef } from "@t3tools/contracts";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useGT } from "gt-react";
import { use, useEffect, useEffectEvent, useRef, useState } from "react";

import { markdownProseDirection, textDirection } from "~/textDirection";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { useStableCallback } from "~/hooks/useStableCallback";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { BackgroundThreadContext } from "./backgroundThread";
import { matterAnimatedHeightRef } from "./matterCardMotion.matter";

const OPTION_LETTERS = "ABCDEFGHI";
const SINGLE_SELECT_ADVANCE_DELAY_MS = 200;
const SHORTCUT_BLOCKERS =
  'select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [aria-modal="true"], [role="menu"], [role="combobox"], [data-slot$="popup"]';

/** The option a key picks: 1–9 or A–I, in row order; the custom row takes the next slot. */
export function matterQuestionShortcutIndex(key: string): number | null {
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  const letter = OPTION_LETTERS.indexOf(key.toUpperCase());
  return key.length === 1 && letter >= 0 ? letter : null;
}

function clearAutoAdvance(timerRef: { current: number | null }): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

export interface MatterQuestionsCardProps {
  readonly prompt: PendingUserInput;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly disabled: boolean;
  readonly isResponding: boolean;
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
  readonly onToggleOption: (questionId: string, optionValue: string) => void;
  readonly onAdvance: () => void;
  readonly onPrevious: () => void;
  readonly onChangeCustomAnswer: (questionId: string, value: string) => void;
  readonly onDismiss: (requestId: RuntimeRequestId) => void;
}

/** Matter: the Questions card that replaces upstream's pending user input banner. */
export function MatterQuestionsCard({
  prompt,
  cwd,
  threadRef,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onPrevious,
  onChangeCustomAnswer,
  onDismiss,
}: MatterQuestionsCardProps) {
  const gt = useGT();
  const canRespond = prompt.responseCapability !== "not_resumable";
  const inputDisabled = disabled || isResponding;
  const responseDisabled = inputDisabled || !canRespond;
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const customAnswerActive = progress.customAnswer.trim().length > 0;
  const allowsCustomAnswer = activeQuestion?.allowCustomAnswer !== false;
  const isLast = progress.isLastQuestion;
  const canContinue = !responseDisabled && (isLast ? progress.isComplete : progress.canAdvance);
  const advance = useStableCallback(onAdvance);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const backgroundThread = use(BackgroundThreadContext);
  const [optimisticSelect, setOptimisticSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const [shownStep, setShownStep] = useState({
    index: progress.questionIndex,
    direction: "none" as "none" | "forward" | "backward",
  });
  if (shownStep.index !== progress.questionIndex) {
    setShownStep({
      index: progress.questionIndex,
      direction: progress.questionIndex > shownStep.index ? "forward" : "backward",
    });
  }
  if (
    optimisticSelect &&
    (optimisticSelect.questionId !== activeQuestion?.id ||
      (!customAnswerActive && progress.selectedOptionValues.includes(optimisticSelect.optionValue)))
  ) {
    setOptimisticSelect(null);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the single-select auto-advance timer when the question changes, input is disabled, or the card unmounts
  useEffect(() => {
    if (responseDisabled || isResponding || activeQuestion?.id === undefined) {
      clearAutoAdvance(autoAdvanceTimerRef);
    }
    return () => clearAutoAdvance(autoAdvanceTimerRef);
  }, [activeQuestion?.id, isResponding, responseDisabled]);

  const handleAdvance = () => {
    clearAutoAdvance(autoAdvanceTimerRef);
    onAdvance();
  };

  const selectOption = (questionId: string, optionValue: string) => {
    if (responseDisabled) return;
    if (activeQuestion?.multiSelect) {
      onToggleOption(questionId, optionValue);
      return;
    }
    setOptimisticSelect({ questionId, optionValue });
    onToggleOption(questionId, optionValue);
    clearAutoAdvance(autoAdvanceTimerRef);
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      advance();
    }, SINGLE_SELECT_ADVANCE_DELAY_MS);
  };

  const pickFromShortcut = useEffectEvent((index: number) => {
    if (!activeQuestion) return false;
    const option = activeQuestion.options[index];
    if (option) {
      selectOption(activeQuestion.id, option.value ?? option.label);
      return true;
    }
    if (index === activeQuestion.options.length && allowsCustomAnswer) {
      clearAutoAdvance(autoAdvanceTimerRef);
      customInputRef.current?.focus();
      return true;
    }
    return false;
  });

  const advanceFromShortcut = useEffectEvent(() => {
    if (!canContinue) return false;
    handleAdvance();
    return true;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for 1–9, A–I, and Enter shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (isInSideChatPane(target)) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.closest(SHORTCUT_BLOCKERS)) return;
      if (event.key === "Enter" && !event.shiftKey) {
        if (
          target instanceof HTMLElement &&
          target.closest("button:not([data-matter-qp-option]), a[href], summary")
        ) {
          return;
        }
        if (advanceFromShortcut()) event.preventDefault();
        return;
      }
      const index = matterQuestionShortcutIndex(event.key);
      if (index === null) return;
      if (pickFromShortcut(index)) event.preventDefault();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, responseDisabled]);

  if (!activeQuestion) return null;

  const total = prompt.questions.length;
  const promptDirection = markdownProseDirection(
    prompt.questions
      .flatMap((question) => [question.question, ...question.options.map((option) => option.label)])
      .join(" "),
  );
  const customLetterIndex = activeQuestion.options.length;
  const continueLabel = isResponding
    ? gt("Sending…")
    : isLast
      ? gt("Submit", { $context: "button that sends the answers to the agent's questions" })
      : gt("Continue", { $context: "button that goes to the next question" });

  return (
    <section
      data-matter-questions=""
      dir={promptDirection}
      aria-label={gt("Questions")}
      aria-busy={isResponding || undefined}
    >
      <header data-matter-qp-header="">
        <span data-matter-qp-glyph="question" aria-hidden>
          <MessageCircleQuestionIcon />
        </span>
        <span data-matter-qp-heading="">{gt("Questions")}</span>
        {activeQuestion.header.trim().toLowerCase() !== "questions" ? (
          <span data-matter-qp-pill="" dir={textDirection(activeQuestion.header)}>
            {activeQuestion.header}
          </span>
        ) : null}
      </header>

      <div data-matter-height="" ref={matterAnimatedHeightRef}>
        <div>
          <div
            key={activeQuestion.id}
            data-matter-qp-step={shownStep.direction}
            data-matter-question-id={activeQuestion.id}
          >
            <div data-matter-qp-question="">
              <ChatMarkdown
                text={activeQuestion.question}
                cwd={cwd}
                threadRef={threadRef}
                lineBreaks
              />
            </div>
            {activeQuestion.multiSelect ? (
              <p data-matter-qp-hint="">{gt("Select all that apply")}</p>
            ) : null}
            <div
              data-matter-qp-options=""
              role="group"
              aria-label={activeQuestion.header}
              data-multi-select={activeQuestion.multiSelect ? "" : undefined}
            >
              {activeQuestion.options.map((option, index) => {
                const optionValue = option.value ?? option.label;
                const isSelected =
                  (optimisticSelect?.questionId === activeQuestion.id &&
                    optimisticSelect.optionValue === optionValue) ||
                  (!customAnswerActive && progress.selectedOptionValues.includes(optionValue));
                return (
                  <div key={`${activeQuestion.id}:${optionValue}`}>
                    <button
                      type="button"
                      data-matter-qp-option=""
                      data-selected={isSelected ? "" : undefined}
                      aria-pressed={isSelected}
                      disabled={responseDisabled}
                      onClick={() => selectOption(activeQuestion.id, optionValue)}
                    >
                      <OptionKey index={index} />
                      <span data-matter-qp-option-text="">
                        <span dir={textDirection(option.label)}>{option.label}</span>
                        {option.description && option.description !== option.label ? (
                          <span data-matter-qp-option-description="">{option.description}</span>
                        ) : null}
                      </span>
                      {activeQuestion.multiSelect && isSelected ? (
                        <CheckIcon data-matter-qp-check="" aria-hidden />
                      ) : null}
                    </button>
                    {option.preview ? (
                      <div data-matter-qp-preview="">
                        <ChatMarkdown
                          text={option.preview}
                          cwd={cwd}
                          threadRef={threadRef}
                          lineBreaks
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {allowsCustomAnswer ? (
                <label
                  data-matter-qp-option=""
                  data-matter-qp-custom=""
                  data-selected={customAnswerActive ? "" : undefined}
                  data-disabled={responseDisabled ? "" : undefined}
                >
                  <OptionKey index={customLetterIndex} />
                  <input
                    ref={customInputRef}
                    type="text"
                    value={progress.customAnswer}
                    disabled={responseDisabled}
                    placeholder={
                      activeQuestion.options.length === 0
                        ? gt("Type your answer…")
                        : gt("Something else…")
                    }
                    aria-label={gt("Your own answer")}
                    dir={textDirection(progress.customAnswer)}
                    autoComplete="off"
                    spellCheck
                    onChange={(event) => {
                      clearAutoAdvance(autoAdvanceTimerRef);
                      setOptimisticSelect(null);
                      onChangeCustomAnswer(activeQuestion.id, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      if (canContinue) handleAdvance();
                    }}
                  />
                </label>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <footer data-matter-qp-footer="">
        {total > 1 ? (
          <div data-matter-qp-stepper="">
            <button
              type="button"
              aria-label={gt("Previous question")}
              disabled={progress.questionIndex === 0 || isResponding}
              onClick={() => {
                clearAutoAdvance(autoAdvanceTimerRef);
                onPrevious();
              }}
            >
              <ChevronUpIcon aria-hidden />
            </button>
            <span data-matter-qp-count="" aria-live="polite">
              {progress.questionIndex + 1}/{total}
            </span>
            <button
              type="button"
              aria-label={gt("Next question")}
              disabled={isLast || !progress.canAdvance || responseDisabled}
              onClick={handleAdvance}
            >
              <ChevronDownIcon aria-hidden />
            </button>
          </div>
        ) : (
          <span />
        )}
        <div data-matter-qp-actions="">
          {prompt.dismissible ? (
            <button
              type="button"
              data-matter-qp-pill-button="secondary"
              disabled={isResponding}
              onClick={() => {
                clearAutoAdvance(autoAdvanceTimerRef);
                onDismiss(prompt.requestId);
              }}
            >
              {gt("Skip", { $context: "button that dismisses the agent's questions" })}
            </button>
          ) : null}
          <button
            type="button"
            data-matter-qp-pill-button="primary"
            data-ready={canContinue ? "" : undefined}
            disabled={!canContinue}
            onClick={handleAdvance}
          >
            {continueLabel}
            <span data-matter-qp-enter="" aria-hidden>
              ↵
            </span>
          </button>
        </div>
      </footer>
    </section>
  );
}

function OptionKey({ index }: { index: number }) {
  const letter = OPTION_LETTERS[index];
  return (
    <span data-matter-qp-key="" aria-hidden>
      {letter ?? index + 1}
    </span>
  );
}
