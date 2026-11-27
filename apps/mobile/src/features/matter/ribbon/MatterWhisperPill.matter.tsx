import { useNavigation } from "@react-navigation/native";
import {
  deriveMatterWhisperRows,
  deriveMatterWhisperSegments,
  isMatterWhisperActive,
  oldestMatterWhisperStart,
  uniqueMatterWhisperAgents,
  type MatterWhisperRow,
  type MatterWhisperSegmentKind,
} from "@t3tools/client-runtime/matter/whisper";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { useGT, useMessages } from "gt-react-native";
import { Fragment, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut, ReduceMotion } from "react-native-reanimated";

import { ProviderIcon } from "../../../components/ProviderIcon";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { previewEnvironment } from "../../../state/preview";
import { serverEnvironment } from "../../../state/server";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { openSettings } from "../../settings/settings-navigation";
import { useVisibleSecondClock } from "../../threads/use-visible-second-clock";

const PILL_ENTERING = FadeInDown.duration(180).reduceMotion(ReduceMotion.System);
const PILL_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const SEGMENT_HIT_SLOP = { top: 8, bottom: 8 } as const;
const MAX_AVATARS = 3;

/** Ticks alone, so the pill around it does not re-render every second. */
function OldestTimer(props: { readonly startedAtMs: number }) {
  const messages = useMessages();
  const nowMs = useVisibleSecondClock(true);
  const elapsed = Math.max(0, nowMs - props.startedAtMs);
  if (elapsed < 1000) return null;
  return (
    <Text
      className="font-sans text-[11px] text-foreground-muted"
      style={{ fontVariant: ["tabular-nums"] }}
      numberOfLines={1}
    >
      {formatDuration(elapsed, messages)}
    </Text>
  );
}

