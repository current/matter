import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { transcribeCloudPcm, transcribeEnvironmentPcm } from "@t3tools/client-runtime/voice-input";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProviderApprovalDecision,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { msg } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTheme } from "../hooks/useTheme";
import { m } from "../i18n/messages";
import { newMessageId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readAppleSpeechLocales, resolveAppleSpeechLocale } from "../speech/appleSpeech";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../speech/useEnvironmentSpeechInput";
import { usePreparedConnection } from "../state/session";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
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
import { MattrVoiceModeModal } from "./MattrVoiceModeModal";
import { VoiceBriefingCoordinator } from "./VoiceBriefingCoordinator";
import { useIslandSettings } from "./islandSettingsStore";
import {
  bargeInVoiceAssistant,
  clearVoiceAssistantHistory,
  registerHostBridge,
  setVoiceAssistantModalOpen,
  setVoiceAssistantMode,
  submitVoiceAssistantUtterance,
  toIslandVoiceAssistantState,
  toggleVoiceAssistantHandsFree,
  toggleVoiceAssistantMute,
  useVoiceAssistantState,
} from "./voiceAssistantStore";
import type {
  IslandAction,
  IslandApprovalOption,
  IslandDoneNotification,
  IslandPendingApproval,
  IslandPendingUserInput,
  IslandSnapshot,
  IslandThreadSummary,
} from "../../../../antimatter/island/types";
import type {
  VoiceAssistantClientAction,
  VoiceWorkspaceContext,
} from "../../../../antimatter/voice-assistant/types";

const MAX_RECENT_THREADS = 12;
const MAX_DONE_NOTIFICATIONS = 8;

function defaultApprovalOptions(): ReadonlyArray<IslandApprovalOption> {
  return [
    { decision: "accept", label: m(msg("Allow once")) },
    { decision: "acceptForSession", label: m(msg("Always allow this session")) },
    { decision: "decline", label: m(msg("Deny")) },
  ];
}

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "mcp_tool_call",
  "web_search",
  "subagent",
]);

function currentTimestampIso(): string {
  return new Date().toISOString();
}

function truncateText(text: string, maxLength: number): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
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

