import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  BotIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  HistoryIcon,
  MessagesSquareIcon,
  TerminalIcon,
} from "lucide-react";
import { useLayoutEffect, useState, type ReactNode } from "react";

import { openSideThread } from "../../lib/sideChatPane";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { useQuietThreadProjection, useThreadRelationshipShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";
import {
  closeMattrLineagePopover,
  countMattrPreviousAgents,
  deriveMattrWhisperRows,
  isMattrWhisperActive,
  type MattrLineageView,
  type MattrWhisperRow,
  oldestMattrWhisperStart,
  openMattrLineagePopover,
  setMattrLineageView,
  stackMattrWhisperAvatars,
  useMattrLineagePopover,
} from "./mattrThreadRibbon.logic";

/** The parent's pending background work and its Stop, from the thread lifecycle. */
export interface MattrBackgroundWork {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  /** Null while the turn is live (the composer owns that Stop) or the user can't operate. */
  readonly onStop: (() => Promise<void>) | null;
  readonly stopping: boolean;
}

interface LineageThreadProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly backgroundWork: MattrBackgroundWork;
}

/** Everything the pill and the Ribbon's agents button read about the thread's lineage. */
export function useMattrLineageModel(props: LineageThreadProps) {
  const gt = useGT();
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useQuietThreadProjection(ref)?.projection ?? null;
  const relationshipShells = useThreadRelationshipShells(ref);
  const subagents = projection?.subagents ?? [];
  const rows = deriveMattrWhisperRows({
    subagents,
    backgroundTasks: props.backgroundWork.tasks,
    fallbackTitle: gt("Subagent"),
  });
  const sideChatCount = relationshipShells.filter(
    (thread) =>
      thread.lineage.sideChat === true && thread.lineage.parentThreadId === props.threadId,
  ).length;
  return {
    ref,
    threadKey: scopedThreadKey(ref),
    rows,
    previousCount: countMattrPreviousAgents(subagents),
    sideChatCount,
  };
}

/** Automations bound to the thread, and how many of them are running now. */
export function useMattrThreadAutomationCounts(environmentId: EnvironmentId, threadId: ThreadId) {
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
    useMessages(),
  );
  const bound = (tasksQuery.data?.tasks ?? []).filter((task) => task.threadId === threadId);
  return {
    bound: bound.length,
    running: bound.filter((task) => task.lastRunStatus === "running").length,
  };
}

function WhisperRowTimer({ startedAtMs }: { readonly startedAtMs: number | null }) {
  if (startedAtMs === null) return null;
  return (
    <AgentElapsed
      agent={{
        status: "running",
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: null,
      }}
      compact
    />
  );
}

