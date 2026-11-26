import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PlanId, ScopedThreadRef } from "@t3tools/contracts";
import { stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { DownloadIcon, ListChecksIcon, Maximize2Icon, XIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import {
  MATTER_PLAN_AUTO_APPROVE_SECONDS,
  useMatterPlanAutoApproveSetting,
} from "../../matterPlanAutoApprove";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findRevealRef } from "./markdownFindContext";
import { matterAnimatedHeightRef } from "./matterCardMotion.matter";
import { parseMatterPlanOverview, type MatterPlanStep } from "./matterPlanParser.matter";

const COLLAPSED_STEP_COUNT = 3;
const COUNTDOWN_TICK_MS = 250;
const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Persists across LegendList unmount/remount so scrolling never re-arms a disarmed plan.
const disarmedAutoApprovePlanIds = new Set<string>();

export function resetDisarmedMatterPlanAutoApproveForTests(): void {
  disarmedAutoApprovePlanIds.clear();
}

export type MatterPlanApproveResult = AtomCommandResult<unknown, unknown> | void;

export interface MatterPlanOverviewCardProps {
  readonly planId?: PlanId | undefined;
  readonly planMarkdown: string;
  readonly fallbackTitle: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly cwd: string | undefined;
  readonly findActive: boolean;
  readonly isCopied: boolean;
  readonly onDownload: () => void;
  readonly onCopy: () => void;
  /** Null when this client cannot write to the workspace. */
  readonly onSaveToWorkspace: (() => void) | null;
  /** Null unless the plan is still waiting for approval and this client can start a turn. */
  readonly onApprove: ((planMarkdown: string) => Promise<MatterPlanApproveResult>) | null;
  /** False for older/superseded or historical plans so they never arm auto-approve. */
  readonly autoApproveEligible?: boolean;
  /** Overrides the per-device setting; tests pass it. */
  readonly autoApprove?: boolean;
  /** The save-to-workspace dialog, owned by ProposedPlanCard. */
  readonly children?: ReactNode;
}

/** Matter: the Plan Overview card that replaces upstream's proposed plan card. */
export function MatterPlanOverviewCard({
  planId,
  planMarkdown,
  fallbackTitle,
  environmentId,
  threadRef,
  cwd,
  findActive,
  isCopied,
  onDownload,
  onCopy,
  onSaveToWorkspace,
  onApprove,
  autoApproveEligible = true,
  autoApprove,
  children,
}: MatterPlanOverviewCardProps) {
  const gt = useGT();
  const [autoApproveSetting] = useMatterPlanAutoApproveSetting();
  const planKey = planId ? `${environmentId}:${threadRef?.threadId ?? ""}:${planId}` : null;
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [autoApproveCancelled, setAutoApproveCancelled] = useState(
    () => planKey !== null && disarmedAutoApprovePlanIds.has(planKey),
  );
  const overview = parseMatterPlanOverview(planMarkdown);
  const title = overview.title ?? fallbackTitle;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const steps = overview.steps;
  const hiddenStepCount = Math.max(0, steps.length - COLLAPSED_STEP_COUNT);
  const shownSteps = stepsExpanded ? steps : steps.slice(0, COLLAPSED_STEP_COUNT);
  const canApprove = onApprove !== null && !approving;
  const isDisarmed =
    autoApproveCancelled || (planKey !== null && disarmedAutoApprovePlanIds.has(planKey));
  const autoApproveArmed =
    canApprove &&
    autoApproveEligible &&
    (autoApprove ?? autoApproveSetting) &&
    !isDisarmed &&
    !planOpen &&
    !dialogOpen;

  const disarmAutoApprove = () => {
    if (planKey !== null) disarmedAutoApprovePlanIds.add(planKey);
    setAutoApproveCancelled(true);
  };

  const revealRef = findRevealRef(() => {
    disarmAutoApprove();
    setPlanOpen(true);
  });

  const showApproveError = (error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Could not approve plan"),
        description:
          error instanceof Error ? error.message : gt("An error occurred while approving."),
      }),
    );
  };

  const approve = () => {
    if (!onApprove || approving) return;
    disarmAutoApprove();
    setApproving(true);
    void onApprove(planMarkdown)
      .then((result) => {
        if (result && result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          showApproveError(squashAtomCommandFailure(result));
        }
      })
      .catch((error: unknown) => {
        showApproveError(error);
      })
      .finally(() => {
        setApproving(false);
      });
  };

  return (
    <article data-matter-plan="" aria-label={gt("Plan Overview")}>
      <header data-matter-qp-header="">
        <span data-matter-qp-glyph="plan" aria-hidden>
          <ListChecksIcon />
        </span>
        <span data-matter-qp-heading="">{gt("Plan Overview")}</span>
        <span data-matter-plan-tools="">
          <PlanTool label={gt("Download as markdown")} onClick={onDownload}>
            <DownloadIcon aria-hidden />
          </PlanTool>
          <PlanTool
            label={gt("Open full plan")}
            onClick={() => {
              disarmAutoApprove();
              setDialogOpen(true);
            }}
          >
            <Maximize2Icon aria-hidden />
          </PlanTool>
        </span>
      </header>

      <h3 data-matter-plan-title="" data-thread-find-text="true">
        {title}
      </h3>
      {overview.summary ? <p data-matter-plan-summary="">{overview.summary}</p> : null}

      {steps.length > 0 || !planOpen ? (
        <div data-matter-plan-todos="">
          {steps.length > 0 ? (
            <>
              <div data-matter-plan-todos-header="">
                <ListChecksIcon aria-hidden />
                <span>{gt("To-dos")}</span>
                <span data-matter-plan-count="">{steps.length}</span>
              </div>
              <div data-matter-height="" ref={matterAnimatedHeightRef}>
                <ul data-matter-plan-steps="">
                  {keyedSteps(shownSteps).map(({ key, step }) => (
                    <PlanStepRow key={key} step={step} />
                  ))}
                </ul>
              </div>
              {hiddenStepCount > 0 ? (
                <button
                  type="button"
                  data-matter-plan-more=""
                  data-scroll-anchor-ignore
                  aria-expanded={stepsExpanded}
                  onClick={() => setStepsExpanded((value) => !value)}
                >
                  <span data-matter-plan-more-glyph={stepsExpanded ? "less" : "more"} aria-hidden />
                  {stepsExpanded
                    ? gt("Show less")
                    : gt("{count} more", {
                        count: hiddenStepCount,
                        $context: "button that reveals more plan steps",
                      })}
                </button>
              ) : null}
            </>
          ) : (
            <div data-matter-plan-preview="">
              <ChatMarkdown
                text={displayedPlanMarkdown}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                isStreaming={false}
                headingLevelOffset={3}
              />
            </div>
          )}
        </div>
      ) : null}

      {planOpen || findActive ? (
        <div
          ref={revealRef}
          data-matter-plan-full=""
          data-open={planOpen ? "" : undefined}
          data-thread-find-text="true"
          data-thread-find-fold={planOpen ? undefined : ""}
        >
          <ChatMarkdown
            text={displayedPlanMarkdown}
            cwd={cwd}
            environmentId={environmentId}
            threadRef={threadRef}
            isStreaming={false}
            headingLevelOffset={3}
          />
        </div>
      ) : null}

      <footer data-matter-qp-footer="">
        {autoApproveArmed ? (
          <AutoApproveCountdown
            seconds={MATTER_PLAN_AUTO_APPROVE_SECONDS}
            onElapsed={approve}
            onCancel={disarmAutoApprove}
          />
        ) : (
          <span />
        )}
        <div data-matter-qp-actions="">
          <button
            type="button"
            data-matter-qp-pill-button="secondary"
            data-scroll-anchor-ignore
            aria-expanded={planOpen}
            onClick={() => {
              if (!planOpen) disarmAutoApprove();
              setPlanOpen((open) => !open);
            }}
          >
            {planOpen ? gt("Hide Plan") : gt("View Plan")}
          </button>
          {onApprove !== null ? (
            <button
              type="button"
              data-matter-qp-pill-button="primary"
              data-ready={canApprove ? "" : undefined}
              disabled={!canApprove}
              onClick={approve}
            >
              {approving ? gt("Approving…") : gt("Approve", { $context: "approve a plan" })}
              <span data-matter-qp-enter="" aria-hidden>
                ↵
              </span>
            </button>
          ) : null}
        </div>
      </footer>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              environmentId={environmentId}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={2}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onCopy}>
              {isCopied ? gt("Copied!") : gt("Copy to clipboard")}
            </Button>
            {onSaveToWorkspace ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDialogOpen(false);
                  onSaveToWorkspace();
                }}
              >
                {gt("Save to workspace")}
              </Button>
            ) : null}
            <Button size="sm" onClick={onDownload}>
              {gt("Download as markdown")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {children}
    </article>
  );
}

