import { useNavigation } from "@react-navigation/native";
import { isPendingUserInputOptionSelected } from "@t3tools/client-runtime/state/pending-user-input";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  markdownProseDirection,
  textDirection,
  type TextDirection,
} from "@t3tools/shared/textDirection";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type TextInputInstance,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { cn } from "../../../lib/cn";
import { resolveMarkdownLinkPresentation } from "../../../lib/markdownLinks";
import { SelectableMarkdownText } from "../../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import { useLiveThreadLinkLabels } from "../../../state/entities";
import { useMarkdownPreviewStyles } from "../../files/FileMarkdownPreview";
import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "../../files/filePath";
import type { PendingUserInputCardProps } from "../../threads/PendingUserInputCard";
import {
  deriveMatterQuestionProgress,
  matterOptionKeyLabel,
  shouldShowQuestionTopicPill,
} from "./matterQuestions";

const SINGLE_SELECT_ADVANCE_DELAY_MS = 200;

function clearAutoAdvance(timerRef: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timerRef.current === null) return;
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

function proseDirectionStyle(text: string, setDirection: TextDirection | undefined) {
  const direction = textDirection(text);
  return {
    ...(direction ? { direction, writingDirection: direction } : null),
    textAlign: (direction === "rtl") === (setDirection === "rtl") ? "left" : "right",
  } as const;
}

function QuestionMarkdown(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly setDirection: TextDirection | undefined;
  readonly preserveSoftBreaks?: boolean;
}) {
  const styles = useMarkdownPreviewStyles();
  const markdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const openLink = (href: string) => {
    const link = resolveMarkdownLinkPresentation(href);
    if (link.kind !== "file") {
      void openPullRequest(href);
      return;
    }
    const path = resolveFileLinkPath(props.workspaceRoot, link.path);
    if (path === null) return;
    navigation.navigate("ThreadFile", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
      path: fileRoutePathSegments(
        resolveWorkspaceRelativeFilePath(props.workspaceRoot, path) ?? path,
      ),
      ...(link.line ? { line: String(link.line) } : {}),
    });
  };
  return (
    <SelectableMarkdownText
      markdown={markdown}
      textStyle={styles.nativeTextStyle}
      writingDirection={markdownProseDirection(markdown)}
      // Android's renderer aligns relative to each paragraph's direction.
      textAlign={
        Platform.OS === "android" ? undefined : props.setDirection === "rtl" ? "right" : "left"
      }
      onLinkPress={openLink}
      preserveSoftBreaks={props.preserveSoftBreaks}
    />
  );
}

function OptionKeyBadge(props: { readonly index: number; readonly selected: boolean }) {
  return (
    <View
      className={cn(
        "mt-0.5 h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]",
        props.selected ? "bg-prominent-action" : "bg-grouped-card",
      )}
    >
      <Text
        className={cn(
          "font-t3-bold text-3xs",
          props.selected ? "text-prominent-action-foreground" : "text-foreground-muted",
        )}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {matterOptionKeyLabel(props.index)}
      </Text>
    </View>
  );
}