function LineageRow(props: {
  readonly row: MattrWhisperRow;
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly stopping: boolean;
  readonly stopDisabled: boolean;
  readonly onStop: (row: MattrWhisperRow) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const trigger = useSideThreadTrigger();
  const { row } = props;
  const provider = props.providers?.find((entry) => entry.instanceId === row.providerInstanceId);
  const driver = row.driver ?? provider?.driver;
  const open = (intent: Parameters<typeof openSideThread>[0]["intent"]) => {
    if (row.childThreadId === null) return;
    closeMattrLineagePopover();
    openSideThread({
      threadRef: scopeThreadRef(props.environmentId, row.childThreadId),
      panelRef: scopeThreadRef(props.environmentId, props.parentThreadId),
      intent,
      navigate: (threadRef) =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }),
    });
  };
  const triggerProps = row.childThreadId === null || row.remoteLabel !== null ? {} : trigger(open);
  const navigable = row.childThreadId !== null && row.remoteLabel === null;
  return (
    <li data-mattr-lineage-row data-kind={row.kind}>
      <Tooltip>
        <TooltipTrigger
          delay={300}
          render={
            <button
              type="button"
              data-mattr-lineage-row-open
              disabled={!navigable}
              {...triggerProps}
              onClick={(event) => {
                if (triggerProps.onClick) triggerProps.onClick(event);
                else open("primary");
              }}
            />
          }
        >
          {row.kind === "subagent" ? (
            <ThreadRelationshipIcon
              driver={driver}
              provider={provider}
              providerEntries={props.providerEntries}
              fallbackIcon={BotIcon}
              status={row.status}
            />
          ) : (
            <TerminalIcon aria-hidden data-mattr-lineage-row-glyph />
          )}
          <span data-mattr-lineage-row-title>{row.title}</span>
          {row.remoteLabel !== null ? (
            <span data-mattr-lineage-row-meta>
              <T>
                on <Var>{row.remoteLabel}</Var>
              </T>
            </span>
          ) : null}
          <span data-mattr-lineage-row-time>
            <WhisperRowTimer startedAtMs={row.startedAtMs} />
          </span>
        </TooltipTrigger>
        {/* Clears the row's Stop button, which shows on the same hover. */}
        <TooltipPopup side="right" sideOffset={32}>
          {row.title}
        </TooltipPopup>
      </Tooltip>
      {row.stopTarget !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-mattr-lineage-row-stop
                aria-label={gt("Stop {title}", { title: row.title })}
                disabled={props.stopDisabled}
                data-stopping={props.stopping || undefined}
                onClick={() => props.onStop(row)}
              />
            }
          >
            <span aria-hidden data-mattr-stop-glyph />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <T context="verb, stops one running subagent">Stop</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
}

function LineageFooterLink(props: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly count?: number;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" data-mattr-lineage-link onClick={props.onClick}>
      {props.icon}
      <span data-mattr-lineage-link-label>{props.label}</span>
      {props.count !== undefined && props.count > 0 ? (
        <span data-mattr-lineage-link-count>{props.count}</span>
      ) : null}
      <ChevronRightIcon aria-hidden data-mattr-lineage-link-chevron />
    </button>
  );
}

/**
 * The frosted Lineage popover body, shared by the Whisper Pill and the Ribbon's agents button:
 * running rows with Stop and Stop all, servers and automations while they run, and drilldowns
 * into previous agents and side chats, which reuse the details card's own lineage panel.
 */
