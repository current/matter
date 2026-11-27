import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { useRef, type ReactNode } from "react";

import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useStableCallback } from "~/hooks/useStableCallback";
import { SideThreadsOpenContext } from "~/hooks/useSideThreadTrigger";
import { useTheme } from "~/hooks/useTheme";
import type { ChatMessage } from "~/types";

import { MessagesTimeline } from "../chat/MessagesTimeline";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import type { TurnItemSource } from "../chat/timelineRowContext";
import { useTimelineFollow } from "../chat/useTimelineFollow";
import type { CloudTranscriptRow } from "./claudeCloudTranscript.logic";
import { getClaudeCloudTranscriptItem } from "./claudeCloudStore";

// No environment answers to this id, so a row that would ask one for something gets nothing.
const NO_ENVIRONMENT_ID = EnvironmentId.make("guest");
const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_RUNS: ReadonlyArray<never> = [];
const ignore = () => {};

const cloudItemDetailAtom = Atom.family((key: string) => {
  const [sessionId, itemId] = JSON.parse(key) as [string, string, string];
  return Atom.make(Effect.sync(() => ({ item: getClaudeCloudTranscriptItem(sessionId, itemId) })));
});

const cloudTurnItemSource = (sessionId: string): TurnItemSource => ({
  detail: ({ itemId, revision }) =>
    cloudItemDetailAtom(JSON.stringify([sessionId, itemId, revision])),
});

/**
 * A Claude Cloud transcript drawn by the timeline every thread uses. Items have no runs, so
 * live work reads as runless; thread-only actions (fork, revert, reply, diffs) stay absent.
 */
export function ClaudeCloudTimeline(props: {
  readonly sessionId: string;
  readonly rows: ReadonlyArray<CloudTranscriptRow>;
  readonly optimisticMessages: ReadonlyArray<ChatMessage>;
  readonly isWorking: boolean;
  readonly workStartedAt: string | null;
  readonly awaitingUser: boolean;
  readonly children: (controls: { readonly scrollToEnd: () => void }) => ReactNode;
}) {
  const { sessionId, isWorking } = props;
  const gt = useGT();
  // No ":" so the timeline finds no environment thread behind the key.
  const threadKey = `claude-cloud-${sessionId}`;
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const turnItemSource = cloudTurnItemSource(sessionId);
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: props.rows,
    optimisticMessages: props.optimisticMessages,
  });
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: null,
    activeRunningTurnId: null,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    setTimelineAnchor: ignore,
  });
  const renderHtmlRender = useStableCallback(() => (
    <p className="chat-content-lane text-xs text-muted-foreground">
      {gt("Open this session on claude.ai to see this visual.")}
    </p>
  ));
  return (
    <>
      <div className="relative min-h-0 flex-1">
        <SideThreadsOpenContext value={false}>
          <MessagesTimeline
            listRef={listRef}
            timelineEntries={entries}
            isWorking={isWorking}
            runlessWorkActive={isWorking}
            activeTurnStartedAt={props.workStartedAt}
            awaitingUser={props.awaitingUser ? "input" : null}
            latestRun={null}
            runningRunId={null}
            turnDiffSummaries={NO_TURN_DIFFS}
            runs={NO_RUNS}
            routeThreadKey={threadKey}
            onOpenThread={ignore}
            supportsConversationRollback={false}
            onRevertToTurnCount={ignore}
            isRevertingCheckpoint={false}
            onImageExpand={ignore}
            renderHtmlRender={renderHtmlRender}
            turnItemSource={turnItemSource}
            activeThreadEnvironmentId={NO_ENVIRONMENT_ID}
            markdownCwd={undefined}
            resolvedTheme={resolvedTheme}
            timestampFormat="locale"
            workspaceRoot={undefined}
            anchorMessageId={null}
            onAnchorReady={ignore}
            onAnchorSizeChanged={ignore}
            contentInsetEndAdjustment={0}
            emptyPlaceholderInset={0}
            liveFollowEnabled={follow.timelineLiveFollowEnabled}
            onIsAtEndChange={follow.onIsAtEndChangeStable}
            onViewportAttach={follow.attachTimelineViewport}
            onFooterGrow={follow.onTimelineFooterGrowStable}
          />
        </SideThreadsOpenContext>
        {follow.showScrollToBottom ? (
          <ScrollToEndButton
            summary={null}
            bottom={4}
            onScrollToEnd={() => follow.scrollToEnd(true)}
          />
        ) : null}
      </div>
      {props.children({ scrollToEnd: () => follow.scrollToEnd(true) })}
    </>
  );
}
