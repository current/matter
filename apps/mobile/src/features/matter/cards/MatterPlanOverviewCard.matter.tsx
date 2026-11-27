import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  parseMatterPlanOverview,
  type MatterPlanStep,
} from "@t3tools/client-runtime/matter/plan-parser";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PlanId } from "@t3tools/contracts";
import { stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { useGT } from "gt-react-native";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { Sheet } from "../../../components/ui/Sheet";
import { m } from "../../../i18n/messages";
import { useDeadlinePassed } from "../../../lib/clock";
import { cn } from "../../../lib/cn";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { projectEnvironment } from "../../../state/projects";
import { useAtomCommand } from "../../../state/use-atom-command";
import { CopyTextButton } from "../../threads/CopyTextButton";
import { keyedMatterPlanSteps } from "./matterPlanApproval";
import { useMatterProposedPlanApprove } from "./useMatterPlanApproval.matter";

const COLLAPSED_STEP_COUNT = 3;
const COPY_FEEDBACK_DURATION_MS = 1200;

export interface MatterPlanOverviewCardProps {
  readonly environmentId: EnvironmentId;
  readonly planId?: PlanId | undefined;
  readonly workspaceRoot: string | null | undefined;
  readonly markdown: string;
  readonly renderMarkdown: (text: string) => ReactNode;
}

function PlanStepRow(props: { readonly step: MatterPlanStep }) {
  return (
    <View className="flex-row items-start gap-2 py-0.5">
      <View className="h-5 w-4 shrink-0 items-center justify-center">
        <SymbolView
          name={props.step.done ? "checkmark.circle.fill" : "circle.dashed"}
          size={15}
          tintColorClassName={
            props.step.done ? "accent-adaptive-emerald-600-400" : "accent-foreground-muted"
          }
          type="monochrome"
        />
      </View>
      <Text
        className={cn(
          "flex-1 font-sans text-sm leading-5",
          props.step.done ? "text-foreground-muted line-through" : "text-foreground-secondary",
        )}
      >
        {props.step.text}
      </Text>
    </View>
  );
}

/** Matter: the Plan Overview card that replaces upstream's proposed plan card on mobile. */
export function MatterPlanOverviewCard(props: MatterPlanOverviewCardProps) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(props.environmentId));
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const approvePlan = useMatterProposedPlanApprove({
    environmentId: props.environmentId,
    planId: props.planId,
    markdown: props.markdown,
  });

  const saveInFlight = useRef(false);
  const approveInFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [lastPath, setLastPath] = useState("plan.md");
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCopiedAtMs, setSheetCopiedAtMs] = useState<number | null>(null);
  const sheetCopyExpired = useDeadlinePassed(
    sheetCopiedAtMs === null ? null : sheetCopiedAtMs + COPY_FEEDBACK_DURATION_MS,
  );
  const sheetCopied = sheetCopiedAtMs !== null && !sheetCopyExpired;

  const contents = `${props.markdown.trimEnd()}\n`;
  const overview = parseMatterPlanOverview(props.markdown);
  const title = overview.title ?? gt("Proposed plan");
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(props.markdown);
  const steps = overview.steps;
  const hiddenStepCount = Math.max(0, steps.length - COLLAPSED_STEP_COUNT);
  const shownSteps = stepsExpanded ? steps : steps.slice(0, COLLAPSED_STEP_COUNT);
  const canSaveToWorkspace = Boolean(canWrite && props.workspaceRoot);

  const saveToWorkspace = async (path: string) => {
    const relativePath = path.trim();
    if (!canWrite || !props.workspaceRoot || saveInFlight.current) return;
    if (!relativePath) {
      Dialog.alert(gt("Enter a workspace path"));
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    setLastPath(relativePath);
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.workspaceRoot, relativePath, contents },
    }).finally(() => {
      saveInFlight.current = false;
      setSaving(false);
    });
    if (result._tag === "Success") {
      Dialog.alert(gt("Plan saved to workspace"), result.value.relativePath);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(gt("Could not save plan"), errorDisplayMessage(error, m) ?? String(error));
    }
  };

  const promptSaveToWorkspace = () => {
    Dialog.prompt({
      title: gt("Save plan to workspace"),
      // The write replaces an existing file, and the RPC has no create-only mode.
      message: gt(
        "Enter a path relative to the thread's workspace. A file already at that path is replaced.",
      ),
      initialValue: lastPath,
      confirmText: gt("Save", { $context: "verb, confirm button" }),
      onConfirm: (path) => void saveToWorkspace(path),
    });
  };

  const handleCopyInSheet = async () => {
    const copied = await tryCopyTextWithHaptic(contents).catch(() => false);
    if (!copied) {
      Dialog.alert(gt("Could not copy"), gt("Try again."));
      return;
    }
    setSheetCopiedAtMs(Date.now());
  };

  const handleApprove = (closeSheetOnSuccess = false) => {
    if (!approvePlan || approveInFlight.current) return;
    approveInFlight.current = true;
    setApproving(true);
    void approvePlan(props.markdown)
      .then((result) => {
        if (result._tag === "Success") {
          if (closeSheetOnSuccess) setSheetOpen(false);
          return;
        }
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(
            gt("Could not approve plan"),
            errorDisplayMessage(error, m) ?? gt("An error occurred while approving."),
          );
        }
      })
      .catch((error: unknown) => {
        Dialog.alert(
          gt("Could not approve plan"),
          error instanceof Error ? error.message : gt("An error occurred while approving."),
        );
      })
      .finally(() => {
        approveInFlight.current = false;
        setApproving(false);
      });
  };

  return (
    <View className="mb-3 rounded-[18px] border border-border bg-card p-4">
      <View className="flex-row items-center gap-2.5">
        <View className="h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-adaptive-emerald-500-a12-a16">
          <SymbolView
            name="checklist"
            size={14}
            tintColorClassName="accent-adaptive-emerald-600-400"
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-sm text-foreground">{gt("Plan Overview")}</Text>
        <View className="-mr-2 ml-auto flex-row items-center gap-0.5">
          <CopyTextButton
            accessibilityLabel={gt("Copy plan")}
            text={contents}
            buttonSize={36}
            iconSize={15}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Open full plan")}
            onPress={() => setSheetOpen(true)}
            hitSlop={4}
            className="h-9 w-9 items-center justify-center rounded-lg active:opacity-70"
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={15}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </Pressable>
        </View>
      </View>

      <Text
        accessibilityRole="header"
        className="mt-2 font-t3-bold text-base leading-[22px] text-foreground"
      >
        {title}
      </Text>

      {overview.summary ? (
        <Text
          numberOfLines={2}
          className="mt-0.5 font-sans text-sm leading-5 text-foreground-secondary"
        >
          {overview.summary}
        </Text>
      ) : null}

      <View className="mt-3 rounded-[12px] bg-grouped-card px-3 py-2.5">
        {steps.length > 0 ? (
          <>
            <View className="flex-row items-center gap-2 pb-1">
              <SymbolView
                name="list.number"
                size={14}
                tintColorClassName="accent-foreground-secondary"
                type="monochrome"
              />
              <Text className="font-t3-medium text-sm text-foreground">{gt("To-dos")}</Text>
              <Text
                className="ml-auto font-sans text-sm text-foreground-muted"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {steps.length}
              </Text>
            </View>
            <View className="gap-0.5">
              {keyedMatterPlanSteps(shownSteps).map(({ key, step }) => (
                <PlanStepRow key={key} step={step} />
              ))}
            </View>
            {hiddenStepCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: stepsExpanded }}
                onPress={() => setStepsExpanded((expanded) => !expanded)}
                className="-mx-1 mt-0.5 min-h-11 flex-row items-center gap-2 rounded-md px-1 active:opacity-70"
              >
                <View className="w-4 items-center justify-center">
                  {stepsExpanded ? (
                    <SymbolView
                      name="minus"
                      size={11}
                      tintColorClassName="accent-foreground-muted"
                      type="monochrome"
                    />
                  ) : (
                    <Text className="font-t3-bold text-xs text-foreground-muted">···</Text>
                  )}
                </View>
                <Text className="font-t3-medium text-sm text-foreground">
                  {stepsExpanded
                    ? gt("Show less")
                    : gt("{count} more", {
                        count: hiddenStepCount,
                        $context: "button that reveals more plan steps",
                      })}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <View className="max-h-36 overflow-hidden">
            {props.renderMarkdown(displayedPlanMarkdown)}
          </View>
        )}
      </View>

      <View className="mt-3 flex-row items-center justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("View Plan")}
          onPress={() => setSheetOpen(true)}
          className="min-h-11 items-center justify-center rounded-full bg-grouped-card px-4 active:opacity-75"
        >
          <Text className="font-t3-medium text-sm text-foreground">{gt("View Plan")}</Text>
        </Pressable>
        {approvePlan !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              approving ? gt("Approving…") : gt("Approve", { $context: "approve a plan" })
            }
            accessibilityState={{ disabled: approving, busy: approving }}
            disabled={approving}
            onPress={() => handleApprove(false)}
            className={cn(
              "min-h-11 items-center justify-center rounded-full px-4 active:opacity-80",
              approving ? "bg-grouped-card" : "bg-prominent-action",
            )}
          >
            <Text
              className={cn(
                "font-t3-medium text-sm",
                approving ? "text-foreground-muted" : "text-prominent-action-foreground",
              )}
            >
              {approving ? gt("Approving…") : gt("Approve", { $context: "approve a plan" })}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {sheetOpen ? (
        <Sheet title={title} onClose={() => setSheetOpen(false)}>
          <View className="flex-1">
            <ScrollView
              contentInsetAdjustmentBehavior="automatic"
              className="flex-1"
              contentContainerClassName="px-5 pt-3 pb-4"
            >
              {props.renderMarkdown(displayedPlanMarkdown)}
            </ScrollView>
            <View
              className="flex-row flex-wrap items-center justify-end gap-2 border-t border-border bg-sheet px-4 pt-3"
              style={{ paddingBottom: Math.max(insets.bottom, 16) }}
            >
              <Button
                label={sheetCopied ? gt("Copied!") : gt("Copy plan")}
                tone="secondary"
                onPress={() => void handleCopyInSheet()}
              />
              {canSaveToWorkspace ? (
                <Button
                  label={saving ? gt("Saving...") : gt("Save to workspace")}
                  tone="secondary"
                  disabled={saving}
                  onPress={promptSaveToWorkspace}
                />
              ) : null}
              {approvePlan !== null ? (
                <Button
                  label={
                    approving ? gt("Approving…") : gt("Approve", { $context: "approve a plan" })
                  }
                  tone="contrast"
                  loading={approving}
                  disabled={approving}
                  onPress={() => handleApprove(true)}
                />
              ) : null}
            </View>
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}