export function MattrLineagePopoverContent(
  props: LineageThreadProps & {
    readonly view: MattrLineageView;
    readonly model: ReturnType<typeof useMattrLineageModel>;
    readonly serverCount: number;
    readonly automationCount: number;
  },
) {
  const gt = useGT();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(props.environmentId);
  const providerEntries = deriveProviderInstanceEntries(providers ?? []);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const canInterrupt = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [stoppingKeys, setStoppingKeys] = useState<ReadonlySet<string>>(new Set());
  const { rows, previousCount, sideChatCount } = props.model;
  const stopRow = async (row: MattrWhisperRow) => {
    if (row.stopTarget === null || stoppingKeys.has(row.key)) return;
    setStoppingKeys((current) => new Set(current).add(row.key));
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input: row.stopTarget,
    });
    setStoppingKeys((current) => {
      const next = new Set(current);
      next.delete(row.key);
      return next;
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not stop subagent") });
    }
  };
  const stoppableRows = rows.filter((row) => row.stopTarget !== null);
  const canStopAll =
    canInterrupt &&
    (stoppableRows.length > 0 ||
      (props.backgroundWork.onStop !== null && props.backgroundWork.tasks.length > 0));
  const stopAll = () => {
    for (const row of stoppableRows) void stopRow(row);
    if (props.backgroundWork.tasks.length > 0) void props.backgroundWork.onStop?.();
  };
  const stoppingAll = props.backgroundWork.stopping;

  if (props.view !== "main") {
    const title =
      props.view === "previous"
        ? gt("Previous agents")
        : props.view === "sideChats"
          ? gt("Side chats")
          : props.view === "servers"
            ? gt("Servers")
            : gt("Automations");
    return (
      <div data-mattr-lineage data-view={props.view}>
        <div data-mattr-lineage-header>
          <button
            type="button"
            data-mattr-lineage-back
            aria-label={gt("Back to lineage")}
            onClick={() => setMattrLineageView("main")}
          >
            <ChevronLeftIcon aria-hidden />
            <T context="navigates back to the lineage list">Back</T>
          </button>
          <span data-mattr-lineage-title>{title}</span>
        </div>
        <div data-mattr-lineage-drilldown>
          {props.view === "previous" || props.view === "sideChats" ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
              showLineage={props.view === "previous"}
              showSideChats={props.view === "sideChats"}
            />
          ) : props.view === "servers" ? (
            <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-mattr-lineage data-view="main">
      <div data-mattr-lineage-header>
        <span data-mattr-lineage-title>
          {rows.length > 0 ? (
            <T>
              Lineage · <Var>{rows.length}</Var> running
            </T>
          ) : (
            <T context="heading of the subagents popover">Lineage</T>
          )}
        </span>
        {rows.length > 0 ? (
          <button
            type="button"
            data-mattr-lineage-stop-all
            disabled={!canStopAll || stoppingAll}
            onClick={stopAll}
          >
            <span aria-hidden data-mattr-stop-glyph />
            {stoppingAll ? (
              <T>Stopping...</T>
            ) : (
              <T context="verb, stops every running agent">Stop all</T>
            )}
          </button>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <ul data-mattr-lineage-rows aria-label={gt("Running agents")}>
          {rows.map((row) => (
            <LineageRow
              key={row.key}
              row={row}
              environmentId={props.environmentId}
              parentThreadId={props.threadId}
              providerEntries={providerEntries}
              providers={providers}
              stopping={stoppingKeys.has(row.key)}
              stopDisabled={!canInterrupt || stoppingKeys.has(row.key)}
              onStop={(target) => void stopRow(target)}
            />
          ))}
        </ul>
      ) : (
        <p data-mattr-lineage-empty>
          <T>Nothing running right now.</T>
        </p>
      )}
      <div data-mattr-lineage-footer>
        <LineageFooterLink
          icon={<HistoryIcon aria-hidden />}
          label={<T>Previous agents</T>}
          count={previousCount}
          onClick={() => setMattrLineageView("previous")}
        />
        <LineageFooterLink
          icon={<MessagesSquareIcon aria-hidden />}
          label={<T>Side chats</T>}
          count={sideChatCount}
          onClick={() => setMattrLineageView("sideChats")}
        />
        {props.serverCount > 0 ? (
          <LineageFooterLink
            icon={<TerminalIcon aria-hidden />}
            label={<T context="running dev servers">Servers</T>}
            count={props.serverCount}
            onClick={() => setMattrLineageView("servers")}
          />
        ) : null}
        {props.automationCount > 0 ? (
          <LineageFooterLink
            icon={<CalendarClockIcon aria-hidden />}
            label={<T>Automations</T>}
            count={props.automationCount}
            onClick={() => setMattrLineageView("automations")}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The frosted Lineage popover, anchored above the pill or below the Ribbon's agents button. */
export function MattrLineagePopover(
  props: LineageThreadProps & {
    readonly anchor: "pill" | "ribbon";
    /** Forces the popup closed before unmounting so Base UI never strands an open portal. */
    readonly closed?: boolean;
    readonly model: ReturnType<typeof useMattrLineageModel>;
    readonly serverCount: number;
    readonly automationCount: number;
    readonly trigger: ReactNode;
  },
) {
  const popover = useMattrLineagePopover();
  const open =
    props.closed !== true &&
    popover.threadKey === props.model.threadKey &&
    popover.anchor === props.anchor;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openMattrLineagePopover(props.model.threadKey, props.anchor);
        else closeMattrLineagePopover();
      }}
    >
      {props.trigger}
      <PopoverPopup
        data-mattr-frosted=""
        data-mattr-lineage-popup={props.anchor}
        side={props.anchor === "pill" ? "top" : "bottom"}
        align={props.anchor === "pill" ? "start" : "end"}
        sideOffset={6}
        padding="none"
      >
        {open ? (
          <MattrLineagePopoverContent
            environmentId={props.environmentId}
            threadId={props.threadId}
            backgroundWork={props.backgroundWork}
            view={popover.view}
            model={props.model}
            serverCount={props.serverCount}
            automationCount={props.automationCount}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * A 28px pill floating above the composer while subagents, background commands, servers or
 * automations run. Idle, it renders nothing. It replaces upstream's background work line.
 */
export function MattrWhisperPill(props: LineageThreadProps) {
  const gt = useGT();
  const model = useMattrLineageModel(props);
  const servers = useThreadDiscoveredPorts({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const automations = useMattrThreadAutomationCounts(props.environmentId, props.threadId);
  const runningAutomations = automations.running;
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(props.environmentId);
  const providerEntries = deriveProviderInstanceEntries(providers ?? []);
  const popover = useMattrLineagePopover();
  const { rows } = model;
  const active = isMattrWhisperActive({
    rowCount: rows.length,
    serverCount: servers.length,
    runningAutomationCount: runningAutomations,
  });
  const open = popover.threadKey === model.threadKey && popover.anchor === "pill";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the external lineage popover store when the pill goes idle so Base UI closes cleanly and a future run never reopens it unasked
  useLayoutEffect(() => {
    if (!active && open) closeMattrLineagePopover();
  }, [active, open]);
  if (!active && !open) {
    return null;
  }
  const oldest = oldestMattrWhisperStart(rows);
  const avatars = stackMattrWhisperAvatars(rows);
  const [firstServer] = servers;
  const label =
    rows.length > 0
      ? gt("{count} running", { count: rows.length })
      : servers.length > 0
        ? gt("{count, plural, one {{count} server} other {{count} servers}}", {
            count: servers.length,
          })
        : gt("{count, plural, one {{count} automation} other {{count} automations}} running", {
            count: runningAutomations,
          });
  return (
    <div data-mattr-whisper-pill-row>
      <MattrLineagePopover
        {...props}
        anchor="pill"
        closed={!active}
        model={model}
        serverCount={servers.length}
        automationCount={automations.bound}
        trigger={
          <PopoverTrigger
            render={
              <button
                type="button"
                data-mattr-whisper-pill
                data-open={(active && open) || undefined}
                aria-label={gt("Lineage: {label}", { label })}
              />
            }
          >
            {avatars.length > 0 ? (
              <span data-mattr-whisper-avatars aria-hidden>
                {avatars.map(({ row, zIndex }) => {
                  const provider = providers?.find(
                    (entry) => entry.instanceId === row.providerInstanceId,
                  );
                  return (
                    <span key={row.key} data-mattr-whisper-avatar style={{ zIndex }}>
                      {row.kind === "subagent" ? (
                        <ThreadRelationshipIcon
                          driver={row.driver ?? provider?.driver}
                          provider={provider}
                          providerEntries={providerEntries}
                          fallbackIcon={BotIcon}
                          status={row.status}
                        />
                      ) : (
                        <TerminalIcon />
                      )}
                    </span>
                  );
                })}
              </span>
            ) : null}
            <span data-mattr-whisper-label>{label}</span>
            {oldest !== null ? (
              <span data-mattr-whisper-timer>
                <WhisperRowTimer startedAtMs={oldest} />
              </span>
            ) : null}
            {firstServer ? (
              <span data-mattr-whisper-server>
                :{firstServer.port}
                {servers.length > 1 ? ` +${servers.length - 1}` : ""}
              </span>
            ) : null}
            <ChevronUpIcon aria-hidden data-mattr-whisper-chevron />
          </PopoverTrigger>
        }
      />
    </div>
  );
}