function Segment(props: {
  readonly first: boolean;
  readonly accessibilityLabel: string;
  readonly accessibilityHint?: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Fragment>
      {props.first ? null : <View className="h-3.5 w-px bg-border" />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityState={{ disabled: props.disabled === true }}
        disabled={props.disabled}
        hitSlop={SEGMENT_HIT_SLOP}
        onPress={props.onPress}
        className={cn(
          "h-8 flex-row items-center gap-1.5 px-2.5 active:opacity-60",
          props.disabled && "opacity-50",
        )}
      >
        {props.children}
      </Pressable>
    </Fragment>
  );
}

function SegmentGlyph(props: { readonly name: AppSymbolName }) {
  return (
    <SymbolView
      name={props.name}
      size={12}
      tintColorClassName="accent-foreground-muted"
      type="monochrome"
    />
  );
}

function SegmentCount(props: { readonly children: ReactNode }) {
  return (
    <Text
      className="font-t3-medium text-xs text-foreground"
      style={{ fontVariant: ["tabular-nums"] }}
      numberOfLines={1}
    >
      {props.children}
    </Text>
  );
}

function AgentAvatars(props: {
  readonly rows: ReadonlyArray<MatterWhisperRow>;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
}) {
  const providerOf = (row: MatterWhisperRow) =>
    props.providers?.find((entry) => entry.instanceId === row.providerInstanceId);
  const driverOf = (row: MatterWhisperRow) => row.driver ?? providerOf(row)?.driver ?? null;
  const shown = uniqueMatterWhisperAgents(props.rows, (row) => driverOf(row) ?? "agent").slice(
    0,
    MAX_AVATARS,
  );
  return (
    <View className="flex-row items-center gap-0.5" accessibilityElementsHidden>
      {shown.map((row) => {
        const driver = driverOf(row);
        return driver === null ? (
          <SegmentGlyph key={row.key} name="person.2" />
        ) : (
          <ProviderIcon
            key={row.key}
            provider={driver}
            iconUrl={providerOf(row)?.iconUrl}
            size={14}
          />
        );
      })}
    </View>
  );
}

/**
 * Matter's Whisper Pill: a 28pt pill on the composer's surface while subagents, background
 * commands, servers or automations run. Each segment opens the native sheet for that work; Stop
 * ends background work. Idle it renders nothing; finished agents live in the header's git menu.
 */
export function MatterWhisperPill(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly backgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  /** Upstream's background-work Stop: interrupts the thread's pending background tasks. */
  readonly stop: { readonly enabled: boolean; readonly pending: boolean; readonly run: () => void };
  readonly hidden?: boolean;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { themeAppearance } = useAppearancePreferences();
  const serversQuery = useEnvironmentQuery(
    props.hidden === true
      ? null
      : previewEnvironment.discoveredServers({ environmentId: props.environmentId, input: {} }),
  );
  const tasksQuery = useEnvironmentQuery(
    props.hidden === true
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const servers = (serversQuery.data?.servers ?? []).filter(
    (server) =>
      server.terminal?.threadId === props.threadId || server.agent?.threadId === props.threadId,
  );
  const runningAutomations = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId && task.lastRunStatus === "running",
  ).length;
  const rows = deriveMatterWhisperRows({
    subagents: props.subagents,
    backgroundTasks: props.backgroundTasks,
    fallbackTitle: gt("Subagent"),
  });
  const summary = deriveMatterWhisperSegments({
    rows,
    serverCount: servers.length,
    runningAutomationCount: runningAutomations,
  });
  if (
    props.hidden === true ||
    !isMatterWhisperActive({
      rowCount: rows.length,
      serverCount: servers.length,
      runningAutomationCount: runningAutomations,
    })
  ) {
    return null;
  }

  const target = { environmentId: props.environmentId, threadId: props.threadId };
  const open = (segment: MatterWhisperSegmentKind) => {
    Keyboard.dismiss();
    if (segment === "agents" && props.subagents.length > 0) {
      navigation.navigate("ThreadAgents", target);
    } else if (segment === "agents" || segment === "commands") {
      navigation.navigate("ThreadBackgroundWork", target);
    } else if (segment === "servers") {
      navigation.navigate("ThreadBrowserPreview", target);
    } else {
      openSettings(navigation, "SettingsScheduledTasks");
    }
  };
  const oldestAgent = oldestMatterWhisperStart(summary.agents);
  const canStop = props.backgroundTasks.length > 0;
  const isDark = themeAppearance === "dark";
  // The composer shelf's own surface, so the pill reads as part of the Shelf composer.
  const surfaceClass = isDark
    ? "bg-grouped-card border-adaptive-neutral-200-a80-white-a8"
    : "bg-card border-border-subtle";

  const segment = (kind: MatterWhisperSegmentKind, index: number) => {
    const first = index === 0;
    if (kind === "agents") {
      const count = summary.agents.length;
      return (
        <Segment
          key={kind}
          first={first}
          accessibilityLabel={gt(
            "{count, plural, one {{count} agent running} other {{count} agents running}}",
            { count },
          )}
          accessibilityHint={gt("Opens this thread's agents")}
          onPress={() => open(kind)}
        >
          <AgentAvatars rows={summary.agents} providers={props.providers} />
          <SegmentCount>{gt("{count} running", { count })}</SegmentCount>
          {oldestAgent === null ? null : <OldestTimer startedAtMs={oldestAgent} />}
        </Segment>
      );
    }
    if (kind === "commands") {
      const count = summary.commands.length;
      return (
        <Segment
          key={kind}
          first={first}
          accessibilityLabel={gt(
            "{count, plural, one {{count} background command} other {{count} background commands}}",
            { count },
          )}
          accessibilityHint={gt("Opens this thread's background work")}
          onPress={() => open(kind)}
        >
          <SegmentGlyph name="terminal" />
          <SegmentCount>
            {first && summary.segments.length === 1
              ? gt("{count} running", { count })
              : String(count)}
          </SegmentCount>
        </Segment>
      );
    }
    if (kind === "servers") {
      return (
        <Segment
          key={kind}
          first={first}
          accessibilityLabel={gt("Servers on ports {ports}", {
            ports: servers.map((server) => server.port).join(", "),
          })}
          accessibilityHint={gt("Opens the browser preview")}
          onPress={() => open(kind)}
        >
          <SymbolView
            name="globe"
            size={12}
            tintColorClassName="accent-adaptive-emerald-600-400"
            type="monochrome"
          />
          <SegmentCount>
            {first
              ? gt("{count, plural, one {{count} server} other {{count} servers}}", {
                  count: servers.length,
                })
              : String(servers.length)}
          </SegmentCount>
        </Segment>
      );
    }
    return (
      <Segment
        key={kind}
        first={first}
        accessibilityLabel={gt(
          "{count, plural, one {{count} automation running} other {{count} automations running}}",
          { count: runningAutomations },
        )}
        accessibilityHint={gt("Opens scheduled tasks")}
        onPress={() => open(kind)}
      >
        <SegmentGlyph name="calendar.badge.clock" />
        <SegmentCount>{String(runningAutomations)}</SegmentCount>
      </Segment>
    );
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      className="shrink-0 flex-row px-[17px] pb-2"
      entering={PILL_ENTERING}
      exiting={PILL_EXITING}
    >
      <View
        className={cn(
          "h-8 flex-row items-center overflow-hidden rounded-[10px] border",
          surfaceClass,
          !isDark &&
            Platform.OS !== "android" &&
            "shadow-[0_1px_2px] shadow-adaptive-black-a10-a25",
        )}
        style={{ borderCurve: "continuous" }}
      >
        {summary.segments.map(segment)}
        {canStop ? (
          <Segment
            first={false}
            accessibilityLabel={props.stop.pending ? gt("Stopping...") : gt("Stop background work")}
            disabled={!props.stop.enabled || props.stop.pending}
            onPress={props.stop.run}
          >
            <SymbolView
              name="stop.fill"
              size={10}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Segment>
        ) : null}
      </View>
    </Animated.View>
  );
}
