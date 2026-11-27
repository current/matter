import { describe, expect, it } from "vite-plus/test";

import {
  deriveMatterQuestionProgress,
  matterOptionKeyLabel,
  shouldShowQuestionTopicPill,
} from "./matterQuestions";

const sampleQuestions = [
  {
    id: "q1",
    options: [
      { label: "PostgreSQL", value: "pg" },
      { label: "SQLite", value: "sqlite" },
    ],
  },
  {
    id: "q2",
    multiSelect: true,
    required: true,
    options: [{ label: "Auth" }, { label: "Billing" }, { label: "Analytics" }],
  },
] as const;

describe("matterOptionKeyLabel", () => {
  it("uses A through I for the first nine options and numbers afterward", () => {
    expect(matterOptionKeyLabel(0)).toBe("A");
    expect(matterOptionKeyLabel(1)).toBe("B");
    expect(matterOptionKeyLabel(8)).toBe("I");
    expect(matterOptionKeyLabel(9)).toBe("10");
  });
});

describe("shouldShowQuestionTopicPill", () => {
  it("hides blank or redundant Questions headers", () => {
    expect(shouldShowQuestionTopicPill("")).toBe(false);
    expect(shouldShowQuestionTopicPill("  ")).toBe(false);
    expect(shouldShowQuestionTopicPill("Questions")).toBe(false);
    expect(shouldShowQuestionTopicPill(" questions ")).toBe(false);
    expect(shouldShowQuestionTopicPill("Database")).toBe(true);
  });
});

describe("deriveMatterQuestionProgress", () => {
  it("clamps the question index and tracks single-question advance and full completion", () => {
    const start = deriveMatterQuestionProgress(sampleQuestions, {}, -2);
    expect(start.questionIndex).toBe(0);
    expect(start.total).toBe(2);
    expect(start.activeQuestion?.id).toBe("q1");
    expect(start.isFirstQuestion).toBe(true);
    expect(start.isLastQuestion).toBe(false);
    expect(start.canAdvance).toBe(false);
    expect(start.isComplete).toBe(false);

    const firstAnswered = deriveMatterQuestionProgress(
      sampleQuestions,
      { q1: { selectedOptionValues: ["pg"] } },
      0,
    );
    expect(firstAnswered.canAdvance).toBe(true);
    expect(firstAnswered.isComplete).toBe(false);
    expect(firstAnswered.selectedOptionValues).toEqual(["pg"]);

    const customAnswered = deriveMatterQuestionProgress(
      sampleQuestions,
      {
        q1: { selectedOptionValues: ["pg"] },
        q2: { customAnswer: "Only search" },
      },
      99,
    );
    expect(customAnswered.questionIndex).toBe(1);
    expect(customAnswered.isFirstQuestion).toBe(false);
    expect(customAnswered.isLastQuestion).toBe(true);
    expect(customAnswered.usingCustomAnswer).toBe(true);
    expect(customAnswered.canAdvance).toBe(true);
    expect(customAnswered.isComplete).toBe(true);
  });

  it("suppresses customAnswer when allowCustomAnswer is false", () => {
    const progress = deriveMatterQuestionProgress(
      [{ id: "q1", options: [{ label: "Yes" }], allowCustomAnswer: false }],
      { q1: { customAnswer: "Ignored" } },
      0,
    );
    expect(progress.customAnswer).toBe("");
    expect(progress.usingCustomAnswer).toBe(false);
    expect(progress.canAdvance).toBe(false);
  });
});
