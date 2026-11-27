import type {
  EnvironmentId,
  OrchestrationV2GetNativeChildWorkResult,
  OrchestrationV2NativeChildWork,
  ThreadId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  ListTreeIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  buildNativeChildActivityItems,
  type NativeChildActivityItem,
  type NativeChildToolVerb,
} from "./nativeChildWork.logic";
import { WorkLogBlock, WorkLogDetails, WorkLogList, WorkLogRow } from "./WorkLog";
import { useMatterDisclosure } from "./matterWorklog.matter";

const LIVE_POLL_INTERVAL_MS = 2_500;

/**
 * Inline live activity feed for provider-native subagent threads whose tool calls are read on
 * demand from the provider's transcript (such as Antigravity) instead of streamed as turn items.
 */
export function NativeChildWorkTimeline(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isLive: boolean;
  readonly workspaceRoot?: string | null | undefined;
}) {
  const { environmentId, threadId, isLive, workspaceRoot } = props;
  const query = useEnvironmentQuery<OrchestrationV2GetNativeChildWorkResult, unknown>(
    orchestrationEnvironment.nativeChildWork({
      environmentId,
      input: { threadId },
    }),
  );

  const pollIfVisible = useEffectEvent(() => {
    if (document.hidden || query.isPending) return;
    query.refresh();
  });

  const refreshLatest = useEffectEvent(() => {
    if (!query.isPending) {
      query.refresh();
    }
  });

  const wasLiveRef = useRef(isLive);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the native child transcript on an interval while the subagent is running and refreshes once on completion
  useEffect(() => {
    const previouslyLive = wasLiveRef.current;
    wasLiveRef.current = isLive;

    if (!isLive) {
      if (previouslyLive) {
        refreshLatest();
      }
      return;
    }

    const timer = window.setInterval(pollIfVisible, LIVE_POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) {
        pollIfVisible();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isLive]);

  const children = query.data?.children;

  if (query.error !== null) {
    return (
      <div className="messages-timeline-row-frame">
        <div className="chat-content-lane overflow-x-clip pb-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-destructive-foreground">
            <span className="min-w-0 truncate">{query.error}</span>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={query.isPending}
              onClick={query.refresh}
            >
              <RefreshCwIcon />
              <T>Refresh</T>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (children === undefined || children.length === 0) {
    return null;
  }

  const showChildHeaders = children.length > 1;

  return (
    <div className="messages-timeline-row-frame" data-native-child-work-timeline="true">
      <div className="chat-content-lane overflow-x-clip pb-3">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {isLive ? (
                <Spinner className="size-3 shrink-0" />
              ) : (
                <ListTreeIcon aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span>
                <T>Subagent work</T>
              </span>
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={query.isPending}
              onClick={query.refresh}
            >
              <RefreshCwIcon />
              <T>Refresh</T>
            </Button>
          </div>
          {children.map((child) => (
            <NativeChildInlineSection
              key={child.conversationId}
              child={child}
              showHeader={showChildHeaders}
              workspaceRoot={workspaceRoot}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function NativeChildInlineSection(props: {
  readonly child: OrchestrationV2NativeChildWork;
  readonly showHeader: boolean;
  readonly workspaceRoot?: string | null | undefined;
}) {
  const { child, showHeader, workspaceRoot } = props;
  const gt = useGT();
  const role = child.role || gt("Subagent");
  const items =
    child.steps === null ? null : buildNativeChildActivityItems(child.steps, { workspaceRoot });

  return (
    <section aria-label={role} className="flex min-w-0 flex-col gap-2">
      {showHeader ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-foreground">{role}</h3>
          {child.prompt.trim().length > 0 ? (
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {child.prompt}
            </p>
          ) : null}
        </div>
      ) : null}
      {child.truncated ? (
        <p className="px-1 text-xs text-muted-foreground">
          <T>Earlier steps are not shown.</T>
        </p>
      ) : null}
      {items === null ? (
        <p className="px-1 text-xs text-muted-foreground">
          <T>No transcript yet.</T>
        </p>
      ) : items.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          <T>No transcript yet.</T>
        </p>
      ) : (
        <WorkLogBlock>
          <WorkLogList>
            {items.map((item) => (
              <NativeChildActivityRow key={item.id} item={item} />
            ))}
          </WorkLogList>
        </WorkLogBlock>
      )}
    </section>
  );
}

function NativeChildActivityRow(props: { readonly item: NativeChildActivityItem }) {
  const { item } = props;
  if (item.kind === "message") {
    return (
      <div className="my-1.5 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground select-text">
        {item.text}
      </div>
    );
  }
  if (item.kind === "tool") {
    return <NativeChildToolRow item={item} />;
  }
  return <NativeChildOutputRow item={item} />;
}

function toolVerbIcon(verb: NativeChildToolVerb) {
  switch (verb) {
    case "read":
    case "edit":
    case "write":
      return <FileTextIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />;
    case "command":
      return <TerminalIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />;
    case "search":
      return <SearchIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />;
    case "message":
    case "subagent":
      return <MessageSquareIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />;
    case "tool":
      return <WrenchIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />;
  }
}

function NativeChildToolRow(props: {
  readonly item: Extract<NativeChildActivityItem, { kind: "tool" }>;
}) {
  const { item } = props;
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const disclosure = useMatterDisclosure(expanded);

  const verbLabel = (() => {
    switch (item.verb) {
      case "read":
        return gt("Read");
      case "edit":
        return <T>Edit</T>;
      case "write":
        return gt("Write");
      case "command":
        return gt("Command");
      case "search":
        return gt("Search");
      case "message":
        return gt("Send message");
      case "subagent":
        return gt("Subagent");
      case "tool":
        return item.toolName;
    }
  })();

  const hasDetails = item.inputText.trim().length > 0 || (item.outputText?.length ?? 0) > 0;

  return (
    <WorkLogRow
      data-matter-disclosure={disclosure.phase ?? undefined}
      icon={item.running ? <Spinner className="size-3.5" /> : toolVerbIcon(item.verb)}
      label={
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
          <span
            className={
              item.failed
                ? "font-medium text-destructive-foreground"
                : "font-medium text-foreground/85"
            }
          >
            {verbLabel}
          </span>
          {item.target !== null ? (
            <span className="truncate font-mono text-xs text-muted-foreground">{item.target}</span>
          ) : null}
          {!expanded && item.outputPreview !== null && item.verb === "command" ? (
            <span className="truncate text-xs text-muted-foreground/70">{item.outputPreview}</span>
          ) : null}
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {item.running ? (
            <span>{gt("Running", { $context: "status of background work" })}</span>
          ) : item.failed ? (
            <span className="text-destructive-foreground">
              {gt("Failed", { $context: "thread status" })}
            </span>
          ) : null}
          {hasDetails ? (
            expanded ? (
              <ChevronDownIcon aria-hidden="true" className="size-3.5" data-matter-wl-chevron />
            ) : (
              <ChevronRightIcon aria-hidden="true" className="size-3.5" data-matter-wl-chevron />
            )
          ) : null}
        </span>
      }
      toggle={
        hasDetails
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": expanded,
              onClick: () => setExpanded((current) => !current),
              onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setExpanded((current) => !current);
                }
              },
            }
          : undefined
      }
    >
      {disclosure.present && hasDetails ? (
        <WorkLogDetails>
          {item.inputText.trim().length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{gt("Input")}</span>
              <pre className="max-h-48 overflow-auto rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap break-all text-foreground">
                {item.inputText}
              </pre>
            </div>
          ) : null}
          {item.outputText !== null && item.outputText.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{gt("Activity")}</span>
              <pre className="max-h-64 overflow-auto rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
                {item.outputText}
              </pre>
            </div>
          ) : null}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

function NativeChildOutputRow(props: {
  readonly item: Extract<NativeChildActivityItem, { kind: "output" }>;
}) {
  const { item } = props;
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const disclosure = useMatterDisclosure(expanded);

  return (
    <WorkLogRow
      data-matter-disclosure={disclosure.phase ?? undefined}
      icon={
        item.running ? (
          <Spinner className="size-3.5" />
        ) : (
          <WrenchIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        )
      }
      label={
        <span
          className={
            item.failed ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
          }
        >
          {item.preview}
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {item.running ? (
            <span>{gt("Running", { $context: "status of background work" })}</span>
          ) : item.failed ? (
            <span className="text-destructive-foreground">
              {gt("Failed", { $context: "thread status" })}
            </span>
          ) : null}
          {expanded ? (
            <ChevronDownIcon aria-hidden="true" className="size-3.5" data-matter-wl-chevron />
          ) : (
            <ChevronRightIcon aria-hidden="true" className="size-3.5" data-matter-wl-chevron />
          )}
        </span>
      }
      toggle={{
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded,
        onClick: () => setExpanded((current) => !current),
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((current) => !current);
          }
        },
      }}
    >
      {disclosure.present ? (
        <WorkLogDetails>
          <pre className="max-h-64 overflow-auto rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
            {item.text}
          </pre>
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}
