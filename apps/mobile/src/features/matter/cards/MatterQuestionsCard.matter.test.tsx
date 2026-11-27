import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../../lib/threadActivity";
import type { PendingUserInputCardProps } from "../../threads/PendingUserInputCard";

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityRole,
  }: Children & {
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) => (
    <button
      type="button"
      disabled={disabled}
      aria-label={accessibilityLabel}
      data-role={accessibilityRole}
      onClick={disabled ? undefined : onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: Children) => <div>{children}</div> },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value, set: () => {} }),
}));
vi.mock("../../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-symbol={name} />,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
  AppTextInput: ({
    defaultValue,
    placeholder,
    accessibilityLabel,
    editable,
    onChangeText,
  }: {
    defaultValue?: string;
    placeholder?: string;
    accessibilityLabel?: string;
    editable?: boolean;
    onChangeText?: (value: string) => void;
  }) => (
    <input
      defaultValue={defaultValue}
      placeholder={placeholder}
      aria-label={accessibilityLabel}
      disabled={editable === false}
      onChange={(event) => onChangeText?.(event.target.value)}
    />
  ),
}));
vi.mock("../composer/MatterComposerSendButton.matter", () => ({
  MatterComposerSendButton: () => null,
}));
vi.mock("../../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string }) => <p>{props.markdown}</p>,
}));
vi.mock("../../../state/entities", () => ({
  useLiveThreadLinkLabels: (markdown: string) => markdown,
}));
vi.mock("../../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async () => true,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: () => {} }),
}));

import { MatterQuestionsCard } from "./MatterQuestionsCard.matter";

const multiQuestionPrompt = {
  requestId: "req-1" as RuntimeRequestId,
  responseCapability: "live",
  dismissible: true,
  questions: [
    {
      id: "q1",
      header: "Database",
      question: "Which database should we use?",
      options: [
        { label: "PostgreSQL", value: "pg", description: "Relational SQL" },
        { label: "SQLite", value: "sqlite", description: "Embedded file" },
      ],
    },
    {
      id: "q2",
      header: "Scope",
      question: "Select modules to migrate",
      multiSelect: true,
      options: [
        { label: "Auth", value: "auth" },
        { label: "Billing", value: "billing" },
      ],
    },
  ],
} as unknown as PendingUserInput;

function renderCard(options?: {
  drafts?: Record<string, PendingUserInputDraftAnswer>;
  answers?: Record<string, string | ReadonlyArray<string>> | null;
  onSelectOption?: PendingUserInputCardProps["onSelectOption"];
  onChangeCustomAnswer?: PendingUserInputCardProps["onChangeCustomAnswer"];
  onSubmit?: PendingUserInputCardProps["onSubmit"];
  onDismiss?: PendingUserInputCardProps["onDismiss"];
}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onSelectOption =
    options?.onSelectOption ?? vi.fn<PendingUserInputCardProps["onSelectOption"]>();
  const onChangeCustomAnswer =
    options?.onChangeCustomAnswer ?? vi.fn<PendingUserInputCardProps["onChangeCustomAnswer"]>();
  const onSubmit =
    options?.onSubmit ?? vi.fn<PendingUserInputCardProps["onSubmit"]>(async () => {});
  const onDismiss =
    options?.onDismiss ?? vi.fn<PendingUserInputCardProps["onDismiss"]>(async () => {});

  const container = document.createElement("div");
  const root = createRoot(container);
  const renderWith = (
    drafts: Record<string, PendingUserInputDraftAnswer>,
    answers: Record<string, string | ReadonlyArray<string>> | null,
  ) => {
    act(() =>
      root.render(
        <MatterQuestionsCard
          environmentId={"env-1" as EnvironmentId}
          threadId={"thread-1" as ThreadId}
          workspaceRoot="/repo"
          canOperateThread
          pendingUserInput={multiQuestionPrompt}
          maxHeight={{ value: 600 } as never}
          cardProgress={{ value: 1, set: () => {} } as never}
          cardCoverage={{ value: 0, set: () => {} } as never}
          collapsed={false}
          onToggleCollapsed={() => {}}
          drafts={drafts}
          answers={answers}
          respondingUserInputId={null}
          onSelectOption={onSelectOption}
          onChangeCustomAnswer={onChangeCustomAnswer}
          onSubmit={onSubmit}
          onDismiss={onDismiss}
        />,
      ),
    );
  };

  renderWith(options?.drafts ?? {}, options?.answers ?? null);

  return {
    container,
    rerender: renderWith,
    onSelectOption,
    onChangeCustomAnswer,
    onSubmit,
    onDismiss,
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

describe("MatterQuestionsCard", () => {
  it("renders lettered options, inline Something else field, stepper, Skip and Continue/Submit", async () => {
    using screen = renderCard({
      drafts: { q1: { selectedOptionValues: ["pg"] } },
      answers: { q1: "pg", q2: ["auth"] },
    });

    expect(screen.container.textContent).toContain("Questions");
    expect(screen.container.textContent).toContain("Database");
    expect(screen.container.textContent).toContain("Which database should we use?");
    expect(screen.container.textContent).toContain("A");
    expect(screen.container.textContent).toContain("PostgreSQL");
    expect(screen.container.textContent).toContain("B");
    expect(screen.container.textContent).toContain("SQLite");
    expect(screen.container.textContent).toContain("C");
    expect(screen.container.textContent).toContain("1/2");

    const customInput = screen.container.querySelector(
      'input[placeholder="Something else…"]',
    ) as HTMLInputElement | null;
    expect(customInput).not.toBeNull();

    const continueButton = screen.container.querySelector(
      'button[aria-label="Continue"]',
    ) as HTMLButtonElement | null;
    expect(continueButton?.disabled).toBe(false);
    await act(async () => continueButton?.click());

    expect(screen.container.textContent).toContain("Select modules to migrate");
    expect(screen.container.textContent).toContain("Select all that apply");
    expect(screen.container.textContent).toContain("2/2");

    const submitButton = screen.container.querySelector(
      'button[aria-label="Submit"]',
    ) as HTMLButtonElement | null;
    expect(submitButton?.disabled).toBe(false);
    await act(async () => submitButton?.click());
    expect(screen.onSubmit).toHaveBeenCalledTimes(1);

    const prevButton = screen.container.querySelector(
      'button[aria-label="Previous question"]',
    ) as HTMLButtonElement | null;
    await act(async () => prevButton?.click());
    expect(screen.container.textContent).toContain("1/2");
  });

  it("wires Skip to onDismiss and option taps to onSelectOption", async () => {
    using screen = renderCard();

    const optionButton = [...screen.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("PostgreSQL"),
    );
    await act(async () => optionButton?.click());
    expect(screen.onSelectOption).toHaveBeenCalledWith(
      "req-1",
      multiQuestionPrompt.questions[0],
      "pg",
    );

    const skipButton = screen.container.querySelector(
      'button[aria-label="Skip"]',
    ) as HTMLButtonElement | null;
    await act(async () => skipButton?.click());
    expect(screen.onDismiss).toHaveBeenCalledTimes(1);
  });
});