function InlineCustomAnswerRow(props: {
  readonly index: number;
  readonly value: string;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly multiline: boolean;
  readonly placeholder: string;
  readonly isLastQuestion: boolean;
  readonly setDirection: TextDirection | undefined;
  readonly onChangeText: (value: string) => void;
  readonly onInputFocusChange?: ((focused: boolean) => void) | undefined;
  readonly onSubmitEditing: () => void;
}) {
  const gt = useGT();
  const inputRef = useRef<TextInputInstance>(null);
  const focusedRef = useRef(false);
  const onInputFocusChange = props.onInputFocusChange;
  // Uncontrolled input preserves iOS autocorrection; clear natively when an option replaces it.
  const [initialText] = useState(props.value);
  const nativeText = useRef(props.value);

  const releaseFocus = useEffectEvent(() => {
    if (focusedRef.current) onInputFocusChange?.(false);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases keyboard ownership on unmount since an unmounted native input never emits blur
  useEffect(() => () => releaseFocus(), []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the uncontrolled native input when selecting an option clears the custom answer draft
  useEffect(() => {
    if (props.value !== "" || nativeText.current === "") return;
    nativeText.current = "";
    inputRef.current?.clear();
  }, [props.value]);

  return (
    <Pressable
      disabled={props.disabled}
      onPress={() => inputRef.current?.focus()}
      className={cn(
        "min-h-11 w-full flex-row items-center gap-2.5 rounded-[12px] border px-2.5 py-2",
        props.active ? "border-foreground/30 bg-grouped-card" : "border-border bg-subtle",
        props.disabled && "opacity-55",
      )}
    >
      <OptionKeyBadge index={props.index} selected={props.active} />
      <TextInput
        ref={inputRef}
        defaultValue={initialText}
        editable={!props.disabled}
        multiline={props.multiline}
        submitBehavior={props.multiline ? "newline" : "blurAndSubmit"}
        returnKeyType={props.multiline ? "default" : props.isLastQuestion ? "done" : "next"}
        placeholder={props.placeholder}
        accessibilityLabel={gt("Your own answer")}
        style={
          props.value.length > 0 ? proseDirectionStyle(props.value, props.setDirection) : undefined
        }
        onChangeText={(text) => {
          nativeText.current = text;
          props.onChangeText(text);
        }}
        onFocus={() => {
          focusedRef.current = true;
          onInputFocusChange?.(true);
        }}
        onBlur={() => {
          focusedRef.current = false;
          onInputFocusChange?.(false);
        }}
        onSubmitEditing={props.multiline ? undefined : props.onSubmitEditing}
        className="min-h-[28px] flex-1 rounded-none border-0 bg-transparent px-0 py-0 font-sans text-sm text-foreground"
      />
    </Pressable>
  );
}

/** Matter: the Questions card that replaces upstream's pending user input card on mobile. */
export function MatterQuestionsCard(props: PendingUserInputCardProps) {
  const gt = useGT();
  const requestId = props.pendingUserInput.requestId;
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === requestId;
  const responseDisabled = !canRespond || isResponding;

  const [stepState, setStepState] = useState({ requestId, index: 0 });
  const rawIndex = stepState.requestId === requestId ? stepState.index : 0;
  const progress = deriveMatterQuestionProgress(
    props.pendingUserInput.questions,
    props.drafts,
    rawIndex,
  );
  const activeQuestion = progress.activeQuestion;

  const setQuestionIndex = (index: number) => {
    setStepState({ requestId, index });
  };

  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the single-select auto-advance timer when the question changes, input is disabled, or the card unmounts
  useEffect(() => {
    if (responseDisabled || activeQuestion?.id === undefined) {
      clearAutoAdvance(autoAdvanceTimerRef);
    }
    return () => clearAutoAdvance(autoAdvanceTimerRef);
  }, [activeQuestion?.id, responseDisabled]);

  const setDirection = markdownProseDirection(
    props.pendingUserInput.questions
      .flatMap((question) => [
        question.header,
        question.question,
        ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
      ])
      .join(" "),
  );

  const { cardCoverage, cardProgress, maxHeight } = props;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  const cardHeight = useSharedValue(0);
  const notifyCoverage = () => {
    // The card resizes with the keyboard every frame, so easing each sample would leave the
    // feed inset and floating controls trailing it.
    cardCoverage.set(Math.max(0, cardHeightRef.current - barHeightRef.current));
  };
  const handleBarLayout = (event: LayoutChangeEvent) => {
    barHeightRef.current = event.nativeEvent.layout.height;
    notifyCoverage();
  };
  const handleCardLayout = (event: LayoutChangeEvent) => {
    cardHeightRef.current = event.nativeEvent.layout.height;
    cardHeight.set(event.nativeEvent.layout.height);
    notifyCoverage();
  };
  const cardAnimatedStyle = useAnimatedStyle(() => {
    const value = cardProgress.value;
    const travel = Platform.OS === "android" ? cardCoverage.value : cardHeight.value;
    return {
      maxHeight: maxHeight.value,
      opacity:
        Platform.OS === "android"
          ? Math.min(1, (value * cardHeight.value) / Math.max(1, cardHeight.value - travel))
          : 1,
      transform: [{ translateY: (1 - value) * travel }],
    };
  });
  const androidBoundsStyle = useAnimatedStyle(() => ({
    paddingTop: cardCoverage.value * cardProgress.value,
  }));
  const overlayHeightStyle = useAnimatedStyle(() => ({ height: maxHeight.value }));

  const canContinue =
    !responseDisabled &&
    (progress.isLastQuestion
      ? props.canOperateThread && props.answers !== null
      : progress.canAdvance);

  const handleContinueOrSubmit = () => {
    clearAutoAdvance(autoAdvanceTimerRef);
    if (!canContinue) return;
    if (progress.isLastQuestion) {
      void props.onSubmit();
      return;
    }
    setQuestionIndex(progress.questionIndex + 1);
  };

  const handlePrevious = () => {
    clearAutoAdvance(autoAdvanceTimerRef);
    if (progress.isFirstQuestion || isResponding) return;
    setQuestionIndex(progress.questionIndex - 1);
  };

  const handleSelectOption = (optionValue: string) => {
    if (!activeQuestion || responseDisabled) return;
    props.onSelectOption(requestId, activeQuestion, optionValue);
    if (activeQuestion.multiSelect || progress.isLastQuestion) {
      return;
    }
    clearAutoAdvance(autoAdvanceTimerRef);
    const nextIndex = progress.questionIndex + 1;
    autoAdvanceTimerRef.current = setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      setStepState((current) =>
        current.requestId === requestId ? { requestId, index: nextIndex } : current,
      );
    }, SINGLE_SELECT_ADVANCE_DELAY_MS);
  };

  const stopButton = props.onStopThread ? (
    <ControlPill
      accessibilityLabel={gt("Stop", { $context: "verb, stops the thread" })}
      icon="stop.fill"
      variant="danger"
      className="h-9 w-9"
      disabled={!props.canOperateThread}
      onPress={props.onStopThread}
    />
  ) : null;

  const continueLabel = isResponding
    ? gt("Sending…")
    : progress.isLastQuestion
      ? gt("Submit", { $context: "button that sends the answers to the agent's questions" })
      : gt("Continue", { $context: "button that goes to the next question" });

  const questionCount = progress.total;
  const allowsCustomAnswer = activeQuestion?.allowCustomAnswer !== false;

  const bar = (
    <View
      onLayout={handleBarLayout}
      pointerEvents={props.collapsed ? "auto" : "none"}
      accessibilityElementsHidden={!props.collapsed}
      importantForAccessibility={props.collapsed ? "auto" : "no-hide-descendants"}
      className="flex-row items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-3 pr-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt(
          "{count, plural, one {Expand questions, {count} question} other {Expand questions, {count} questions}}",
          { count: questionCount },
        )}
        onPress={props.onToggleCollapsed}
        className="min-h-11 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <View className="h-6 w-6 items-center justify-center rounded-[7px] bg-adaptive-blue-500-a20-blue-400-a15">
          <SymbolView
            name="questionmark.bubble"
            size={13}
            tintColorClassName="accent-adaptive-blue-600-400"
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-sm text-foreground">{gt("Questions")}</Text>
        {questionCount > 1 ? (
          <View className="rounded-full bg-grouped-card px-2 py-0.5">
            <Text
              className="font-t3-medium text-3xs text-foreground-secondary"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {progress.questionIndex + 1}/{questionCount}
            </Text>
          </View>
        ) : null}
        <View className="flex-1" />
        <SymbolView
          name="chevron.up"
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
      {stopButton}
    </View>
  );

  const card = (
    <Animated.View
      onLayout={handleCardLayout}
      pointerEvents={props.collapsed ? "none" : "auto"}
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      className="gap-2.5 overflow-hidden rounded-[18px] border border-border bg-card p-4"
      style={cardAnimatedStyle}
    >
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Collapse questions")}
          onPress={props.onToggleCollapsed}
          className="min-h-11 flex-1 flex-row items-center gap-2.5 active:opacity-70"
        >
          <View className="h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-adaptive-blue-500-a20-blue-400-a15">
            <SymbolView
              name="questionmark.bubble"
              size={14}
              tintColorClassName="accent-adaptive-blue-600-400"
              type="monochrome"
            />
          </View>
          <Text className="font-t3-medium text-sm text-foreground">{gt("Questions")}</Text>
          {activeQuestion && shouldShowQuestionTopicPill(activeQuestion.header) ? (
            <View className="max-w-[50%] rounded-full bg-grouped-card px-2 py-0.5">
              <Text
                numberOfLines={1}
                className="font-t3-medium text-3xs text-foreground-secondary"
                style={proseDirectionStyle(activeQuestion.header, setDirection)}
              >
                {activeQuestion.header}
              </Text>
            </View>
          ) : null}
          <View className="flex-1" />
          <View className="h-8 w-8 items-center justify-center rounded-full bg-grouped-card">
            <SymbolView
              name="chevron.down"
              size={13}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </View>
        </Pressable>
        {stopButton}
      </View>

      {activeQuestion ? (
        <ScrollView
          bounces={false}
          className="min-h-0"
          contentContainerClassName="gap-2 pb-1"
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          showsVerticalScrollIndicator
          style={{ flexShrink: 1 }}
        >
          {!canRespond ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              {gt(
                "The provider process for this request is no longer available. Interrupt or restart the run to continue.",
              )}
            </Text>
          ) : null}

          <QuestionMarkdown
            markdown={activeQuestion.question}
            environmentId={props.environmentId}
            threadId={props.threadId}
            workspaceRoot={props.workspaceRoot}
            setDirection={setDirection}
            preserveSoftBreaks
          />

          {activeQuestion.multiSelect ? (
            <Text className="font-sans text-2xs text-foreground-muted">
              {gt("Select all that apply")}
            </Text>
          ) : null}

          <View className="gap-1.5 pt-0.5">
            {activeQuestion.options.map((option, index) => {
              const optionValue = option.value ?? option.label.trim();
              const selected = isPendingUserInputOptionSelected(
                activeQuestion,
                progress.activeDraft,
                optionValue,
              );
              const description =
                option.description && option.description !== option.label
                  ? option.description
                  : undefined;
              return (
                <View key={`${activeQuestion.id}:${optionValue}`} className="gap-1.5">
                  <Pressable
                    accessibilityRole={activeQuestion.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: selected, disabled: responseDisabled }}
                    disabled={responseDisabled}
                    onPress={() => handleSelectOption(optionValue)}
                    className={cn(
                      "min-h-11 w-full flex-row items-center gap-2.5 rounded-[12px] border px-2.5 py-2.5 active:opacity-80",
                      selected ? "border-foreground/30 bg-grouped-card" : "border-border bg-subtle",
                      responseDisabled && "opacity-55",
                    )}
                  >
                    <OptionKeyBadge index={index} selected={selected} />
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        className="font-t3-medium text-sm text-foreground"
                        style={proseDirectionStyle(option.label, setDirection)}
                      >
                        {option.label}
                      </Text>
                      {description ? (
                        <Text
                          className="font-sans text-2xs leading-4 text-foreground-muted"
                          style={proseDirectionStyle(description, setDirection)}
                        >
                          {description}
                        </Text>
                      ) : null}
                    </View>
                    {activeQuestion.multiSelect && selected ? (
                      <SymbolView
                        name="checkmark"
                        size={14}
                        tintColorClassName="accent-foreground-secondary"
                        type="monochrome"
                      />
                    ) : null}
                  </Pressable>
                  {option.preview ? (
                    <View className="pl-9 pr-2">
                      <QuestionMarkdown
                        markdown={option.preview}
                        environmentId={props.environmentId}
                        threadId={props.threadId}
                        workspaceRoot={props.workspaceRoot}
                        setDirection={setDirection}
                        preserveSoftBreaks
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}

            {allowsCustomAnswer ? (
              <InlineCustomAnswerRow
                key={`${requestId}:${activeQuestion.id}`}
                index={activeQuestion.options.length}
                value={progress.customAnswer}
                active={progress.usingCustomAnswer}
                disabled={responseDisabled}
                multiline={activeQuestion.initialAnswer !== undefined}
                placeholder={
                  activeQuestion.options.length === 0
                    ? gt("Type your answer…")
                    : gt("Something else…")
                }
                isLastQuestion={progress.isLastQuestion}
                setDirection={setDirection}
                onChangeText={(value) => {
                  clearAutoAdvance(autoAdvanceTimerRef);
                  props.onChangeCustomAnswer(requestId, activeQuestion.id, value);
                }}
                onInputFocusChange={props.onInputFocusChange}
                onSubmitEditing={handleContinueOrSubmit}
              />
            ) : null}
          </View>
        </ScrollView>
      ) : null}

      <View className="flex-row items-center justify-between gap-2 pt-0.5">
        {questionCount > 1 ? (
          <View className="-ml-1.5 flex-row items-center">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Previous question")}
              accessibilityState={{ disabled: progress.isFirstQuestion || isResponding }}
              disabled={progress.isFirstQuestion || isResponding}
              onPress={handlePrevious}
              className={cn(
                "h-11 w-11 items-center justify-center rounded-xl active:bg-grouped-card",
                (progress.isFirstQuestion || isResponding) && "opacity-40",
              )}
            >
              <SymbolView
                name="chevron.up"
                size={14}
                tintColorClassName="accent-foreground-secondary"
                type="monochrome"
              />
            </Pressable>
            <Text
              className="min-w-7 text-center font-t3-medium text-xs text-foreground-secondary"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {progress.questionIndex + 1}/{questionCount}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Next question")}
              accessibilityState={{
                disabled: progress.isLastQuestion || !progress.canAdvance || responseDisabled,
              }}
              disabled={progress.isLastQuestion || !progress.canAdvance || responseDisabled}
              onPress={handleContinueOrSubmit}
              className={cn(
                "h-11 w-11 items-center justify-center rounded-xl active:bg-grouped-card",
                (progress.isLastQuestion || !progress.canAdvance || responseDisabled) &&
                  "opacity-40",
              )}
            >
              <SymbolView
                name="chevron.down"
                size={14}
                tintColorClassName="accent-foreground-secondary"
                type="monochrome"
              />
            </Pressable>
          </View>
        ) : (
          <View />
        )}

        <View className="flex-row items-center gap-2">
          {props.pendingUserInput.dismissible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Skip", {
                $context: "button that dismisses the agent's questions",
              })}
              accessibilityState={{ disabled: isResponding || !props.canOperateThread }}
              disabled={isResponding || !props.canOperateThread}
              onPress={() => {
                clearAutoAdvance(autoAdvanceTimerRef);
                void props.onDismiss();
              }}
              className={cn(
                "min-h-11 items-center justify-center rounded-full bg-grouped-card px-4 active:opacity-75",
                (isResponding || !props.canOperateThread) && "opacity-50",
              )}
            >
              <Text className="font-t3-medium text-sm text-foreground">
                {gt("Skip", { $context: "button that dismisses the agent's questions" })}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={continueLabel}
            accessibilityState={{ disabled: !canContinue, busy: isResponding }}
            disabled={!canContinue}
            onPress={handleContinueOrSubmit}
            className={cn(
              "min-h-11 items-center justify-center rounded-full px-4 active:opacity-80",
              canContinue ? "bg-prominent-action" : "bg-grouped-card",
            )}
          >
            <Text
              className={cn(
                "font-t3-medium text-sm",
                canContinue ? "text-prominent-action-foreground" : "text-foreground-muted",
              )}
            >
              {continueLabel}
            </Text>
          </Pressable>
        </View>
      </View>

      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          {gt("This connection cannot submit answers.")}
        </Text>
      ) : null}
    </Animated.View>
  );

  return (
    <Animated.View
      className="relative"
      style={Platform.OS === "android" ? androidBoundsStyle : undefined}
      onLayout={props.onLayout}
    >
      {bar}
      <Animated.View
        pointerEvents={props.collapsed ? "none" : "box-none"}
        className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
        style={overlayHeightStyle}
      >
        {card}
      </Animated.View>
    </Animated.View>
  );
}
