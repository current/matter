import { toServerClock } from "@t3tools/client-runtime/clock";
import {
  MATTER_AI_STATUS_PHASE_HOLD_MS,
  type MatterAiStatusPhase,
} from "@t3tools/client-runtime/matter/ai-status";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { useGT, useMessages } from "gt-react-native";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import type { deriveThreadWorkLogSizing } from "../../../lib/layout";
import { useVisibleSecondClock } from "../../threads/use-visible-second-clock";
import {
  IDLE_MATTER_AI_STATUS,
  MATTER_AI_STATUS_LABELS,
  MATTER_AI_STATUS_SYMBOLS,
  matterAiStatusVisual,
  type MatterAiStatusFeedState,
} from "./matterAiStatus";
import { MatterLivePulse } from "./MatterLivePulse.matter";

export const MatterAiStatusContext = createContext<MatterAiStatusFeedState>(IDLE_MATTER_AI_STATUS);

const SWAP_IN = FadeIn.duration(200).reduceMotion(ReduceMotion.System);
const WORKING_ROW_MIN_HEIGHT = 42 - 3.5;

/** `value`, changing at most once per `holdMs`; a value that reverts within the hold never shows. */
function useHeldValue<T>(value: T, holdMs: number): T {
  const [held, setHeld] = useState(value);
  const shownAt = useRef(Number.NEGATIVE_INFINITY);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces against wall-clock time; the timer ends with the change.
  useEffect(() => {
    if (Object.is(value, held)) return;
    const timer = setTimeout(
      () => {
        shownAt.current = Date.now();
        setHeld(value);
      },
      Math.max(0, shownAt.current + holdMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value, held, holdMs]);
  return held;
}

/**
 * The live turn's Working row as Matter's AI status: what the agent is doing, held 700 ms so tool
 * beats don't flicker, and the elapsed time. While a lower thinking row owns the status it just
 * says Working; upstream's row (`children`) stays only for worktree setup.
 */
export function MatterAiStatusWorkingRow(props: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: string;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly iconColor: ColorValue;
  /** Background worktree setup rides on upstream's row, as on web. */
  readonly keepUpstream: boolean;
  readonly children: ReactNode;
}) {
  const status = use(MatterAiStatusContext);
  if (props.keepUpstream) return props.children;
  return (
    <MatterAiStatusRow
      environmentId={props.environmentId}
      startedAt={props.startedAt}
      rowSizing={props.rowSizing}
      iconColor={props.iconColor}
      phase={status.workingRowShowsStatus ? undefined : "working"}
    />
  );
}

function MatterAiStatusRow(props: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: string;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly iconColor: ColorValue;
  /** Pins the label while a lower thinking row owns the live status. */
  readonly phase?: MatterAiStatusPhase | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const contextPhase = use(MatterAiStatusContext).phase;
  const phase = useHeldValue(props.phase ?? contextPhase, MATTER_AI_STATUS_PHASE_HOLD_MS);
  const visual = matterAiStatusVisual(phase);
  const label = messages(MATTER_AI_STATUS_LABELS[phase]);
  const nowMs = toServerClock(props.environmentId, useVisibleSecondClock(true));
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(props.startedAt)) / 1_000));
  const elapsed =
    seconds > 0 ? formatDuration(seconds * 1_000, messages) : gt("{seconds}s", { seconds: 0 });
  return (
    <View
      accessible
      accessibilityLabel={gt("{status}, {elapsed}", { status: label, elapsed })}
      className="min-w-0 flex-1 flex-row items-center gap-1.5"
      style={{ minHeight: Math.max(WORKING_ROW_MIN_HEIGHT, props.rowSizing.estimatedRowHeight) }}
    >
      <Animated.View
        key={visual.icon}
        entering={SWAP_IN}
        className="h-6 w-6 shrink-0 items-center justify-center"
      >
        {visual.icon === "input" ? (
          <View className="h-2 w-2 rounded-full bg-warning-foreground" />
        ) : (
          <SymbolView
            name={MATTER_AI_STATUS_SYMBOLS[visual.icon]}
            size={14}
            weight="medium"
            tintColor={props.iconColor}
            type="monochrome"
          />
        )}
      </Animated.View>
      <MatterLivePulse active={visual.active} style={{ flexShrink: 1, minWidth: 0 }}>
        <Animated.View key={phase} entering={SWAP_IN}>
          <Text
            key={props.rowSizing.textSizeKey}
            numberOfLines={1}
            className="font-t3-medium text-xs text-foreground-muted"
          >
            {label}
          </Text>
        </Animated.View>
      </MatterLivePulse>
      {visual.active ? (
        <Text
          numberOfLines={1}
          className="shrink-0 font-t3-medium text-3xs tabular-nums text-foreground-muted opacity-70"
        >
          {elapsed}
        </Text>
      ) : null}
    </View>
  );
}
