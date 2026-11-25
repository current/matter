import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { monitorHoldsWakeCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Option from "effect/Option";
import { useEffect } from "react";

import { resolveBackgroundThreadRequest } from "../components/backgroundThreadAnnouncement";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../components/Sidebar.logic";
import {
  createThreadNotificationGate,
  isSnoozedForNotification,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "../components/ThreadNotificationCoordinator.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects } from "../state/entities";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadDetails, environmentThreadShells } from "../state/threads";
import type {
  VoiceAssistantSettings,
  VoiceBriefingKind,
  VoiceBriefingRequest,
} from "../../../../antimatter/voice-assistant/types";
import { getIslandSettings, useIslandSettings } from "./islandSettingsStore";
import { submitQuickBriefing, useVoiceAssistantState } from "./voiceAssistantStore";

const COMPLETION_COALESCE_MS = 2_500;

interface ObservedThreadState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
}

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, ObservedThreadState>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

function truncateBriefingText(text: string, maxLength: number): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractLatestAssistantMessage(
  projection: OrchestrationV2ThreadProjection | null,
): string | null {
  if (!projection) return null;
  for (let i = projection.messages.length - 1; i >= 0; i -= 1) {
    const message = projection.messages[i];
    if (message && message.role === "assistant" && message.text.trim()) {
      return truncateBriefingText(message.text, 360);
    }
  }
  return null;
}

function resolveProjectTitle(
  environmentId: EnvironmentId,
  projectId: string | null | undefined,
): string | null {
  if (!projectId) return null;
  const project = readProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  return project?.title ?? null;
}

function resolveBriefingKind(
  kind: ThreadNotificationKind,
  status: SidebarThreadStatus,
): VoiceBriefingKind | null {
  if (kind === "completion") return "completed";
  if (status === "approval") return "approval";
  if (status === "input" || status === "request") return "question";
  if (status === "failed") return "failed";
  if (status === "limited") return "limited";
  return null;
}

function isBriefingKindAllowed(kind: VoiceBriefingKind, settings: VoiceAssistantSettings): boolean {
  switch (kind) {
    case "approval":
      return settings.announceApprovals;
    case "question":
      return settings.announceQuestions;
    case "completed":
      return settings.announceCompletions;
    case "failed":
    case "limited":
      return settings.announceFailures;
  }
}

function buildBriefingRequest(
  environmentId: EnvironmentId,
  state: ObservedThreadState,
  briefingKind: VoiceBriefingKind,
): VoiceBriefingRequest {
  const ref: ScopedThreadRef = { environmentId, threadId: state.thread.id };
  const detailState = appAtomRegistry.get(environmentThreadDetails.stateAtom(ref));
  const projection = Option.getOrNull(detailState.data);
  const pendingRequests = appAtomRegistry.get(environmentThreadDetails.pendingRequestsAtom(ref));
  const latestAssistantMessage = extractLatestAssistantMessage(projection);
  const projectTitle = resolveProjectTitle(environmentId, state.raw.projectId);
  const threadTitle = state.thread.title || "Untitled thread";

  let detail: string | null = null;
  let questionPrompts: ReadonlyArray<string> | undefined;

  if (briefingKind === "approval") {
    const approval = pendingRequests?.approvals[0];
    if (approval) {
      detail = approval.detail ?? approval.reason ?? approval.appName ?? approval.requestKind;
    }
  } else if (briefingKind === "question") {
    const input = pendingRequests?.userInputs[0];
    if (input && input.questions.length > 0) {
      questionPrompts = input.questions.map((q) => q.question);
      detail = input.questions[0]?.header ?? input.questions[0]?.question ?? null;
    }
  } else if (briefingKind === "failed") {
    detail =
      appAtomRegistry.get(environmentThreadDetails.errorAtom(ref)) ??
      latestAssistantMessage ??
      null;
  } else if (briefingKind === "limited") {
    detail = "Usage limit reached";
  }

  return {
    kind: briefingKind,
    threadTitle,
    projectTitle,
    detail: detail ? truncateBriefingText(detail, 240) : null,
    latestAssistantMessage,
    ...(questionPrompts ? { questionPrompts } : {}),
  };
}

/**
 * Headless coordinator that watches connected environments for newly completed,
 * failed, limited, or attention-seeking threads and dispatches proactive voice
 * briefings while Hands-Free Voice Mode or the Voice Mode modal is active.
 */
export function VoiceBriefingCoordinator() {
  const settings = useIslandSettings();
  const assistantState = useVoiceAssistantState();

  const active =
    settings.voiceAssistant.proactiveBriefings &&
    (assistantState.handsFreeActive || assistantState.modalOpen);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to environment thread shells to emit proactive voice briefings while voice mode is active
  useEffect(() => {
    if (!active) return;

    const watched = new Map<EnvironmentId, WatchedEnvironment>();
    let pendingCompletions: VoiceBriefingRequest[] = [];
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

    const flushCompletions = () => {
      if (coalesceTimer !== null) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      if (pendingCompletions.length === 0) return;
      const batch = pendingCompletions;
      pendingCompletions = [];
      const first = batch[0]!;
      if (batch.length === 1) {
        submitQuickBriefing({ ...first, count: 1 });
        return;
      }
      submitQuickBriefing({
        ...first,
        count: batch.length,
        extraTitles: batch.slice(1).map((item) => item.threadTitle),
      });
    };

    const handleThreadEvent = (
      environmentId: EnvironmentId,
      state: ObservedThreadState,
      kind: ThreadNotificationKind,
    ) => {
      const hiddenKeys = appAtomRegistry.get(environmentThreadShells.hiddenThreadKeysAtom);
      if (hiddenKeys.has(threadKey({ environmentId, threadId: state.thread.id }))) return;

      const briefingKind = resolveBriefingKind(kind, state.status);
      if (!briefingKind) return;

      const voiceSettings = getIslandSettings().voiceAssistant;
      if (
        !voiceSettings.proactiveBriefings ||
        !isBriefingKindAllowed(briefingKind, voiceSettings)
      ) {
        return;
      }

      const request = buildBriefingRequest(environmentId, state, briefingKind);
      if (briefingKind === "completed") {
        pendingCompletions.push(request);
        if (coalesceTimer === null) {
          coalesceTimer = setTimeout(flushCompletions, COMPLETION_COALESCE_MS);
        }
        return;
      }

      submitQuickBriefing(request);
    };

    const observeThreads = (
      environmentId: EnvironmentId,
      entry: WatchedEnvironment,
      threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    ) => {
      const previous = entry.previous;
      const next = new Map<ThreadId, ObservedThreadState>();
      const subagentRequests = appAtomRegistry.get(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      );
      const delegatedUnderParent = appAtomRegistry.get(
        environmentThreadShells.delegatedUnderParentAtom,
      );
      const changed: Array<[ObservedThreadState | undefined, ObservedThreadState]> = [];

      for (const rawThread of threads) {
        if (
          isShownUnderParent(
            { environmentId, threadId: rawThread.id },
            rawThread.lineage,
            delegatedUnderParent,
          )
        ) {
          continue;
        }
        const prior = previous.get(rawThread.id);
        const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
        if (
          !entry.reconnecting &&
          prior?.raw === rawThread &&
          prior.subagentRequest === subagentRequest
        ) {
          next.set(rawThread.id, prior);
          continue;
        }
        const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
        let status = resolveSidebarThreadStatus(thread);
        if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
        const needsAttention =
          status === "input" ||
          status === "request" ||
          status === "approval" ||
          status === "failed" ||
          status === "limited";
        const requestId = needsAttention ? resolveBackgroundThreadRequest(thread).requestId : null;
        const attention = !needsAttention
          ? null
          : requestId !== null
            ? `${status}:${requestId}`
            : `${thread.latestRun?.runId ?? ""}:${status}`;
        const completed = status === "ready" && thread.latestRun?.status === "completed";
        const settled = completed && !monitorHoldsWakeCompletion(rawThread);
        const parsedCompletedAt = Date.parse(thread.latestRun?.completedAt ?? "");
        const completedAt = Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null;

        const state: ObservedThreadState = {
          raw: rawThread,
          subagentRequest,
          thread,
          status,
          attention,
          requestId,
          settled,
          completedAt: settled ? completedAt : null,
          backgroundWake: rawThread.latestRunBackgroundWake === true,
        };
        next.set(thread.id, state);
        changed.push([prior, state]);
      }

      entry.reconnecting = false;
      entry.previous = next;
      entry.gate.retain(new Set(next.keys()));
      const now = Date.now();
      for (const [prior, state] of changed) {
        entry.gate.observe(state.thread.id, prior, state, {
          archived: state.thread.archivedAt !== null,
          quiet: state.raw.latestRunStopRequested === true,
          snoozed: isSnoozedForNotification(state.thread, state.completedAt, now),
        });
      }
    };

    const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
      const entry: WatchedEnvironment = {
        previous: new Map(),
        reconnecting: false,
        unsubscribe: () => {},
        gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
          const observed = entry.previous.get(threadId);
          if (observed) handleThreadEvent(environmentId, observed, kind);
        }),
      };

      let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
      const unsubscribeShell = appAtomRegistry.subscribe(
        environmentShell.stateValueAtom(environmentId),
        (shell) => {
          threads =
            shell.status === "live" && Option.isSome(shell.snapshot)
              ? shell.snapshot.value.threads
              : null;
          if (threads !== null) {
            observeThreads(environmentId, entry, threads);
            return;
          }
          entry.reconnecting = true;
          entry.gate.pause();
        },
        { immediate: true },
      );

      const reobserve = () => {
        if (threads !== null) observeThreads(environmentId, entry, threads);
      };
      const unsubscribeRequests = appAtomRegistry.subscribe(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
        reobserve,
      );
      const unsubscribeDelegated = appAtomRegistry.subscribe(
        environmentThreadShells.delegatedUnderParentAtom,
        reobserve,
      );

      entry.unsubscribe = () => {
        unsubscribeShell();
        unsubscribeRequests();
        unsubscribeDelegated();
        entry.gate.clear();
      };
      return entry;
    };

    const syncEnvironments = () => {
      const currentIds = appAtomRegistry.get(environmentSummaries.environmentIdsAtom);
      const activeIds = new Set(currentIds);
      for (const [environmentId, entry] of watched) {
        if (activeIds.has(environmentId)) continue;
        entry.unsubscribe();
        watched.delete(environmentId);
      }
      for (const environmentId of currentIds) {
        if (!watched.has(environmentId)) {
          watched.set(environmentId, watchEnvironment(environmentId));
        }
      }
    };

    const unsubscribeEnvironmentIds = appAtomRegistry.subscribe(
      environmentSummaries.environmentIdsAtom,
      syncEnvironments,
    );
    syncEnvironments();

    return () => {
      unsubscribeEnvironmentIds();
      if (coalesceTimer !== null) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      pendingCompletions = [];
      for (const entry of watched.values()) entry.unsubscribe();
      watched.clear();
    };
  }, [active]);

  return null;
}
