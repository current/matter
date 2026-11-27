import {
  buildPendingUserInputAnswers,
  normalizeSelectedOptionValues,
  type PendingUserInputDraftAnswer,
  type PendingUserInputQuestion,
} from "@t3tools/client-runtime/state/pending-user-input";

const OPTION_LETTERS = "ABCDEFGHI";

export function matterOptionKeyLabel(index: number): string {
  return OPTION_LETTERS[index] ?? String(index + 1);
}

export function shouldShowQuestionTopicPill(header: string): boolean {
  const trimmed = header.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "questions";
}

export interface MatterQuestionProgress<Q extends PendingUserInputQuestion> {
  readonly questionIndex: number;
  readonly total: number;
  readonly activeQuestion: Q | null;
  readonly activeDraft: PendingUserInputDraftAnswer | undefined;
  readonly selectedOptionValues: ReadonlyArray<string>;
  readonly customAnswer: string;
  readonly usingCustomAnswer: boolean;
  readonly isFirstQuestion: boolean;
  readonly isLastQuestion: boolean;
  readonly canAdvance: boolean;
  readonly isComplete: boolean;
}

export function deriveMatterQuestionProgress<Q extends PendingUserInputQuestion>(
  questions: ReadonlyArray<Q>,
  drafts: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): MatterQuestionProgress<Q> {
  const total = questions.length;
  const clampedIndex = total === 0 ? 0 : Math.max(0, Math.min(questionIndex, total - 1));
  const activeQuestion = questions[clampedIndex] ?? null;
  const activeDraft = activeQuestion ? drafts[activeQuestion.id] : undefined;
  const customAnswer =
    activeQuestion?.allowCustomAnswer === false ? "" : (activeDraft?.customAnswer ?? "");
  const usingCustomAnswer =
    activeQuestion !== null &&
    (activeQuestion.initialAnswer !== undefined ? customAnswer : customAnswer.trim()).length > 0;

  return {
    questionIndex: clampedIndex,
    total,
    activeQuestion,
    activeDraft,
    selectedOptionValues: activeQuestion
      ? normalizeSelectedOptionValues(activeQuestion, activeDraft?.selectedOptionValues)
      : [],
    customAnswer,
    usingCustomAnswer,
    isFirstQuestion: clampedIndex === 0,
    isLastQuestion: total === 0 || clampedIndex >= total - 1,
    canAdvance:
      activeQuestion !== null && buildPendingUserInputAnswers([activeQuestion], drafts) !== null,
    isComplete: buildPendingUserInputAnswers(questions, drafts) !== null,
  };
}
