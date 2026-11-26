/* oxlint-disable shadcn/no-unknown-classes -- the `matter-ais*` classes come from the fork stylesheet matter/rareui-chat.css, which loads outside Tailwind. */
import { use, useEffect, useRef, useState, type AnimationEvent, type ReactNode } from "react";
import { useGT, useMessages } from "gt-react";

import { observeResize } from "~/lib/observeResize";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  MATTER_AI_STATUS_PHASES,
  MatterAiStatusPhaseCtx,
  MatterThinkingCoordinationCtx,
  deriveMatterAiStatusPhase,
  deriveMatterThinkingCoordination,
  type MatterAiStatusIcon,
  useMatterAiStatusStyle,
} from "../../matterAiStatus";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
  type TimelineRowActivityState,
} from "./timelineRowContext";
import { ActivityShimmerOverlay } from "./TimelineRowParts";
import { ThinkingTimelineRow, WorkingTimelineRow } from "./TimelineWorkGroupRows";
import { formatWorkingTimerNow } from "./TimelineWorkGroupRows.logic";

const AIS = {
  root: "matter-ais",
  icon: "matter-ais-icon",
  iconIn: "matter-ais-icon-in",
  iconOut: "matter-ais-icon-out",
  row: "matter-ais-row",
  textIn: "matter-ais-text-in",
  textOut: "matter-ais-text-out",
  check: "matter-ais-check",
} as const;

/** Upstream's activity provider plus the live turn's AI status phase, derived only while it runs. */
export function MatterTimelineActivityProvider({
  value,
  rows,
  children,
}: {
  readonly value: TimelineRowActivityState;
  readonly rows: ReadonlyArray<TimelineRow>;
  readonly children: ReactNode;
}) {
  const phase =
    value.isWorking || value.awaitingUser
      ? deriveMatterAiStatusPhase(rows, {
          awaitingUser: value.awaitingUser,
          compacting: value.isCompacting,
          preparingWorktree: value.isPreparingWorktree,
        })
      : "thinking";
  const thinkingCoordination = deriveMatterThinkingCoordination(rows, {
    awaitingUser: value.awaitingUser,
    isPreparingWorktree: value.isPreparingWorktree,
    isCompacting: value.isCompacting,
    backgroundWorktreeSetup: value.backgroundWorktreeSetup !== null,
    providerStarting: value.providerStarting !== null,
    providerStartingLabel: value.providerStartingLabel !== null,
    liveAnswerPreview: value.liveAnswerPreview !== null,
  });
  return (
    <TimelineRowActivityCtx value={value}>
      <MatterAiStatusPhaseCtx value={phase}>
        <MatterThinkingCoordinationCtx value={thinkingCoordination}>
          {children}
        </MatterThinkingCoordinationCtx>
      </MatterAiStatusPhaseCtx>
    </TimelineRowActivityCtx>
  );
}

/** The working row: upstream's timer, or RareUI's status when Settings picks it. */
export function MatterWorkingTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "working" }>;
}) {
  const [style] = useMatterAiStatusStyle();
  const { backgroundWorktreeSetup } = use(TimelineRowActivityCtx);
  const { thinkingRowOwnsStatus } = use(MatterThinkingCoordinationCtx);
  // Upstream's row keeps the background setup chip, and stays a calm elapsed timer when a lower
  // thinking row (e.g. below a reply or steer) already owns the live RareUI status.
  if (style === "default" || backgroundWorktreeSetup !== null || thinkingRowOwnsStatus) {
    return <WorkingTimelineRow row={row} />;
  }
  return <RareUiWorkingRow row={row} />;
}

/** The live thinking row: upstream's brain row in Default mode, or RareUI's animated status. */
export function MatterThinkingTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "thinking" }>;
}) {
  const [style] = useMatterAiStatusStyle();
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const m = useMessages();
  const {
    isCompacting,
    isPreparingWorktree,
    liveAnswerPreview,
    providerStartingLabel,
    providerStarting,
  } = use(TimelineRowActivityCtx);
  const { suppressPlainThinkingRow } = use(MatterThinkingCoordinationCtx);

  if (style === "default" || isPreparingWorktree || isCompacting || providerStarting !== null) {
    return <ThinkingTimelineRow row={row} />;
  }

  const isPlainThinking =
    row.groupId === undefined &&
    row.label === undefined &&
    providerStartingLabel === null &&
    liveAnswerPreview === null;
  if (suppressPlainThinkingRow && isPlainThinking) {
    return null;
  }

  // A failed group keeps this disclosure while an approval waits, but nothing is thinking then.
  const live = ctx.pendingApprovals.size === 0;
  const label =
    (providerStartingLabel === null ? null : m(providerStartingLabel)) ??
    row.label ??
    liveAnswerPreview ??
    gt("Thinking");
  const icon: MatterAiStatusIcon = row.label !== undefined ? "analyzing" : "thinking";
  const status = <MatterAiStatus icon={icon} label={label} active={live} />;

  const { groupId } = row;
  if (groupId === undefined) return status;
  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded === true}
      onClick={() => ctx.onToggleWorkGroup(groupId, row.id)}
    >
      {status}
    </button>
  );
}

function RareUiWorkingRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const m = useMessages();
  const phase = useHeldValue(use(MatterAiStatusPhaseCtx), PHASE_HOLD_MS);
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const config = MATTER_AI_STATUS_PHASES[row.compacting ? "compacting" : phase];
  const { createdAt } = row;
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <MatterAiStatus
        icon={config.icon}
        label={m(config.label)}
        active={config.active}
        timer={
          createdAt ? (
            <span
              ref={tickTextContent(
                () => formatWorkingTimerNow(createdAt, activeThreadEnvironmentId),
                true,
              )}
            />
          ) : null
        }
      />
    </div>
  );
}

// Agents think for a beat between tool calls; holding each phase keeps the label from flickering.
const PHASE_HOLD_MS = 700;

/** `value`, changing at most once per `holdMs`; a value that reverts within the hold never shows. */
function useHeldValue<T>(value: T, holdMs: number): T {
  const [held, setHeld] = useState(value);
  const shownAt = useRef(Number.NEGATIVE_INFINITY);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces against wall-clock time; the timer ends with the change.
  useEffect(() => {
    if (Object.is(value, held)) return;
    const timer = setTimeout(
      () => {
        shownAt.current = performance.now();
        setHeld(value);
      },
      Math.max(0, shownAt.current + holdMs - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [value, held, holdMs]);
  return held;
}

/** Keeps the previous value on screen while it animates out, as AnimatePresence's popLayout does. */
function useSwap(value: string) {
  const [state, setState] = useState({ current: value, leaving: null as string | null, ran: 0 });
  if (state.current !== value) {
    setState({ current: value, leaving: state.current, ran: state.ran + 1 });
  }
  const onLeft = (event: AnimationEvent) => {
    if (event.target === event.currentTarget) setState((s) => ({ ...s, leaving: null }));
  };
  return {
    leaving: state.current === value ? state.leaving : null,
    swapped: state.ran > 0,
    onLeft,
  };
}

// The row eases between label widths, so a label change reveals or tucks the timer smoothly.
function bindRowWidth(row: HTMLSpanElement | null) {
  const content = row?.firstElementChild;
  if (!row || !content) return;
  return observeResize(content, ([entry]) => {
    if (entry) row.style.width = `${entry.contentRect.width}px`;
  });
}

/**
 * RareUI's Inline AI Status: an animated icon per state and a shimmering label, swapping with a
 * blur-and-lift; loops run only while `active`.
 */
export function MatterAiStatus({
  icon,
  label,
  active,
  timer,
  className,
}: {
  readonly icon: MatterAiStatusIcon;
  readonly label: string;
  readonly active: boolean;
  readonly timer?: ReactNode;
  readonly className?: string;
}) {
  const iconSwap = useSwap(icon);
  const labelSwap = useSwap(label);
  return (
    <div
      ref={active ? observeVisibleAnimation : undefined}
      data-matter-ai-status={icon}
      data-active={active || undefined}
      className={cn(
        AIS.root,
        "flex h-6 w-fit max-w-full min-w-0 items-center gap-1.5 px-1 text-sm leading-relaxed",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(AIS.icon, "relative grid size-4.5 shrink-0 place-items-center")}
      >
        {iconSwap.leaving ? (
          <span
            key={`out:${iconSwap.leaving}`}
            className={cn(AIS.iconOut, "absolute inset-0 grid place-items-center")}
            onAnimationEnd={iconSwap.onLeft}
          >
            <MatterAiStatusGlyph icon={iconSwap.leaving as MatterAiStatusIcon} active={false} />
          </span>
        ) : null}
        <span
          key={`in:${icon}`}
          className={cn("grid place-items-center", iconSwap.swapped && AIS.iconIn)}
        >
          <MatterAiStatusGlyph icon={icon} active={active} />
        </span>
      </span>
      <span ref={bindRowWidth} className={cn(AIS.row, "relative min-w-0 overflow-x-clip")}>
        <span className="flex w-max items-center gap-1.5 whitespace-nowrap">
          <span className="relative">
            {labelSwap.leaving ? (
              <span
                key={`out:${labelSwap.leaving}`}
                aria-hidden
                className={cn(
                  AIS.textOut,
                  "absolute inset-y-0 start-0 font-medium text-muted-foreground",
                )}
                onAnimationEnd={labelSwap.onLeft}
              >
                {labelSwap.leaving}
              </span>
            ) : null}
            <span
              key={`in:${label}`}
              data-slot="matter-ai-status-label"
              className={cn(
                "relative block overflow-hidden font-medium text-muted-foreground",
                labelSwap.swapped && AIS.textIn,
              )}
            >
              {label}
              {active ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
            </span>
          </span>
          {active && timer ? (
            <span
              aria-hidden
              data-slot="matter-ai-status-timer"
              className="font-medium text-muted-foreground/70 tabular-nums"
            >
              {timer}
            </span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SPARKLE_PATH = "M11 5Q12 12 19 13Q12 14 11 21Q10 14 3 13Q10 12 11 5Z";
const TWINKLE_PATH = "M18 2Q18.4 4.6 21 5Q18.4 5.4 18 8Q17.6 5.4 15 5Q17.6 4.6 18 2Z";
const WAVE_PATH =
  "M3 19C4.11 16.3 5.06 16.3 6.17 19C7.27 21.7 8.22 21.7 9.33 19C10.44 16.3 11.39 16.3 12.5 19";
const PEN_PATH =
  "M3.78181 16.3092L3 21L7.69086 20.2182C8.50544 20.0825 9.25725 19.6956 9.84119 19.1116L20.4198 8.53288C21.1934 7.75922 21.1934 6.5049 20.4197 5.73126L18.2687 3.58024C17.495 2.80658 16.2406 2.80659 15.4669 3.58027L4.88841 14.159C4.30447 14.7429 3.91757 15.4947 3.78181 16.3092Z";

/** RareUI's state icons, drawn at 16px; `active` runs their loop. */
function MatterAiStatusGlyph({
  icon,
  active,
}: {
  readonly icon: MatterAiStatusIcon;
  readonly active: boolean;
}) {
  const loop = (name: string) => (active ? `${name} matter-ais-loop` : name);
  switch (icon) {
    case "thinking":
      return (
        <svg viewBox="0 0 24 24" className="size-4 text-muted-foreground">
          <path d={SPARKLE_PATH} fill="currentColor" className={loop("matter-ais-sparkle")} />
          <path d={TWINKLE_PATH} fill="currentColor" className={loop("matter-ais-twinkle")} />
        </svg>
      );
    case "researching":
      return (
        <svg viewBox="0 0 24 24" className="size-4 text-muted-foreground">
          <g className={loop("matter-ais-lens")}>
            <circle {...STROKE} cx={10.5} cy={10.5} r={5.5} strokeWidth={2.25} />
            <path {...STROKE} d="M14.75 14.75L19 19" strokeWidth={2.5} />
          </g>
        </svg>
      );
    case "analyzing":
      return (
        <svg viewBox="0 0 24 24" className="size-4 text-muted-foreground">
          {[6, 12, 18].map((x) => (
            <path
              key={x}
              {...STROKE}
              d={`M${x} 19V5`}
              strokeWidth={3}
              className={loop("matter-ais-bar")}
            />
          ))}
        </svg>
      );
    case "writing":
      return (
        <svg viewBox="0 0 24 24" className="size-4 text-muted-foreground">
          <g transform="translate(-1.2 -2)">
            <path
              {...STROKE}
              d={WAVE_PATH}
              pathLength={1}
              strokeWidth={2.25}
              className={loop("matter-ais-ink")}
            />
            <g className={loop("matter-ais-pen")}>
              <path d={PEN_PATH} fill="currentColor" transform="scale(0.66) translate(-3 -21)" />
            </g>
          </g>
        </svg>
      );
    case "input":
      return <span className="size-2 rounded-full bg-warning" />;
    case "done":
      return (
        <svg viewBox="0 0 24 24" className="size-4 text-muted-foreground">
          <path
            {...STROKE}
            d="M5 12.5L10 17.5L19 7"
            pathLength={1}
            strokeWidth={2.5}
            className={AIS.check}
          />
        </svg>
      );
  }
}