function extractThreadConversationPreview(projection: OrchestrationV2ThreadProjection | null): {
  readonly latestUserMessage: string | null;
  readonly latestAssistantMessage: string | null;
  readonly toolCallCount: number;
  readonly isStreaming: boolean;
} {
  if (!projection) {
    return {
      latestUserMessage: null,
      latestAssistantMessage: null,
      toolCallCount: 0,
      isStreaming: false,
    };
  }

  let latestUserMessage: string | null = null;
  let latestAssistantMessage: string | null = null;
  let isStreaming = false;
  let latestRunId: string | null = null;

  for (let i = projection.messages.length - 1; i >= 0; i -= 1) {
    const message = projection.messages[i];
    if (!message) continue;
    if (latestAssistantMessage === null && message.role === "assistant" && message.text.trim()) {
      latestAssistantMessage = truncateText(message.text, 520);
      isStreaming = message.streaming;
      if (latestRunId === null && message.runId) latestRunId = message.runId;
    }
    if (latestUserMessage === null && message.role === "user" && message.text.trim()) {
      latestUserMessage = truncateText(message.text, 240);
      if (latestRunId === null && message.runId) latestRunId = message.runId;
    }
    if (latestUserMessage !== null && latestAssistantMessage !== null) break;
  }

  const targetRunId = latestRunId ?? projection.runs.at(-1)?.id ?? null;
  let toolCallCount = 0;
  for (const visible of projection.visibleTurnItems) {
    if (!TOOL_ITEM_TYPES.has(visible.item.type)) continue;
    if (targetRunId && visible.item.runId && visible.item.runId !== targetRunId) continue;
    toolCallCount += 1;
  }

  return { latestUserMessage, latestAssistantMessage, toolCallCount, isStreaming };
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
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams({ strict: false });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const environmentIds = useAtomValue(environmentSummaries.environmentIdsAtom);
  const voiceMicrophone = useClientSettings((s) => s.voiceMicrophone);
  const speechLanguage = useClientSettings((s) => s.speechLanguage);

  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });

  const [mainWindowFocused, setMainWindowFocused] = useState(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  const [selectionOverride, setSelectionOverride] = useState<{
    readonly routeKey: string | null;
    readonly pickedKey: string;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [doneNotifications, setDoneNotifications] = useState<ReadonlyArray<IslandDoneNotification>>(
    [],
  );
  const [stateRevision, setStateRevision] = useState(0);

  const draftRef = useRef(draftText);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps latest draft visible to async speech callbacks
  useEffect(() => {
    draftRef.current = draftText;
  }, [draftText]);

  const routeTarget = resolveThreadRouteTarget(routeParams);
  const routeThreadKey = routeTarget?.kind === "server" ? threadKey(routeTarget.threadRef) : null;
  const selectedThreadKey =
    selectionOverride && selectionOverride.routeKey === routeThreadKey
      ? selectionOverride.pickedKey
      : routeThreadKey;

  const activeHostEnvironmentId =
    (routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : null) ??
    primaryEnvironmentId ??
    environmentIds[0] ??
    null;
  const primaryPrepared = Option.getOrNull(usePreparedConnection(activeHostEnvironmentId));
  const speechDestination = useVoiceTranscriptionDestination();

  // Track main window focus/blur and clear done notifications when user returns to mattr
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window focus/blur for notch visibility
  useEffect(() => {
    const onFocus = () => {
      setMainWindowFocused(true);
      setDoneNotifications([]);
    };
    const onBlur = () => setMainWindowFocused(false);
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
    assistantState.modalOpen ||
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
              const status = resolveSidebarThreadStatus(presented);
              const completedRunId =
                status === "ready" && presented.latestRun?.status === "completed"
                  ? presented.latestRun.runId
                  : null;
              const prevRunId = previousCompletedRunRef.current.get(key) ?? null;
              previousCompletedRunRef.current.set(key, completedRunId);

              if (
                initialized &&
                completedRunId !== null &&
                completedRunId !== prevRunId &&
                raw.archivedAt === null &&
                !mainFocusedRef.current
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
        shellsByKey.set(key, {
          environmentId,
          raw,
          title: presented.title || m(msg("Untitled thread")),
          status: mapThreadStatus(sidebarStatus, presented.latestRun?.status),
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

  const effectiveSelectedKey =
    (selectedThreadKey && shellsByKey.has(selectedThreadKey) ? selectedThreadKey : null) ??
    sortedShells[0]?.[0] ??
    null;

  // Mount detail streams for the selected thread + any thread awaiting approval or user input
  const watchedDetailKeys = new Set<string>();
  if (effectiveSelectedKey) watchedDetailKeys.add(effectiveSelectedKey);
  for (const [key, entry] of shellsByKey) {
    if (entry.status === "approval" || entry.status === "input") {
      watchedDetailKeys.add(key);
    }
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

  const assistantModeRef = useRef(assistantState.mode);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps active voice panel mode visible to speech commit callback
  useEffect(() => {
    assistantModeRef.current = assistantState.mode;
  }, [assistantState.mode]);

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
    commitDraft: (text) => {
      const cleaned = text.trim();
      if (cleaned && assistantModeRef.current !== "dictation") {
        draftRef.current = "";
        setDraftText("");
        void submitVoiceAssistantUtterance(cleaned, {
          modeOverride: assistantModeRef.current,
        });
        return;
      }
      draftRef.current = text;
      setDraftText(text);
    },
  });

  // Build pending approvals, user inputs, and recent thread summaries once per render
  const { pendingApprovals, pendingUserInputs, recentThreads } = (() => {
    void stateRevision;
    const approvals: IslandPendingApproval[] = [];
    const userInputs: IslandPendingUserInput[] = [];
    const threads: IslandThreadSummary[] = [];

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

    for (const [key, entry] of sortedShells) {
      const ref = parseThreadKey(key);
      const detail =
        key === effectiveSelectedKey
          ? Option.getOrNull(appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)).data)
          : null;
      const preview = extractThreadConversationPreview(detail);
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
      });
    }

    return { pendingApprovals: approvals, pendingUserInputs: userInputs, recentThreads: threads };
  })();

  const sendReplyToThread = useStableCallback(
    (environmentId: string, threadId: string, text: string) => {
      const envId = EnvironmentId.make(environmentId);
      const tId = ThreadId.make(threadId);
      const key = threadKey({ environmentId: envId, threadId: tId });
      const shellEntry = shellsByKey.get(key);
      const trimmed = text.trim();
      if (!trimmed) return;
      draftRef.current = "";
      setDraftText("");
      void startTurn({
        environmentId: envId,
        input: {
          threadId: tId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: trimmed,
            attachments: [],
          },
          ...(shellEntry?.raw.modelSelection
            ? { modelSelection: shellEntry.raw.modelSelection }
            : {}),
          runtimeMode: shellEntry?.raw.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: shellEntry?.raw.interactionMode ?? "default",
          createdAt: currentTimestampIso(),
        },
      });
    },
  );

  // Register live host bridge for VoiceAssistantStore (hands-free Voice Mode + Assistant + Briefings)
  const buildWorkspaceContext = useStableCallback((): VoiceWorkspaceContext => {
    const activeEnvId =
      selectedRef?.environmentId ?? primaryEnvironmentId ?? environmentIds[0] ?? null;
    return {
      activeEnvironmentId: activeEnvId,
      activeThreadId: selectedRef?.threadId ?? null,
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
        isActive: t.key === effectiveSelectedKey,
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

  const getApiBaseUrlAndHeaders = useStableCallback(() => {
    const conn = primaryPrepared;
    const baseUrl = conn?.httpBaseUrl ?? window.location.origin;
    const headers: Record<string, string> = {};
    if (conn?.httpAuthorization?._tag === "Bearer") {
      headers.authorization = `Bearer ${conn.httpAuthorization.token}`;
    } else if (conn?.httpAuthorization?._tag === "Dpop") {
      headers.authorization = `Bearer ${conn.httpAuthorization.accessToken}`;
    }
    return {
      baseUrl,
      headers,
      credentials: "include" as const,
    };
  });

  const transcribePcm = useStableCallback(async (pcm16k: Float32Array): Promise<string> => {
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
      executeClientAction: executeAssistantClientAction,
      transcribePcm,
      getApiBaseUrlAndHeaders,
      getMicrophoneId: () => voiceMicrophone,
    });
  }, [
    buildWorkspaceContext,
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
      case "select-thread": {
        setSelectionOverride({ routeKey: routeThreadKey, pickedKey: action.threadKey });
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
        void speechRef.current.start();
        return;
      }
      case "voice-stop": {
        void speechRef.current.stop();
        return;
      }
      case "voice-cancel": {
        speechRef.current.cancel();
        return;
      }
      case "voice-toggle": {
        const phase = speechRef.current.state.phase;
        if (phase === "recording") {
          void speechRef.current.stop();
        } else if (phase === "idle" || phase === "error") {
          void speechRef.current.start();
        } else {
          speechRef.current.cancel();
        }
        return;
      }
      case "assistant-set-mode": {
        setVoiceAssistantMode(action.mode);
        return;
      }
      case "assistant-submit-text": {
        void submitVoiceAssistantUtterance(action.text);
        return;
      }
      case "assistant-toggle-hands-free": {
        toggleVoiceAssistantHandsFree();
        return;
      }
      case "assistant-toggle-mute": {
        toggleVoiceAssistantMute();
        return;
      }
      case "assistant-barge-in": {
        bargeInVoiceAssistant();
        return;
      }
      case "assistant-open-voice-mode-modal": {
        window.focus();
        setVoiceAssistantModalOpen(true);
        return;
      }
      case "assistant-clear-history": {
        clearVoiceAssistantHistory();
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
      case "send-reply": {
        sendReplyToThread(action.environmentId, action.threadId, action.text);
        return;
      }
      case "respond-approval": {
        void respondToApproval({
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
        void respondToUserInput({
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
        void dismissUserInput({
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
        recentThreads,
        selectedThreadKey: effectiveSelectedKey,
        voice: {
          phase: speech.state.phase,
          level: speech.level,
          previewCommitted: speech.preview?.committed ?? "",
          previewTentative: speech.preview?.tentative ?? "",
          draftText,
          error: speech.state.phase === "error" ? speech.state.error : null,
          available: speech.available,
        },
        assistant: toIslandVoiceAssistantState(assistantState),
      }
    : null;

  const lastLevelSyncRef = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes Island state snapshots to the floating Electron panel
  useEffect(() => {
    if (!islandBridge || !snapshot) return;
    const now = Date.now();
    const highFreq =
      snapshot.voice.phase === "recording" ||
      snapshot.assistant.phase === "listening" ||
      snapshot.assistant.phase === "speaking";
    if (highFreq && now - lastLevelSyncRef.current < 32) return;
    lastLevelSyncRef.current = now;
    void islandBridge.syncSnapshot(snapshot).catch(() => undefined);
  }, [islandBridge, snapshot]);

  return (
    <>
      <VoiceBriefingCoordinator />
      <MattrVoiceModeModal
        activeThreads={recentThreads}
        pendingApprovals={pendingApprovals}
        pendingUserInputs={pendingUserInputs}
        voiceLevel={speech.level}
        onApprove={(approval, decision) => {
          void respondToApproval({
            environmentId: EnvironmentId.make(approval.environmentId),
            input: {
              threadId: ThreadId.make(approval.threadId),
              requestId: RuntimeRequestId.make(approval.requestId),
              decision: decision as ProviderApprovalDecision,
            },
          });
        }}
        onOpenThread={(environmentId, threadId) => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: EnvironmentId.make(environmentId),
              threadId: ThreadId.make(threadId),
            },
          });
        }}
        onOpenSettings={() => {
          void navigate({ to: "/settings/general", hash: "mattr-voice-assistant" });
        }}
      />
    </>
  );
}