/** Keys by text; a repeated step gets its occurrence number. */
function keyedSteps(steps: ReadonlyArray<MatterPlanStep>) {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = (seen.get(step.text) ?? 0) + 1;
    seen.set(step.text, occurrence);
    return { key: occurrence > 1 ? `${step.text}#${occurrence}` : step.text, step };
  });
}

function PlanTool({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" data-matter-plan-tool="" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function PlanStepRow({ step }: { step: MatterPlanStep }) {
  return (
    <li data-matter-plan-step="" data-done={step.done ? "" : undefined}>
      <span data-matter-plan-step-mark="" aria-hidden>
        {step.done ? (
          <svg viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7" />
            <path d="M5 8.2 7.1 10.3 11 6" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6.5" />
          </svg>
        )}
      </span>
      <span data-matter-plan-step-text="">{step.text}</span>
    </li>
  );
}

/** Counts down once; pauses while hovered or focused so it never fires under the cursor. */
function AutoApproveCountdown({
  seconds,
  onElapsed,
  onCancel,
}: {
  seconds: number;
  onElapsed: () => void;
  onCancel: () => void;
}) {
  const gt = useGT();
  const totalMs = seconds * 1000;
  const [remainingMs, setRemainingMs] = useState(totalMs);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remainingMsRef = useRef(totalMs);
  const elapse = useEffectEvent(onElapsed);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the opt-in auto-approve countdown while unpaused; stops when it elapses, pauses, or unmounts
  useEffect(() => {
    if (paused || remainingMsRef.current <= 0) return;
    let lastTickAt = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const left = Math.max(0, remainingMsRef.current - Math.max(0, now - lastTickAt));
      lastTickAt = now;
      remainingMsRef.current = left;
      setRemainingMs(left);
      if (left > 0) return;
      window.clearInterval(timer);
      elapse();
    }, COUNTDOWN_TICK_MS);
    return () => {
      window.clearInterval(timer);
      const elapsed = Math.max(0, Date.now() - lastTickAt);
      if (remainingMsRef.current > 0) {
        remainingMsRef.current = Math.max(1, remainingMsRef.current - elapsed);
      }
    };
  }, [paused]);

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const fraction = remainingMs / totalMs;
  return (
    <div data-matter-plan-auto="" role="timer" aria-live="off">
      <button
        type="button"
        data-matter-plan-auto-ring=""
        data-paused={paused ? "" : undefined}
        aria-label={gt("Cancel auto-approve")}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={onCancel}
      >
        <svg viewBox="0 0 16 16" aria-hidden>
          <circle data-track="" cx="8" cy="8" r={RING_RADIUS} />
          <circle
            data-progress=""
            cx="8"
            cy="8"
            r={RING_RADIUS}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          />
        </svg>
        <XIcon data-matter-plan-auto-cancel="" aria-hidden />
        <span data-matter-plan-auto-tip="" aria-hidden>
          {gt("Cancel", { $context: "cancel auto-approve" })}
        </span>
      </button>
      <span data-matter-plan-auto-label="">
        {gt("Auto Approve in {seconds}s", { seconds: secondsLeft })}
      </span>
    </div>
  );
}
