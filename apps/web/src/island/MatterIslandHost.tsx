import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { transcribeCloudPcm, transcribeEnvironmentPcm } from "@t3tools/client-runtime/voice-input";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  PlanId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ProviderApprovalDecision,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { msg } from "gt-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTheme } from "../hooks/useTheme";
import { m } from "../i18n/messages";
import { cn, newMessageId, newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readAppleSpeechLocales, resolveAppleSpeechLocale } from "../speech/appleSpeech";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import {
  beginHeldDictation,
  cancelHeldDictation,
  endHeldDictation,
} from "../speech/useDictationShortcut";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../speech/useEnvironmentSpeechInput";
import { useMattrApiConfig } from "../addons/mattrApi";
import { parseMattrPlanOverview } from "../components/chat/mattrPlanParser.mattr";
import {
  providerHasNativeGoals,
  withNativeGoalCommand,
} from "../components/chat/mattrInteractionMode.mattr";
import { approveMattrPlan } from "../components/chat/useMattrPlanApproval.mattr";
import { createMattrTasksActions } from "../components/tasks/mattrTasksStore";
import { primaryServerProvidersAtom } from "../state/server";
import { usePreparedConnection } from "../state/session";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { localEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { MattrVoiceModeBar } from "./MattrVoiceModeBar";
import { useHasVoiceModeHost } from "./voiceModeHost";
import { VoiceBriefingCoordinator } from "./VoiceBriefingCoordinator";
import { captureTaskTitle, composeCaptureText } from "./islandCapture";
import { EMPTY_ISLAND_THREAD_PREVIEW, summarizeThreadProjection } from "./islandThreadActivity";
import { useIslandSettings } from "./islandSettingsStore";
import {
  registerHostBridge,
  setVoiceModeOpen,
  toIslandVoiceAssistantState,
  toggleVoiceAssistantHandsFree,
  useVoiceAssistantState,
  type VoiceAssistantThreadScope,
} from "./voiceAssistantStore";
import { buildVoiceApiConfig } from "./voiceApiConfig";
import { encodeWav16k } from "./voiceModeAudio";
import type {
  IslandAction,
  IslandApprovalOption,
  IslandDoneNotification,
  IslandDroppedFile,
  IslandPendingApproval,
  IslandPendingPlan,
  IslandPendingUserInput,
  IslandSnapshot,
  IslandThreadSummary,
} from "../../../../antimatter/island/types";
import type {
  VoiceAssistantClientAction,
  VoiceAvailableTtsInfo,
  VoiceTranscribeResponse,
  VoiceWorkspaceContext,
} from "../../../../antimatter/voice-assistant/types";

const MAX_RECENT_THREADS = 12;
const MAX_DONE_NOTIFICATIONS = 8;
const MAX_WATCHED_RUNNING_THREADS = 6;
// Idle plan-mode threads are watched for a ready plan only among the most recent few.
const MAX_WATCHED_PLAN_THREADS = 3;
const MAX_CACHED_PLAN_OVERVIEWS = 16;
const SNAPSHOT_SYNC_INTERVAL_MS = 32;

function defaultApprovalOptions(): ReadonlyArray<IslandApprovalOption> {
  return [
    { decision: "accept", label: m(msg("Allow once")) },
    { decision: "acceptForSession", label: m(msg("Always allow this session")) },
    { decision: "decline", label: m(msg("Deny")) },
  ];
}

const planOverviewCache = new Map<
  string,
  { readonly markdown: string; readonly overview: ReturnType<typeof parseMattrPlanOverview> }
>();

/** The host re-renders on every streamed token; a plan is parsed again only when it changes. */
function cachedPlanOverview(planId: string, markdown: string) {
  const hit = planOverviewCache.get(planId);
  if (hit && hit.markdown === markdown) return hit.overview;
  const overview = parseMattrPlanOverview(markdown);
  planOverviewCache.delete(planId);
  planOverviewCache.set(planId, { markdown, overview });
  if (planOverviewCache.size > MAX_CACHED_PLAN_OVERVIEWS) {
    const oldest = planOverviewCache.keys().next();
    if (!oldest.done) planOverviewCache.delete(oldest.value);
  }
  return overview;
}

function currentTimestampIso(): string {
  return new Date().toISOString();
}

function approvalKindTitle(kind: string, appName?: string): string {
  if (appName) return appName;
  switch (kind) {
    case "command":
      return "Bash";
    case "file-change":
      return m(msg("File edit"));
    case "file-read":
      return m(msg("File read"));
    case "mcp":
      return m(msg("MCP tool"));
    default:
      return m(msg("Tool approval"));
  }
}

function mapThreadStatus(
  rawStatus: ReturnType<typeof resolveSidebarThreadStatus>,
  latestRunStatus: string | undefined,
): IslandThreadSummary["status"] {
  if (rawStatus === "approval") return "approval";
  if (rawStatus === "input" || rawStatus === "request") return "input";
  if (rawStatus === "working" || rawStatus === "waiting") return "running";
  if (rawStatus === "limited") return "limited";
  if (rawStatus === "failed" || (rawStatus === "ready" && latestRunStatus === "failed")) {
    return "failed";
  }
  if (rawStatus === "ready" && latestRunStatus === "completed") return "done";
  return "idle";
}

function isEditableElementFocused(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (!active) return false;
  if (active.tagName === "TEXTAREA" || active.tagName === "INPUT") return true;
  return (active as HTMLElement).isContentEditable === true;
}

export function MattrIslandHost() {
  const islandBridge = window.desktopBridge?.island;
  const settings = useIslandSettings();
  const assistantState = useVoiceAssistantState();
  const hasVoiceModeHost = useHasVoiceModeHost();
  const floatingVoiceMode = assistantState.sessionOpen && !hasVoiceModeHost;
  const [pageCard, setPageCard] = useState<HTMLElement | null>(null);
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams({ strict: false });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localEnvironmentId = useAtomValue(localEnvironmentIdAtom);
  const projects = useProjects();
  const environmentIds = useAtomValue(environmentSummaries.environmentIdsAtom);
  const voiceMicrophone = useClientSettings((s) => s.voiceMicrophone);
  const speechLanguage = useClientSettings((s) => s.speechLanguage);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const tasksApiConfig = useMattrApiConfig();

  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  // Captures and answers from the island report failures in the app: the island has no toasts.
  const startCaptureTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const respondToApprovalFromIsland = useOrchestrationCommand(threadEnvironment.respondToApproval);
  const respondToUserInputFromIsland = useOrchestrationCommand(
    threadEnvironment.respondToUserInput,
  );
  const dismissUserInputFromIsland = useAtomCommand(threadEnvironment.dismissUserInput);
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode);

  const [mainWindowFocused, setMainWindowFocused] = useState(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  const [draftText, setDraftText] = useState("");
  const [draftRevision, setDraftRevision] = useState(0);
  const [doneNotifications, setDoneNotifications] = useState<ReadonlyArray<IslandDoneNotification>>(
    [],
  );
  const [stateRevision, setStateRevision] = useState(0);
  const [deepgramAvailable, setDeepgramAvailable] = useState(false);

  const deepgramAvailableRef = useRef(deepgramAvailable);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps Deepgram availability fresh for Island IPC actions
  useEffect(() => {
    deepgramAvailableRef.current = deepgramAvailable;
  }, [deepgramAvailable]);

  const assistantHandsFreeRef = useRef(assistantState.handsFreeActive);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps hands-free state fresh for Island push-to-talk fallback
  useEffect(() => {
    assistantHandsFreeRef.current = assistantState.handsFreeActive;
  }, [assistantState.handsFreeActive]);

  const draftRef = useRef(draftText);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latest draft visible to async speech callbacks
  useEffect(() => {
    draftRef.current = draftText;
  }, [draftText]);

  const routeTarget = resolveThreadRouteTarget(routeParams);
  const routeThreadKey = routeTarget?.kind === "server" ? threadKey(routeTarget.threadRef) : null;
  const selectedThreadKey = routeThreadKey;

  const activeHostEnvironmentId =
    (routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : null) ??
    primaryEnvironmentId ??
    environmentIds[0] ??
    null;
  const primaryPrepared = Option.getOrNull(usePreparedConnection(activeHostEnvironmentId));
  const speechDestination = useVoiceTranscriptionDestination();

  const routeThreadKeyRef = useRef(routeThreadKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes the routed thread to focus listeners
  useEffect(() => {
    routeThreadKeyRef.current = routeThreadKey;
  }, [routeThreadKey]);

  // Done pins stay until opened or dismissed; the thread on screen counts as reviewed.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window focus/blur for notch visibility
  useEffect(() => {
    const clearRoutedDone = () => {
      const routed = routeThreadKeyRef.current;
      if (!routed) return;
      setDoneNotifications((existing) =>
        existing.some((entry) => entry.key === routed)
          ? existing.filter((entry) => entry.key !== routed)
          : existing,
      );
    };
    const onFocus = () => {
      setMainWindowFocused(true);
      clearRoutedDone();
    };
    const onBlur = () => {
      setMainWindowFocused(false);
      clearRoutedDone();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Subscribe to all environment shells & detect newly finished runs while unfocused
  const previousCompletedRunRef = useRef(new Map<string, string | null>());
  const initializedEnvsRef = useRef(new Set<EnvironmentId>());
  const mainFocusedRef = useRef(mainWindowFocused);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exposes live focus state to shell listeners
  useEffect(() => {
    mainFocusedRef.current = mainWindowFocused;
  }, [mainWindowFocused]);

  const needsLiveShells =
    Boolean(islandBridge && settings.enabled) ||
    assistantState.sessionOpen ||
    assistantState.handsFreeActive;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to connected environment thread shells for Island & Voice Mode snapshots
  useEffect(() => {
    if (!needsLiveShells) return;
    const unsubscribes: Array<() => void> = [];
    for (const environmentId of environmentIds) {
      const unsubscribe = appAtomRegistry.subscribe(
        environmentShell.stateValueAtom(environmentId),
        (shell) => {
          if (shell.status === "live" && Option.isSome(shell.snapshot)) {
            const initialized = initializedEnvsRef.current.has(environmentId);
            const subagentRequests = appAtomRegistry.get(
              environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
            );
            for (const raw of shell.snapshot.value.threads) {
              const key = threadKey({ environmentId, threadId: raw.id });
              const presented = presentThreadShell(
                environmentId,
                raw,
                subagentRequests.get(raw.id) ?? null,
              );
              const status = mapThreadStatus(
                resolveSidebarThreadStatus(presented),
                presented.latestRun?.status,
              );
              const outcome =
                status === "done"
                  ? ("completed" as const)
                  : status === "failed" || status === "limited"
                    ? status
                    : null;
              const finishedRunId = outcome ? (presented.latestRun?.runId ?? null) : null;
              const prevRunId = previousCompletedRunRef.current.get(key) ?? null;
              previousCompletedRunRef.current.set(key, finishedRunId);

              if (
                initialized &&
                outcome !== null &&
                finishedRunId !== null &&
                finishedRunId !== prevRunId &&
                raw.archivedAt === null &&
                !(mainFocusedRef.current && key === routeThreadKeyRef.current)
              ) {
                setDoneNotifications((existing) => {
                  const filtered = existing.filter((entry) => entry.key !== key);
                  return [
                    {
                      key,
                      environmentId,
                      threadId: raw.id,
                      threadTitle: presented.title || m(msg("Untitled thread")),
                      completedAt: Date.now(),
                      outcome,
                    },
                    ...filtered,
                  ].slice(0, MAX_DONE_NOTIFICATIONS);
                });
              }
            }
            initializedEnvsRef.current.add(environmentId);
          }
          setStateRevision((n) => n + 1);
        },
        { immediate: true },
      );
      unsubscribes.push(unsubscribe);
    }
    return () => {
      for (const stop of unsubscribes) stop();
    };
  }, [needsLiveShells, environmentIds]);

  // Collect raw shells across all environments
  const shellsByKey = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly raw: OrchestrationV2ThreadShell;
      readonly title: string;
      readonly status: IslandThreadSummary["status"];
      readonly runStartedAt: string | null;
      readonly runCompletedAt: string | null;
    }
  >();

  if (needsLiveShells) {
    const delegatedUnderParent = appAtomRegistry.get(
      environmentThreadShells.delegatedUnderParentAtom,
    );
    const hiddenKeys = appAtomRegistry.get(environmentThreadShells.hiddenThreadKeysAtom);

    for (const environmentId of environmentIds) {
      const shell = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) continue;
      const subagentRequests = appAtomRegistry.get(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      );
      for (const raw of shell.snapshot.value.threads) {
        if (raw.archivedAt !== null) continue;
        const ref: ScopedThreadRef = { environmentId, threadId: raw.id };
        const key = threadKey(ref);
        if (hiddenKeys.has(key)) continue;
        if (isShownUnderParent(ref, raw.lineage, delegatedUnderParent)) continue;
        const presented = presentThreadShell(
          environmentId,
          raw,
          subagentRequests.get(raw.id) ?? null,
        );
        const sidebarStatus = resolveSidebarThreadStatus(presented);
        const runStartedAt = raw.activityRunStartedAt ?? raw.latestRunStartedAt ?? null;
        const runCompletedAt = raw.activeRunId ? null : (raw.latestRunCompletedAt ?? null);
        shellsByKey.set(key, {
          environmentId,
          raw,
          title: presented.title || m(msg("Untitled thread")),
          status: mapThreadStatus(sidebarStatus, presented.latestRun?.status),
          runStartedAt: runStartedAt ? DateTime.formatIso(runStartedAt) : null,
          runCompletedAt: runCompletedAt ? DateTime.formatIso(runCompletedAt) : null,
        });
      }
    }
  }

  // Sort recent threads newest-first
  const sortedShells = [...shellsByKey.entries()]
    .toSorted(
      ([, a], [, b]) =>
        DateTime.toEpochMillis(b.raw.updatedAt) - DateTime.toEpochMillis(a.raw.updatedAt),
    )
    .slice(0, MAX_RECENT_THREADS);

  const scopedVoiceThreadKey = assistantState.scopedThread
    ? threadKey({
        environmentId: EnvironmentId.make(assistantState.scopedThread.environmentId),
        threadId: ThreadId.make(assistantState.scopedThread.threadId),
      })
    : null;

  const effectiveSelectedKey =
    (scopedVoiceThreadKey && shellsByKey.has(scopedVoiceThreadKey) ? scopedVoiceThreadKey : null) ??
    (selectedThreadKey && shellsByKey.has(selectedThreadKey) ? selectedThreadKey : null) ??
    sortedShells[0]?.[0] ??
    null;

  // Mount detail streams for the selected/scoped thread + any thread awaiting approval or user input
  const watchedDetailKeys = new Set<string>();
  if (effectiveSelectedKey) watchedDetailKeys.add(effectiveSelectedKey);
  if (scopedVoiceThreadKey) watchedDetailKeys.add(scopedVoiceThreadKey);
  let watchedRunning = 0;
  for (const [key, entry] of shellsByKey) {
    if (entry.status === "approval" || entry.status === "input") {
      watchedDetailKeys.add(key);
    } else if (entry.status === "running" && watchedRunning < MAX_WATCHED_RUNNING_THREADS) {
      watchedDetailKeys.add(key);
      watchedRunning += 1;
    }
  }
  const planThreadKeys = new Set<string>();
  for (const [key, entry] of sortedShells) {
    if (planThreadKeys.size >= MAX_WATCHED_PLAN_THREADS) break;
    if (entry.raw.interactionMode !== "plan" || entry.status === "running") continue;
    planThreadKeys.add(key);
    watchedDetailKeys.add(key);
  }
  const watchedDetailKeySignature = [...watchedDetailKeys].toSorted().join("\u0001");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to detail streams for Island preview & pending requests
  useEffect(() => {
    if (!needsLiveShells || watchedDetailKeySignature.length === 0) return;
    const keys = watchedDetailKeySignature.split("\u0001");
    const unsubscribes = keys.map((key) => {
      const ref = parseThreadKey(key);
      return appAtomRegistry.subscribe(
        environmentThreadDetails.stateAtom(ref),
        () => setStateRevision((n) => n + 1),
        { immediate: true },
      );
    });
    return () => {
      for (const stop of unsubscribes) stop();
    };
  }, [needsLiveShells, watchedDetailKeySignature]);

  // Resolve active thread environment for speech input
  const selectedRef = effectiveSelectedKey ? parseThreadKey(effectiveSelectedKey) : null;
  const speechEnvironmentId =
    selectedRef?.environmentId ??
    primaryEnvironmentId ??
    environmentIds[0] ??
    EnvironmentId.make("local");
  const selectedShell = effectiveSelectedKey
    ? (shellsByKey.get(effectiveSelectedKey) ?? null)
    : null;
  const projectByKey = new Map(
    projects.map((p) => [`${p.environmentId}:${p.id}`, p.title] as const),
  );
  const selectedProjectTitle = selectedShell
    ? (projectByKey.get(`${selectedShell.environmentId}:${selectedShell.raw.projectId}`) ?? null)
    : null;

  const speech = useEnvironmentSpeechInput({
    environmentId: speechEnvironmentId,
    projectId: selectedShell?.raw.projectId ?? null,
    projectName: selectedProjectTitle,
    ownerKey: "mattr-island-voice",
    disabled: !islandBridge || !settings.enabled,
    offerSetup: false,
    presented: true,
    readDraft: () => ({
      text: draftRef.current,
      selection: { start: draftRef.current.length, end: draftRef.current.length },
    }),
    // Island dictation always lands in the notch composer; Voice Mode handles spoken commands.
    commitDraft: (text) => {
      draftRef.current = text;
      setDraftText(text);
      setDraftRevision((n) => n + 1);
    },
  });

  // Build pending approvals, user inputs, and recent thread summaries once per render
  const providerByInstanceId = new Map(
    serverProviders.map((provider) => [provider.instanceId as string, provider] as const),
  );
  const planMarkdownById = new Map<string, string>();

  const { pendingApprovals, pendingUserInputs, pendingPlans, recentThreads } = (() => {
    void stateRevision;
    const approvals: IslandPendingApproval[] = [];
    const userInputs: IslandPendingUserInput[] = [];
    const plans: IslandPendingPlan[] = [];
    const threads: IslandThreadSummary[] = [];

    for (const key of planThreadKeys) {
      const entry = shellsByKey.get(key);
      if (!entry) continue;
      const projection = Option.getOrNull(
        appAtomRegistry.get(environmentThreadDetails.stateAtom(parseThreadKey(key))).data,
      );
      const plan = projection?.plans.findLast(
        (candidate) => candidate.kind === "proposed_plan" && candidate.status === "active",
      );
      if (!plan || plan.kind !== "proposed_plan") continue;
      const overview = cachedPlanOverview(plan.id, plan.markdown);
      planMarkdownById.set(plan.id, plan.markdown);
      plans.push({
        environmentId: entry.environmentId,
        threadId: entry.raw.id,
        threadTitle: entry.title,
        planId: plan.id,
        title: overview.title,
        steps: overview.steps.slice(0, 5).map((step) => step.text),
        stepCount: overview.steps.length,
        canApprove: entry.status !== "approval" && entry.status !== "input",
      });
    }

    for (const [key, entry] of shellsByKey) {
      if (entry.status !== "approval" && entry.status !== "input") continue;
      const ref = parseThreadKey(key);
      const pending = appAtomRegistry.get(environmentThreadDetails.pendingRequestsAtom(ref));
      if (!pending) continue;
      for (const approval of pending.approvals) {
        approvals.push({
          environmentId: entry.environmentId,
          threadId: entry.raw.id,
          threadTitle: entry.title,
          requestId: approval.requestId,
          requestKind: approval.requestKind,
          title: approvalKindTitle(approval.requestKind, approval.appName),
          detail: approval.detail ?? null,
          reason: approval.reason ?? null,
          canRespond: approval.responseCapability === "live",
          options:
            approval.options && approval.options.length > 0
              ? approval.options.map((opt) => ({
                  decision: opt.decision,
                  label: opt.label,
                  ...(opt.warning ? { warning: opt.warning } : {}),
                }))
              : defaultApprovalOptions(),
        });
      }
      for (const input of pending.userInputs) {
        userInputs.push({
          environmentId: entry.environmentId,
          threadId: entry.raw.id,
          threadTitle: entry.title,
          requestId: input.requestId,
          dismissible: input.dismissible,
          canRespond: input.responseCapability !== "not_resumable",
          questions: input.questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            multiSelect: q.multiSelect,
            allowCustomAnswer: q.allowCustomAnswer !== false,
            options: q.options.map((opt) => ({
              label: opt.label,
              value: opt.value ?? opt.label,
              ...(opt.description ? { description: opt.description } : {}),
            })),
          })),
        });
      }
    }

    const shellsForSummary = (() => {
      if (!scopedVoiceThreadKey) return sortedShells;
      if (sortedShells.some(([key]) => key === scopedVoiceThreadKey)) return sortedShells;
      const scopedEntry = shellsByKey.get(scopedVoiceThreadKey);
      if (!scopedEntry) return sortedShells;
      return [
        [scopedVoiceThreadKey, scopedEntry] as const,
        ...sortedShells.slice(0, MAX_RECENT_THREADS - 1),
      ];
    })();

    for (const [key, entry] of shellsForSummary) {
      const ref = parseThreadKey(key);
      const preview = watchedDetailKeys.has(key)
        ? summarizeThreadProjection(
            Option.getOrNull(appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)).data),
          )
        : EMPTY_ISLAND_THREAD_PREVIEW;
      threads.push({
        key,
        environmentId: entry.environmentId,
        threadId: entry.raw.id,
        title: entry.title,
        projectTitle: projectByKey.get(`${entry.environmentId}:${entry.raw.projectId}`) ?? null,
        status: entry.status,
        updatedAt: DateTime.formatIso(entry.raw.updatedAt),
        latestUserMessage: preview.latestUserMessage,
        latestAssistantMessage: preview.latestAssistantMessage,
        toolCallCount: preview.toolCallCount,
        isStreaming: preview.isStreaming,
        providerInstanceId: entry.raw.providerInstanceId,
        providerKind: providerByInstanceId.get(entry.raw.providerInstanceId)?.driver ?? null,
        providerName: providerByInstanceId.get(entry.raw.providerInstanceId)?.displayName ?? null,
        model: entry.raw.modelSelection.model,
        branch: entry.raw.branch,
        runStartedAt: entry.runStartedAt,
        runCompletedAt: entry.runCompletedAt,
        currentActivity: preview.currentActivity,
        recentActivities: preview.recentActivities,
        plan: preview.plan,
      });
    }

    return {
      pendingApprovals: approvals,
      pendingUserInputs: userInputs,
      pendingPlans: plans,
      recentThreads: threads,
    };
  })();

  const sendReplyToThread = useStableCallback(
    (
      environmentId: string,
      threadId: string,
      text: string,
      requestedMode: "default" | "plan" | "goal" = "default",
    ) => {
      const envId = EnvironmentId.make(environmentId);
      const tId = ThreadId.make(threadId);
      const key = threadKey({ environmentId: envId, threadId: tId });
      const shellEntry = shellsByKey.get(key);
      const trimmed = text.trim();
      if (!trimmed) return;
      // No prefix keeps the thread's own mode; /plan or /goal switches it.
      const interactionMode =
        requestedMode === "default"
          ? (shellEntry?.raw.interactionMode ?? "default")
          : requestedMode;
      const provider = shellEntry
        ? providerByInstanceId.get(shellEntry.raw.providerInstanceId)
        : undefined;
      const outgoing = withNativeGoalCommand({
        prompt: trimmed,
        interactionMode,
        nativeGoalStarted: shellEntry?.raw.interactionMode === "goal",
        attachmentCount: 0,
        nativeGoals: providerHasNativeGoals(
          provider?.driver ?? null,
          provider?.slashCommands,
          provider?.version,
        ),
      });
      void startCaptureTurn({
        environmentId: envId,
        input: {
          threadId: tId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoing,
            attachments: [],
          },
          ...(shellEntry?.raw.modelSelection
            ? { modelSelection: shellEntry.raw.modelSelection }
            : {}),
          runtimeMode: shellEntry?.raw.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode,
          createdAt: currentTimestampIso(),
        },
      });
    },
  );

  // "New thread" starts in the project (and with the model) of the thread the island targets.
  const referenceShell = effectiveSelectedKey
    ? (shellsByKey.get(effectiveSelectedKey) ?? null)
    : null;
  const referenceProject = referenceShell
    ? (projects.find(
        (project) =>
          project.environmentId === referenceShell.environmentId &&
          project.id === referenceShell.raw.projectId,
      ) ?? null)
    : null;

  const startCaptureThread = useStableCallback(
    (text: string, requestedMode: "default" | "plan" | "goal") => {
      if (!referenceShell || !referenceProject) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const threadId = newThreadId();
      const createdAt = currentTimestampIso();
      const { modelSelection, runtimeMode } = referenceShell.raw;
      const provider = providerByInstanceId.get(referenceShell.raw.providerInstanceId);
      const outgoing = withNativeGoalCommand({
        prompt: trimmed,
        interactionMode: requestedMode,
        nativeGoalStarted: false,
        attachmentCount: 0,
        nativeGoals: providerHasNativeGoals(
          provider?.driver ?? null,
          provider?.slashCommands,
          provider?.version,
        ),
      });
      const title = captureTaskTitle(trimmed, [], []);
      void startCaptureTurn({
        environmentId: referenceProject.environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text: outgoing, attachments: [] },
          modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode: requestedMode,
          bootstrap: {
            createThread: {
              projectId: referenceProject.id,
              title,
              modelSelection,
              runtimeMode,
              interactionMode: requestedMode,
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
    },
  );

  const createCaptureTask = useStableCallback(
    (text: string, files: ReadonlyArray<IslandDroppedFile>, urls: ReadonlyArray<string>) => {
      if (!tasksApiConfig) return;
      const title = captureTaskTitle(text, files, urls);
      if (!title) return;
      const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
      const note = composeCaptureText(text.trim().slice(firstLine.length), files, urls);
      void createMattrTasksActions(tasksApiConfig)
        .create({
          title,
          ...(note ? { note } : {}),
          ...(referenceShell ? { projectId: referenceShell.raw.projectId } : {}),
        })
        .catch((error: unknown) => console.warn("Island could not create a task", error));
    },
  );

  const approveIslandPlan = useStableCallback(
    (environmentId: string, threadId: string, planId: string) => {
      const envId = EnvironmentId.make(environmentId);
      const tId = ThreadId.make(threadId);
      const shellEntry = shellsByKey.get(threadKey({ environmentId: envId, threadId: tId }));
      const markdown = planMarkdownById.get(planId);
      if (!shellEntry || markdown === undefined) return;
      void approveMattrPlan({
        threadRef: { environmentId: envId, threadId: tId },
        planId: PlanId.make(planId),
        planMarkdown: markdown,
        thread: {
          interactionMode: shellEntry.raw.interactionMode,
          runtimeMode: shellEntry.raw.runtimeMode,
        },
        setInteractionMode,
        startTurn: startCaptureTurn,
      });
    },
  );

  const getRoutedThread = useStableCallback((): VoiceAssistantThreadScope | null => {
    if (routeTarget?.kind !== "server" || routeThreadKey === null) return null;
    const { environmentId, threadId } = routeTarget.threadRef;
    const title = shellsByKey.get(routeThreadKey)?.title;
    return { environmentId, threadId, title: title || m(msg("Untitled thread")) };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finds the visible page card (outside this tree) for the floating Voice Mode bar
  useEffect(() => {
    if (!floatingVoiceMode) return;
    const frame = requestAnimationFrame(() =>
      setPageCard(
        Array.from(document.querySelectorAll<HTMLElement>('main[data-slot="sidebar-inset"]')).find(
          (main) => main.checkVisibility(),
        ) ?? null,
      ),
    );
    return () => cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each route mounts its own page card
  }, [floatingVoiceMode, location.pathname]);

  // Register live host bridge for VoiceAssistantStore (hands-free Voice Mode + Assistant + Briefings)
  const buildWorkspaceContext = useStableCallback((): VoiceWorkspaceContext => {
    const scoped = assistantState.scopedThread;
    const activeEnvId =
      scoped?.environmentId ??
      selectedRef?.environmentId ??
      primaryEnvironmentId ??
      environmentIds[0] ??
      null;
    const activeThreadId = scoped?.threadId ?? selectedRef?.threadId ?? null;
    const activeKey = scopedVoiceThreadKey ?? effectiveSelectedKey;
    return {
      activeEnvironmentId: activeEnvId,
      activeThreadId,
      activeRoute: location.pathname,
      mainWindowFocused,
      composerFocused: isEditableElementFocused(),
      projects: projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
        archived: p.archivedAt !== null,
      })),
      threads: recentThreads.map((t) => ({
        environmentId: t.environmentId,
        threadId: t.threadId,
        title: t.title,
        projectId: shellsByKey.get(t.key)?.raw.projectId ?? null,
        projectTitle: t.projectTitle,
        status: t.status,
        updatedAt: t.updatedAt,
        latestUserMessage: t.latestUserMessage,
        latestAssistantMessage: t.latestAssistantMessage,
        isActive: t.key === activeKey,
      })),
      pendingApprovals: pendingApprovals.map((a) => ({
        environmentId: a.environmentId,
        threadId: a.threadId,
        threadTitle: a.threadTitle,
        requestId: a.requestId,
        requestKind: a.requestKind,
        title: a.title,
        detail: a.detail,
        reason: a.reason,
      })),
      pendingQuestions: pendingUserInputs.map((q) => ({
        environmentId: q.environmentId,
        threadId: q.threadId,
        threadTitle: q.threadTitle,
        requestId: q.requestId,
        questions: q.questions.map((item) => ({
          id: item.id,
          header: item.header,
          question: item.question,
          options: item.options.map((opt) => opt.label),
        })),
      })),
    };
  });

  const executeAssistantClientAction = useStableCallback(
    async (action: VoiceAssistantClientAction) => {
      switch (action.type) {
        case "navigate-thread": {
          void navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: EnvironmentId.make(action.environmentId),
              threadId: ThreadId.make(action.threadId),
            },
          });
          return;
        }
        case "navigate-route": {
          void navigate({ to: action.to as "/" });
          return;
        }
        case "focus-window": {
          window.focus();
          return;
        }
        case "insert-dictation": {
          if (action.autoSend && selectedRef) {
            sendReplyToThread(selectedRef.environmentId, selectedRef.threadId, action.text);
          } else {
            draftRef.current = action.text;
            setDraftText(action.text);
            setDraftRevision((n) => n + 1);
          }
          return;
        }
        case "respond-approval": {
          await respondToApproval({
            environmentId: EnvironmentId.make(action.environmentId),
            input: {
              threadId: ThreadId.make(action.threadId),
              requestId: RuntimeRequestId.make(action.requestId),
              decision: action.decision as ProviderApprovalDecision,
            },
          });
          return;
        }
        case "respond-question": {
          await respondToUserInput({
            environmentId: EnvironmentId.make(action.environmentId),
            input: {
              threadId: ThreadId.make(action.threadId),
              requestId: RuntimeRequestId.make(action.requestId),
              answers: action.answers,
            },
          });
          return;
        }
        case "dismiss-question": {
          await dismissUserInput({
            environmentId: EnvironmentId.make(action.environmentId),
            input: {
              threadId: ThreadId.make(action.threadId),
              requestId: RuntimeRequestId.make(action.requestId),
            },
          });
          return;
        }
      }
    },
  );

  const getApiBaseUrlAndHeaders = useStableCallback(() =>
    buildVoiceApiConfig(primaryPrepared, window.location.origin),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes server TTS/STT availability once connected and refreshes when credentials change
  useEffect(() => {
    let disposed = false;
    const { baseUrl, headers, credentials } = buildVoiceApiConfig(
      primaryPrepared,
      window.location.origin,
    );
    const probe = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/mattr/voice-assistant/tts-info`, {
          method: "GET",
          headers,
          credentials,
        });
        if (!response.ok || disposed) return;
        const info = (await response.json()) as Partial<VoiceAvailableTtsInfo>;
        if (!disposed) {
          setDeepgramAvailable(info.deepgramAvailable === true);
        }
      } catch {
        // Ignore transient probe errors when server is starting or offline.
      }
    };
    void probe();
    const onCredentialsChanged = () => {
      void probe();
    };
    window.addEventListener("mattr:voice-credentials-changed", onCredentialsChanged);
    return () => {
      disposed = true;
      window.removeEventListener("mattr:voice-credentials-changed", onCredentialsChanged);
    };
  }, [primaryPrepared]);

  const transcribePcm = useStableCallback(async (pcm16k: Float32Array): Promise<string> => {
    // Prefer server-side Deepgram Nova-3 STT first when configured.
    try {
      const apiConfig = getApiBaseUrlAndHeaders();
      const base = apiConfig.baseUrl.replace(/\/+$/, "");
      const langQuery =
        speechLanguage && speechLanguage !== "auto"
          ? `?language=${encodeURIComponent(speechLanguage)}`
          : "";
      const wavBlob = encodeWav16k(pcm16k);
      const response = await fetch(`${base}/api/mattr/voice-assistant/transcribe${langQuery}`, {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          ...apiConfig.headers,
        },
        credentials: apiConfig.credentials,
        body: wavBlob,
      });
      if (response.ok) {
        const json = (await response.json()) as VoiceTranscribeResponse;
        return (json.text ?? "").trim();
      }
    } catch {
      // Fall through cleanly to Apple Speech, environment speech, or cloud speech.
    }

    const pcmBytes = new Uint8Array(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);

    // Prefer macOS 26 on-device Apple Speech when configured or available on desktop
    const appleSpeech = window.desktopBridge?.appleSpeech;
    if (appleSpeech && (speechDestination.device || !speechDestination.prepared)) {
      const availableLocales = readAppleSpeechLocales();
      const resolvedLocale = resolveAppleSpeechLocale(
        availableLocales,
        speechLanguage === "auto" ? navigator.language : speechLanguage,
        navigator.languages,
      );
      if (resolvedLocale) {
        const result = await appleSpeech.transcribe({
          locale: resolvedLocale,
          pcm: pcmBytes,
        });
        if (result.ok && result.value.trim()) return result.value.trim();
      }
    }

    const prepared = speechDestination.prepared ?? primaryPrepared;
    if (!prepared) {
      throw new Error("No transcription server connected. Configure Voice in Settings.");
    }
    const options = {
      speechLanguage,
      speechTranslateToEnglish: false,
      speechCustomWords: [],
      speechRemoveFillerWords: true,
      speechSilenceFiltering: true,
    };
    const result = await runEnvironmentSpeech(
      speechDestination.cloudProvider
        ? transcribeCloudPcm(
            prepared,
            speechDestination.cloudProvider,
            pcmBytes,
            options,
            () => true,
            speechDestination.cloudModel,
          )
        : transcribeEnvironmentPcm(prepared, pcmBytes, options, () => true),
    );
    return result.text.trim();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers live host callbacks into the VoiceAssistantStore
  useEffect(() => {
    return registerHostBridge({
      getWorkspaceContext: buildWorkspaceContext,
      getRoutedThread,
      executeClientAction: executeAssistantClientAction,
      transcribePcm,
      getApiBaseUrlAndHeaders,
      getMicrophoneId: () => voiceMicrophone,
    });
  }, [
    buildWorkspaceContext,
    getRoutedThread,
    executeAssistantClientAction,
    transcribePcm,
    getApiBaseUrlAndHeaders,
    voiceMicrophone,
  ]);

  // Keep voice refs fresh for IPC action handler
  const speechRef = useRef(speech);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latest speech callbacks available to IPC actions
  useEffect(() => {
    speechRef.current = speech;
  });

  const handleIslandAction = useStableCallback((rawAction: unknown) => {
    if (typeof rawAction !== "object" || rawAction === null || !("type" in rawAction)) return;
    const action = rawAction as IslandAction;

    switch (action.type) {
      case "open-thread": {
        const key = threadKey({
          environmentId: EnvironmentId.make(action.environmentId),
          threadId: ThreadId.make(action.threadId),
        });
        setDoneNotifications((existing) => existing.filter((item) => item.key !== key));
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: EnvironmentId.make(action.environmentId),
            threadId: ThreadId.make(action.threadId),
          },
        });
        return;
      }
      case "dismiss-done": {
        if (action.key) {
          setDoneNotifications((existing) => existing.filter((item) => item.key !== action.key));
        } else {
          setDoneNotifications([]);
        }
        return;
      }
      case "update-draft": {
        draftRef.current = action.text;
        setDraftText(action.text);
        return;
      }
      case "voice-start": {
        if (!speechRef.current.available && deepgramAvailableRef.current) {
          if (!assistantHandsFreeRef.current) toggleVoiceAssistantHandsFree();
          return;
        }
        void speechRef.current.start();
        return;
      }
      case "voice-stop": {
        if (!speechRef.current.available && deepgramAvailableRef.current) {
          if (assistantHandsFreeRef.current) toggleVoiceAssistantHandsFree();
          return;
        }
        void speechRef.current.stop();
        return;
      }
      case "voice-cancel": {
        if (!speechRef.current.available && deepgramAvailableRef.current) {
          if (assistantHandsFreeRef.current) toggleVoiceAssistantHandsFree();
          return;
        }
        speechRef.current.cancel();
        return;
      }
      case "assistant-open-voice-mode-modal": {
        window.focus();
        setVoiceModeOpen(true);
        return;
      }
      case "open-voice-settings": {
        void navigate({ to: "/settings/voice", hash: "voice-transcription-destination" });
        return;
      }
      case "open-island-settings": {
        void navigate({ to: "/settings/general", hash: "mattr-island" });
        return;
      }
      case "submit-capture": {
        const text = composeCaptureText(action.text, action.files, action.urls);
        draftRef.current = "";
        setDraftText("");
        if (action.target.kind === "thread") {
          sendReplyToThread(
            action.target.environmentId,
            action.target.threadId,
            text,
            action.interactionMode,
          );
        } else if (action.target.kind === "new-thread") {
          startCaptureThread(text, action.interactionMode);
        } else {
          createCaptureTask(action.text, action.files, action.urls);
        }
        return;
      }
      case "approve-plan": {
        approveIslandPlan(action.environmentId, action.threadId, action.planId);
        return;
      }
      case "respond-approval": {
        void respondToApprovalFromIsland({
          environmentId: EnvironmentId.make(action.environmentId),
          input: {
            threadId: ThreadId.make(action.threadId),
            requestId: RuntimeRequestId.make(action.requestId),
            decision: action.decision as ProviderApprovalDecision,
          },
        });
        return;
      }
      case "respond-user-input": {
        void respondToUserInputFromIsland({
          environmentId: EnvironmentId.make(action.environmentId),
          input: {
            threadId: ThreadId.make(action.threadId),
            requestId: RuntimeRequestId.make(action.requestId),
            answers: action.answers,
          },
        });
        return;
      }
      case "dismiss-user-input": {
        void dismissUserInputFromIsland({
          environmentId: EnvironmentId.make(action.environmentId),
          input: {
            threadId: ThreadId.make(action.threadId),
            requestId: RuntimeRequestId.make(action.requestId),
          },
        });
        return;
      }
      case "close-panel":
        return;
      case "composer-dictation-hold": {
        if (action.phase === "start") beginHeldDictation();
        else if (action.phase === "end") endHeldDictation();
        else cancelHeldDictation();
        return;
      }
    }
  });

  // Subscribe to Island actions from Electron main process
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop Island IPC action events
  useEffect(() => {
    if (!islandBridge) return;
    return islandBridge.onAction(handleIslandAction);
  }, [islandBridge, handleIslandAction]);

  // Build IslandSnapshot in render and sync to Electron
  const snapshot: IslandSnapshot | null = islandBridge
    ? {
        theme: resolvedTheme,
        mainWindowFocused,
        settings,
        doneNotifications,
        pendingApprovals,
        pendingUserInputs,
        pendingPlans,
        recentThreads,
        selectedThreadKey: effectiveSelectedKey,
        canStartThread: referenceProject !== null,
        canCreateTask: tasksApiConfig !== null,
        localEnvironmentId,
        voice: {
          phase: speech.state.phase,
          level: speech.level,
          previewCommitted: speech.preview?.committed ?? "",
          previewTentative: speech.preview?.tentative ?? "",
          draftText,
          draftRevision,
          error: speech.state.phase === "error" ? speech.state.error : null,
          available: speech.available || deepgramAvailable,
        },
        assistant: toIslandVoiceAssistantState(assistantState),
      }
    : null;

  const lastSnapshotSyncRef = useRef(0);
  const pendingSnapshotRef = useRef<IslandSnapshot | null>(null);
  const trailingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Streaming tokens and audio levels re-render this host many times a second; the trailing
  // flush keeps IPC at ~30Hz without ever dropping the final state.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes Island state snapshots to the floating Electron panel
  useEffect(() => {
    if (!islandBridge || !snapshot) return;
    pendingSnapshotRef.current = snapshot;
    const flush = () => {
      trailingSyncTimerRef.current = null;
      const next = pendingSnapshotRef.current;
      if (!next) return;
      pendingSnapshotRef.current = null;
      lastSnapshotSyncRef.current = Date.now();
      void islandBridge.syncSnapshot(next).catch(() => undefined);
    };
    const wait = SNAPSHOT_SYNC_INTERVAL_MS - (Date.now() - lastSnapshotSyncRef.current);
    if (wait <= 0) {
      flush();
    } else if (trailingSyncTimerRef.current === null) {
      trailingSyncTimerRef.current = setTimeout(flush, wait);
    }
  }, [islandBridge, snapshot]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the trailing IPC flush timer on unmount
  useEffect(
    () => () => {
      if (trailingSyncTimerRef.current !== null) clearTimeout(trailingSyncTimerRef.current);
    },
    [],
  );

  return (
    <>
      <VoiceBriefingCoordinator />
      {floatingVoiceMode
        ? createPortal(
            <div
              className={cn(
                "pointer-events-none inset-x-0 bottom-4 z-40 flex justify-end px-6",
                pageCard ? "absolute" : "fixed",
              )}
            >
              <div className="w-full max-w-xl">
                <MattrVoiceModeBar variant="floating" />
              </div>
            </div>,
            pageCard ?? document.body,
          )
        : null}
    </>
  );
}
