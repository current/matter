import { msg, useMessages } from "gt-react-native";
import { memo, type ComponentProps } from "react";
import { useWindowDimensions, View } from "react-native";

import { ProjectFavicon } from "../../../components/ProjectFavicon";
import { ProviderIcon, providerInstanceNameLabel } from "../../../components/ProviderIcon";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { QueuedMessageIcon } from "../../threads/queued-message-icon";
import { ThreadListV2Row } from "../../threads/thread-list-v2-items";
import {
  selectedThreadRowColors,
  type getThreadListV2RowAppearance,
} from "../../threads/thread-list-v2-row-appearance";
import {
  matterTimelineRowAccessibilityLabel,
  matterTimelineStateLabel,
} from "./matterTimelineCopy";
import { MatterProviderMark } from "./MatterProviderMark";
import type { MatterTimelineRowInfo } from "./matterTimelineList";

type RowProps = ComponentProps<typeof ThreadListV2Row>;

// text-sm and text-2xs line heights; the icon sits one step above the 14px title.
const TITLE_LINE_HEIGHT = 19;
const LINE_TWO_LINE_HEIGHT = 16;
const TITLE_ICON_SIZE = 16;
const LINE_TWO_MARK_SIZE = 12;

const NO_PROJECT = msg("No project", { $context: "a thread that belongs to no project" });

/** The status column's light: amber waits on you, green runs, red failed, blue unread. */
const LIGHT_CLASS = {
  needs: "bg-warning-foreground",
  running: "bg-adaptive-emerald-600-400",
  failed: "bg-danger-foreground",
  unread: "bg-adaptive-blue-500-400",
} as const;

const STATE_TEXT_CLASS = {
  needs: "text-warning-foreground",
  running: "text-adaptive-emerald-600-400",
  failed: "text-danger-foreground",
} as const;

function Light(props: { readonly tone: keyof typeof LIGHT_CLASS }) {
  return <View className={cn("size-[7px] rounded-full", LIGHT_CLASS[props.tone])} />;
}

/**
 * A thread list row in Matter's Timeline look. Without `matter` (while searching) it is the
 * upstream row; with it, the upstream row keeps its swipe actions, menu and selection and this
 * draws the two lines inside.
 */
export const MatterTimelineRow = memo(function MatterTimelineRow({
  matter,
  ...props
}: RowProps & { readonly matter?: MatterTimelineRowInfo | undefined }) {
  const m = useMessages();
  if (matter === undefined) return <ThreadListV2Row {...props} />;
  const providerInstance = props.providerInstance;
  const providerIconUrl = props.providers?.find(
    (candidate) =>
      candidate.instanceId ===
      (props.thread.runtime?.providerInstanceId ?? props.thread.modelSelection.instanceId),
  )?.iconUrl;
  const providerName = providerInstance
    ? providerInstanceNameLabel({
        provider: providerInstance.driverKind,
        iconUrl: providerIconUrl,
        displayName: providerInstance.displayName,
        showBadge: providerInstance.showBadge,
      })
    : null;
  const snoozeWakeLabel =
    props.snoozed === true && props.snoozeWakeLabelText !== undefined
      ? m(props.snoozeWakeLabelText)
      : null;
  const timeText = snoozeWakeLabel ?? matter.timeText;
  return (
    <ThreadListV2Row
      {...props}
      // Timeline orders rows by state and time, so manual arrangement has no place here.
      reorderSupported={false}
      matterRow={{
        accessibilityLabel: matterTimelineRowAccessibilityLabel(
          {
            title: props.thread.title,
            info: matter,
            timeText,
            providerName,
            pinned: props.pinned === true,
            hasQueuedMessages: props.hasQueuedMessages === true,
          },
          m,
        ),
        renderContent: (appearance) => (
          <MatterTimelineRowContent
            {...props}
            appearance={appearance}
            info={matter}
            timeText={timeText}
            providerIconUrl={providerIconUrl}
          />
        ),
      }}
    />
  );
});

function MatterTimelineRowContent(
  props: RowProps & {
    readonly appearance: ReturnType<typeof getThreadListV2RowAppearance>;
    readonly info: MatterTimelineRowInfo;
    readonly timeText: string;
    readonly providerIconUrl: string | undefined;
  },
) {
  const m = useMessages();
  const { fontScale } = useWindowDimensions();
  const { appearance, info, thread, project, providerInstance } = props;
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  // The Mac sidebar's proportions: a title-sized project icon over a smaller gray provider mark,
  // both in one column, so line 2's text starts on the title's rail.
  const iconSize = Math.round(TITLE_ICON_SIZE * fontScale);
  const markSize = Math.round(LINE_TWO_MARK_SIZE * fontScale);
  const titleLineHeight = TITLE_LINE_HEIGHT * fontScale;
  const lineTwoHeight = LINE_TWO_LINE_HEIGHT * fontScale;
  const full = info.density === "full";
  const stateLabel = matterTimelineStateLabel(info, m);
  const ink = selected
    ? selectedThreadRowColors.foregroundClassName
    : appearance.foregroundClassName;
  const secondary = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : appearance.tertiaryForegroundClassName;
  const secondaryTint = selected
    ? selectedThreadRowColors.mutedIconTintClassName
    : appearance.tertiaryIconTintClassName;
  // Working stays green on the open row, where every other label takes the selection's ink.
  const stateTextClass =
    info.tone === "running"
      ? STATE_TEXT_CLASS.running
      : selected
        ? selectedThreadRowColors.foregroundClassName
        : info.tone === "needs" || info.tone === "failed"
          ? STATE_TEXT_CLASS[info.tone]
          : secondary;
  const titleClass = cn(
    "min-w-0 flex-1 text-sm",
    selected || info.unread ? ink : full && !info.quiet ? ink : appearance.mutedForegroundClassName,
    info.unread ? "font-t3-semibold" : selected && "font-t3-medium",
    // Read titles sit a step under full ink, as on the Mac, so unread ones stand out.
    full && !info.quiet && !info.unread && !selected && "opacity-[0.86]",
    thread.titleRegeneration != null && "opacity-55",
  );
  const leading = project ? (
    <ProjectFavicon
      environmentId={thread.environmentId}
      faviconPath={project.faviconPath}
      projectIcon={project.projectIcon}
      size={iconSize}
      projectTitle={project.title}
      workspaceRoot={project.workspaceRoot}
    />
  ) : providerInstance ? (
    <ProviderIcon
      iconUrl={props.providerIconUrl}
      provider={providerInstance.driverKind}
      size={iconSize}
    />
  ) : (
    <View style={{ width: iconSize }} />
  );
  const showMark = full && project !== undefined && project !== null && providerInstance != null;
  return (
    <View
      className={cn(
        "flex-row gap-2.5",
        full ? "items-start py-[7px]" : "min-h-[40px] items-center py-1.5",
        sidebarPane ? "px-3" : "px-5",
      )}
    >
      <View
        className={cn("items-center", info.quiet && !selected && "opacity-45")}
        style={{ width: iconSize }}
      >
        <View className="justify-center" style={full ? { height: titleLineHeight } : undefined}>
          {leading}
        </View>
        {showMark ? (
          <View className="mt-0.5 justify-center" style={{ height: lineTwoHeight, opacity: 0.8 }}>
            <MatterProviderMark
              iconUrl={props.providerIconUrl}
              provider={providerInstance.driverKind}
              size={markSize}
              fillClassName={
                selected
                  ? "bg-thread-selected-foreground-muted"
                  : sidebarPane
                    ? "bg-drawer-foreground-muted"
                    : "bg-foreground-tertiary"
              }
            />
          </View>
        ) : null}
      </View>
      <View className="min-w-0 flex-1">
        <View
          className="flex-row items-center gap-1.5"
          style={full ? { height: titleLineHeight } : undefined}
        >
          <Text className={titleClass} numberOfLines={1}>
            {thread.title}
          </Text>
          {info.goal ? (
            <SymbolView
              name="target"
              size={11}
              type="monochrome"
              tintColorClassName={secondaryTint}
            />
          ) : null}
          {props.pinned ? (
            <SymbolView name="pin" size={11} type="monochrome" tintColorClassName={secondaryTint} />
          ) : null}
          {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
          <StatusColumn
            info={info}
            full={full}
            timeText={props.timeText}
            secondary={secondary}
            stateTextClass={stateTextClass}
            stateLabel={stateLabel}
            secondaryTint={secondaryTint}
          />
        </View>
        {full ? (
          <View className="mt-0.5 flex-row items-center" style={{ height: lineTwoHeight }}>
            <Text
              className={cn("shrink text-2xs", secondary)}
              numberOfLines={1}
              style={{ maxWidth: "44%" }}
            >
              {info.projectName ?? m(NO_PROJECT)}
            </Text>
            {info.branchLabel !== null ? (
              <View className="ml-2 min-w-0 shrink flex-row items-center gap-1">
                <SymbolView
                  name="arrow.triangle.branch"
                  size={11}
                  type="monochrome"
                  tintColorClassName={secondaryTint}
                />
                <Text className={cn("shrink text-2xs", secondary)} numberOfLines={1}>
                  {info.branchLabel}
                </Text>
              </View>
            ) : null}
            <View className="min-w-2 flex-1" />
            {stateLabel !== null ? (
              <Text className={cn("text-2xs font-t3-medium", stateTextClass)} numberOfLines={1}>
                {stateLabel}
              </Text>
            ) : info.pullRequestNumber !== null ? (
              <Text className={cn("text-2xs tabular-nums", secondary)}>
                {`#${info.pullRequestNumber}`}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function StatusColumn(props: {
  readonly info: MatterTimelineRowInfo;
  readonly full: boolean;
  readonly timeText: string;
  readonly secondary: string;
  readonly stateTextClass: string;
  readonly stateLabel: string | null;
  readonly secondaryTint: string;
}) {
  const { info } = props;
  const time =
    props.timeText === "" ? null : (
      <Text
        className={cn(
          "text-2xs tabular-nums",
          info.tone === "running" ? props.stateTextClass : props.secondary,
        )}
      >
        {props.timeText}
      </Text>
    );
  return (
    <View className="flex-row items-center gap-1.5">
      {info.tone === "failed" && !props.full ? (
        <Text className={cn("text-2xs font-t3-medium", props.stateTextClass)}>
          {props.stateLabel}
        </Text>
      ) : (
        time
      )}
      {info.tone === "needs" ? (
        <Light tone="needs" />
      ) : info.tone === "running" ? (
        <Light tone="running" />
      ) : info.tone === "background" ? (
        <SymbolView
          name="circle.dashed"
          size={10}
          type="monochrome"
          tintColorClassName={props.secondaryTint}
        />
      ) : info.tone === "failed" ? (
        <Light tone="failed" />
      ) : info.unread ? (
        <Light tone="unread" />
      ) : null}
    </View>
  );
}
