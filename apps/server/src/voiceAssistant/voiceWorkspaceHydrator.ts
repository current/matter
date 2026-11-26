import {
  isLiveSubagentShell,
  ProviderRequestKind,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  VoiceWorkspaceApprovalSummary,
  VoiceWorkspaceContext,
  VoiceWorkspaceProjectSummary,
  VoiceWorkspaceQuestionSummary,
  VoiceWorkspaceThreadSummary,
} from "../../../../matter/voice-assistant/types.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectService from "../project/ProjectService.ts";

const MAX_HYDRATED_THREADS = 40;
const MAX_CANDIDATE_SHELLS = 80;
const MAX_PROJECT_PAGES = 5;
const PROJECT_PAGE_LIMIT = 200;
const MAX_CHILD_TITLES = 5;
const MAX_ACTIVE_MESSAGE_READS = 12;
const DETAIL_READ_CONCURRENCY = 8;

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

const LIVE_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

export type VoiceHydratorProjectService = Pick<
  ProjectService.ProjectService["Service"],
  "listPage"
>;

export type VoiceHydratorThreadManagement = Partial<
  Pick<
    ThreadManagementService.ThreadManagementService["Service"],
    | "listProjectThreads"
    | "listActiveShellIndex"
    | "getShellSnapshot"
    | "getThreadRecords"
    | "getThreadProjection"
  >
>;

interface HydratedThreadDetails {
  readonly questions: ReadonlyArray<VoiceWorkspaceQuestionSummary>;
  readonly approvals: ReadonlyArray<VoiceWorkspaceApprovalSummary>;
  readonly latestUserMessage: string | null;
  readonly latestAssistantMessage: string | null;
}

function compactSnippet(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return null;
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function latestMessagesFromRecords(
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "role" | "text">>,
): {
  readonly latestUserMessage: string | null;
  readonly latestAssistantMessage: string | null;
} {
  let latestUserMessage: string | null = null;
  let latestAssistantMessage: string | null = null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) continue;
    if (latestUserMessage === null && message.role === "user") {
      latestUserMessage = compactSnippet(message.text, 200);
    } else if (latestAssistantMessage === null && message.role === "assistant") {
      latestAssistantMessage = compactSnippet(message.text, 280);
    }
    if (latestUserMessage !== null && latestAssistantMessage !== null) break;
  }
  return { latestUserMessage, latestAssistantMessage };
}

function extractPendingRequestsFromRecords(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): {
  readonly questions: ReadonlyArray<VoiceWorkspaceQuestionSummary>;
  readonly approvals: ReadonlyArray<VoiceWorkspaceApprovalSummary>;
} {
  const questions: Array<VoiceWorkspaceQuestionSummary> = [];
  const approvals: Array<VoiceWorkspaceApprovalSummary> = [];

  for (const request of input.runtimeRequests) {
    if (request.status !== "pending") continue;

    if (request.kind === "user_input") {
      const item = input.turnItems.find(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item?.type !== "user_input_request") continue;
      questions.push({
        environmentId: input.environmentId,
        threadId: input.threadId,
        threadTitle: input.threadTitle,
        requestId: request.id,
        questions: item.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isMultiSelect: question.multiSelect === true,
          options: question.options.map((option) => option.label),
          optionDetails: question.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        })),
      });
      continue;
    }

    if (isApprovalRequestKind(request.kind)) {
      const item = input.turnItems.find(
        (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
      );
      const prompt = item?.type === "approval_request" ? item.prompt : undefined;
      const reason = item?.type === "approval_request" ? item.reason : undefined;
      const appName = item?.type === "approval_request" ? item.appName : undefined;
      approvals.push({
        environmentId: input.environmentId,
        threadId: input.threadId,
        threadTitle: input.threadTitle,
        requestId: request.id,
        requestKind: request.kind,
        title: compactSnippet(prompt ?? appName, 120) ?? `${request.kind} approval`,
        detail: compactSnippet(prompt, 200),
        reason: compactSnippet(reason, 200),
      });
    }
  }

  return { questions, approvals };
}

function mapShellStatus(
  shell: OrchestrationV2ThreadShell,
  details: HydratedThreadDetails | undefined,
): VoiceWorkspaceThreadSummary["status"] {
  if (
    (details && details.approvals.length > 0) ||
    (shell.pendingRuntimeRequest !== null &&
      isApprovalRequestKind(shell.pendingRuntimeRequest.kind))
  ) {
    return "approval";
  }
  if (
    (details && details.questions.length > 0) ||
    shell.pendingRuntimeRequest?.kind === "user_input"
  ) {
    return "input";
  }
  if (
    LIVE_RUN_STATUSES.has(shell.status) ||
    (shell.activityRunStatus ?? null) !== null ||
    (shell.pendingBackgroundTasks?.length ?? 0) > 0
  ) {
    return "running";
  }
  if (shell.status === "failed") {
    return shell.lastErrorClass === "usage_limit" || shell.usageLimitResetAt ? "limited" : "failed";
  }
  if (shell.status === "completed") {
    return "done";
  }
  return "idle";
}

function shellUpdatedMs(shell: OrchestrationV2ThreadShell): number {
  return DateTime.toEpochMillis(shell.updatedAt);
}

const loadAllProjects = Effect.fn("voiceWorkspaceHydrator.loadAllProjects")(function* (
  projectService: VoiceHydratorProjectService,
) {
  const collected: Array<Project> = [];
  let cursor: number | null = 0;
  for (let pageIndex = 0; pageIndex < MAX_PROJECT_PAGES && cursor !== null; pageIndex++) {
    const page: {
      readonly projects: ReadonlyArray<Project>;
      readonly nextCursor: number | null;
    } | null = yield* projectService
      .listPage({ cursor, limit: PROJECT_PAGE_LIMIT })
      .pipe(Effect.orElseSucceed(() => null));
    if (page === null) break;
    collected.push(...page.projects);
    cursor = page.nextCursor;
  }
  return collected.filter((project) => project.archivedAt === null && project.deletedAt === null);
});

const readThreadDetails = Effect.fn("voiceWorkspaceHydrator.readThreadDetails")(function* (input: {
  readonly threadManagement: VoiceHydratorThreadManagement;
  readonly environmentId: string;
  readonly shell: OrchestrationV2ThreadShell;
  readonly includeRequests: boolean;
}): Effect.fn.Return<HydratedThreadDetails | null> {
  const { threadManagement, environmentId, shell, includeRequests } = input;
  const fields = includeRequests
    ? (["runtimeRequests", "turnItems", "messages"] as const)
    : (["messages"] as const);

  if (typeof threadManagement.getThreadRecords === "function") {
    const records = yield* threadManagement
      .getThreadRecords(shell.id, fields)
      .pipe(Effect.orElseSucceed(() => null));
    if (records === null) return null;
    const { latestUserMessage, latestAssistantMessage } = latestMessagesFromRecords(
      records.messages,
    );
    const pending = includeRequests
      ? extractPendingRequestsFromRecords({
          environmentId,
          threadId: shell.id,
          threadTitle: shell.title,
          runtimeRequests: "runtimeRequests" in records ? records.runtimeRequests : [],
          turnItems: "turnItems" in records ? records.turnItems : [],
        })
      : { questions: [], approvals: [] };
    return {
      questions: pending.questions,
      approvals: pending.approvals,
      latestUserMessage,
      latestAssistantMessage,
    };
  }

  if (typeof threadManagement.getThreadProjection === "function") {
    const projection = yield* threadManagement
      .getThreadProjection(shell.id)
      .pipe(Effect.orElseSucceed(() => null));
    if (projection === null) return null;
    const { latestUserMessage, latestAssistantMessage } = latestMessagesFromRecords(
      projection.messages,
    );
    const pending = includeRequests
      ? extractPendingRequestsFromRecords({
          environmentId,
          threadId: shell.id,
          threadTitle: shell.title,
          runtimeRequests: projection.runtimeRequests,
          turnItems: projection.turnItems,
        })
      : { questions: [], approvals: [] };
    return {
      questions: pending.questions,
      approvals: pending.approvals,
      latestUserMessage,
      latestAssistantMessage,
    };
  }

  return null;
});

/**
 * Hydrates authoritative server-side workspace state (projects, top-level + subagent thread
 * hierarchy, and all live pending questions/approvals) and merges cleanly with remote entries
 * supplied by the client.
 */
export const hydrateVoiceWorkspaceContext = Effect.fn(
  "voiceWorkspaceHydrator.hydrateVoiceWorkspaceContext",
)(function* (input: {
  readonly reqContext: VoiceWorkspaceContext;
  readonly localEnvironmentId: string;
  readonly projectService: VoiceHydratorProjectService;
  readonly threadManagement: VoiceHydratorThreadManagement;
}): Effect.fn.Return<VoiceWorkspaceContext> {
  const { reqContext, localEnvironmentId, projectService, threadManagement } = input;

  const serverProjects = yield* loadAllProjects(projectService);
  const projectById = new Map<string, VoiceWorkspaceProjectSummary>();
  for (const project of serverProjects) {
    projectById.set(project.id, {
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      archived: false,
    });
  }
  for (const clientProject of reqContext.projects) {
    if (!clientProject.archived && !projectById.has(clientProject.id)) {
      projectById.set(clientProject.id, clientProject);
    }
  }
  const mergedProjects = [...projectById.values()];

  if (
    typeof threadManagement.listProjectThreads !== "function" ||
    typeof threadManagement.getShellSnapshot !== "function"
  ) {
    return {
      ...reqContext,
      projects: mergedProjects,
    };
  }

  const [listedThreads, shellIndex] = yield* Effect.all(
    [
      threadManagement
        .listProjectThreads({ includeSubagents: true })
        .pipe(Effect.orElseSucceed(() => null)),
      typeof threadManagement.listActiveShellIndex === "function"
        ? threadManagement.listActiveShellIndex().pipe(Effect.orElseSucceed(() => null))
        : Effect.succeed(null),
    ],
    { concurrency: "unbounded" },
  );

  if (listedThreads === null || listedThreads.length === 0) {
    return {
      ...reqContext,
      projects: mergedProjects,
    };
  }

  const sortedEntries = listedThreads.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
  );
  const entryById = new Map(sortedEntries.map((entry) => [entry.id, entry]));
  const mayBeLiveIds = new Set<ThreadId>(
    (shellIndex ?? []).flatMap((entry) => (entry.mayBeLive ? [entry.id] : [])),
  );

  const candidateIds = new Set<ThreadId>();
  const addWithParents = (threadId: ThreadId) => {
    candidateIds.add(threadId);
    const entry = entryById.get(threadId);
    if (entry?.lineage.parentThreadId) {
      candidateIds.add(entry.lineage.parentThreadId);
    }
    if (entry?.lineage.rootThreadId) {
      candidateIds.add(entry.lineage.rootThreadId);
    }
  };

  for (const liveId of mayBeLiveIds) {
    if (entryById.has(liveId)) {
      addWithParents(liveId);
    }
  }
  if (reqContext.activeThreadId) {
    const activeId = ThreadId.make(reqContext.activeThreadId);
    if (entryById.has(activeId)) {
      addWithParents(activeId);
    }
  }
  for (const clientThread of reqContext.threads) {
    if (clientThread.environmentId === localEnvironmentId) {
      const id = ThreadId.make(clientThread.threadId);
      if (entryById.has(id)) {
        addWithParents(id);
      }
    }
  }
  for (const entry of sortedEntries) {
    if (candidateIds.size >= MAX_CANDIDATE_SHELLS) break;
    addWithParents(entry.id);
  }

  const initialSnapshot = yield* threadManagement
    .getShellSnapshot({ location: "active", threadIds: [...candidateIds] })
    .pipe(Effect.orElseSucceed(() => null));
  if (initialSnapshot === null || initialSnapshot.threads.length === 0) {
    return {
      ...reqContext,
      projects: mergedProjects,
    };
  }

  const shellById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const shell of initialSnapshot.threads) {
    if (shell.deletedAt === null && shell.archivedAt === null) {
      shellById.set(shell.id, shell);
    }
  }

  // Ensure every loaded subagent has its parent/root shell loaded too.
  const missingParentIds = new Set<ThreadId>();
  for (const shell of shellById.values()) {
    if (shell.lineage.parentThreadId && !shellById.has(shell.lineage.parentThreadId)) {
      missingParentIds.add(shell.lineage.parentThreadId);
    }
    if (shell.lineage.rootThreadId && !shellById.has(shell.lineage.rootThreadId)) {
      missingParentIds.add(shell.lineage.rootThreadId);
    }
  }
  if (missingParentIds.size > 0) {
    const parentSnapshot = yield* threadManagement
      .getShellSnapshot({ location: "active", threadIds: [...missingParentIds] })
      .pipe(Effect.orElseSucceed(() => null));
    if (parentSnapshot !== null) {
      for (const shell of parentSnapshot.threads) {
        if (shell.deletedAt === null && shell.archivedAt === null) {
          shellById.set(shell.id, shell);
        }
      }
    }
  }

  const childrenByParentId = new Map<ThreadId, Array<OrchestrationV2ThreadShell>>();
  for (const shell of shellById.values()) {
    if (
      shell.lineage.relationshipToParent === "subagent" &&
      shell.lineage.parentThreadId !== null
    ) {
      const bucket = childrenByParentId.get(shell.lineage.parentThreadId) ?? [];
      bucket.push(shell);
      childrenByParentId.set(shell.lineage.parentThreadId, bucket);
    }
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => {
      const leftLive = isLiveSubagentShell(left) ? 1 : 0;
      const rightLive = isLiveSubagentShell(right) ? 1 : 0;
      if (leftLive !== rightLive) return rightLive - leftLive;
      return shellUpdatedMs(right) - shellUpdatedMs(left);
    });
  }

  const pendingRequestShells: Array<OrchestrationV2ThreadShell> = [];
  const activeMessageOnlyShells: Array<OrchestrationV2ThreadShell> = [];
  for (const shell of shellById.values()) {
    if (shell.pendingRuntimeRequest !== null) {
      pendingRequestShells.push(shell);
    } else if (
      LIVE_RUN_STATUSES.has(shell.status) ||
      (shell.activityRunStatus ?? null) !== null ||
      (shell.pendingBackgroundTasks?.length ?? 0) > 0
    ) {
      activeMessageOnlyShells.push(shell);
    }
  }
  activeMessageOnlyShells.sort((left, right) => shellUpdatedMs(right) - shellUpdatedMs(left));

  const detailTargets: Array<{
    readonly shell: OrchestrationV2ThreadShell;
    readonly includeRequests: boolean;
  }> = [
    ...pendingRequestShells.map((shell) => ({ shell, includeRequests: true })),
    ...activeMessageOnlyShells
      .slice(0, MAX_ACTIVE_MESSAGE_READS)
      .map((shell) => ({ shell, includeRequests: false })),
  ];

  const detailEntries = yield* Effect.forEach(
    detailTargets,
    ({ shell, includeRequests }) =>
      readThreadDetails({
        threadManagement,
        environmentId: localEnvironmentId,
        shell,
        includeRequests,
      }).pipe(Effect.map((details) => [shell.id, details] as const)),
    { concurrency: DETAIL_READ_CONCURRENCY },
  );

  const detailsById = new Map<ThreadId, HydratedThreadDetails>();
  const hydratedQuestions: Array<VoiceWorkspaceQuestionSummary> = [];
  const hydratedApprovals: Array<VoiceWorkspaceApprovalSummary> = [];
  for (const [threadId, details] of detailEntries) {
    if (details === null) continue;
    detailsById.set(threadId, details);
    hydratedQuestions.push(...details.questions);
    hydratedApprovals.push(...details.approvals);
  }

  const activeChildCountOf = (threadId: ThreadId): number => {
    const children = childrenByParentId.get(threadId) ?? [];
    return children.filter((child) => isLiveSubagentShell(child)).length;
  };

  // Prioritize pending requests, then live work, active thread, and recent threads without
  // orphaning any subagent from its parent thread.
  const allShells = [...shellById.values()];
  const byUpdatedDesc = (left: OrchestrationV2ThreadShell, right: OrchestrationV2ThreadShell) =>
    shellUpdatedMs(right) - shellUpdatedMs(left);

  const pendingShells = allShells
    .filter((shell) => {
      const status = mapShellStatus(shell, detailsById.get(shell.id));
      return status === "approval" || status === "input" || shell.pendingRuntimeRequest !== null;
    })
    .toSorted(byUpdatedDesc);

  const runningShells = allShells
    .filter((shell) => {
      const status = mapShellStatus(shell, detailsById.get(shell.id));
      return status === "running" || activeChildCountOf(shell.id) > 0;
    })
    .toSorted(byUpdatedDesc);

  const topLevelShells = allShells
    .filter((shell) => shell.lineage.relationshipToParent !== "subagent")
    .toSorted(byUpdatedDesc);

  const otherSubagentShells = allShells
    .filter((shell) => shell.lineage.relationshipToParent === "subagent")
    .toSorted(byUpdatedDesc);

  const selectedIds = new Set<ThreadId>();
  const orderedSelected: Array<OrchestrationV2ThreadShell> = [];

  const selectShell = (shell: OrchestrationV2ThreadShell) => {
    if (selectedIds.has(shell.id)) return;
    selectedIds.add(shell.id);
    orderedSelected.push(shell);
  };

  const selectWithParent = (shell: OrchestrationV2ThreadShell) => {
    const parentId = shell.lineage.parentThreadId;
    if (parentId !== null) {
      const parentShell = shellById.get(parentId);
      if (parentShell !== undefined && !selectedIds.has(parentShell.id)) {
        selectShell(parentShell);
      }
    }
    selectShell(shell);
  };

  for (const shell of pendingShells) {
    if (orderedSelected.length >= MAX_HYDRATED_THREADS) break;
    selectWithParent(shell);
  }
  for (const shell of runningShells) {
    if (orderedSelected.length >= MAX_HYDRATED_THREADS) break;
    selectWithParent(shell);
  }
  if (reqContext.activeThreadId && orderedSelected.length < MAX_HYDRATED_THREADS) {
    const activeShell = shellById.get(ThreadId.make(reqContext.activeThreadId));
    if (activeShell !== undefined) {
      selectWithParent(activeShell);
    }
  }
  for (const shell of topLevelShells) {
    if (orderedSelected.length >= MAX_HYDRATED_THREADS) break;
    selectShell(shell);
  }
  for (const shell of otherSubagentShells) {
    if (orderedSelected.length >= MAX_HYDRATED_THREADS) break;
    selectWithParent(shell);
  }

  // Final guarantee: if adding a subagent pushed past MAX_HYDRATED_THREADS, trim from the end
  // without ever dropping a parent of a remaining subagent.
  const finalShells = orderedSelected.slice(0, MAX_HYDRATED_THREADS);
  const finalIdSet = new Set(finalShells.map((shell) => shell.id));
  for (const shell of finalShells) {
    const parentId = shell.lineage.parentThreadId;
    if (parentId !== null && !finalIdSet.has(parentId)) {
      const parentShell = shellById.get(parentId);
      if (parentShell !== undefined) {
        const dropIndex = finalShells.findLastIndex(
          (candidate) =>
            candidate.id !== shell.id &&
            !finalShells.some((other) => other.lineage.parentThreadId === candidate.id),
        );
        if (dropIndex >= 0) {
          const removed = finalShells.splice(dropIndex, 1)[0];
          if (removed) finalIdSet.delete(removed.id);
        }
        finalShells.push(parentShell);
        finalIdSet.add(parentShell.id);
      }
    }
  }

  const isLocalActiveEnv =
    reqContext.activeEnvironmentId === null ||
    reqContext.activeEnvironmentId === localEnvironmentId;

  const localThreadSummaries: Array<VoiceWorkspaceThreadSummary> = finalShells.map((shell) => {
    const details = detailsById.get(shell.id);
    const parentId = shell.lineage.parentThreadId;
    const parentTitle =
      parentId !== null
        ? (shellById.get(parentId)?.title ?? entryById.get(parentId)?.title ?? null)
        : null;
    const children = childrenByParentId.get(shell.id) ?? [];
    const activeChildCount = children.filter((child) => isLiveSubagentShell(child)).length;
    const childTitles = children.slice(0, MAX_CHILD_TITLES).map((child) => child.title);

    const visibleMsg = shell.latestVisibleMessage;
    const latestUserMessage =
      details?.latestUserMessage ??
      (visibleMsg?.role === "user" ? compactSnippet(visibleMsg.text, 200) : null);
    const latestAssistantMessage =
      details?.latestAssistantMessage ??
      (visibleMsg?.role === "assistant" ? compactSnippet(visibleMsg.text, 280) : null);

    return {
      environmentId: localEnvironmentId,
      threadId: shell.id,
      title: shell.title,
      projectId: shell.projectId,
      projectTitle: projectById.get(shell.projectId)?.title ?? null,
      status: mapShellStatus(shell, details),
      updatedAt: DateTime.formatIso(shell.updatedAt),
      latestUserMessage,
      latestAssistantMessage,
      isActive: isLocalActiveEnv && reqContext.activeThreadId === shell.id,
      parentThreadId: parentId,
      parentThreadTitle: parentTitle,
      relationshipToParent: shell.lineage.relationshipToParent === "subagent" ? "subagent" : null,
      activeChildCount,
      childTitles,
      providerInstanceId: shell.providerInstanceId,
      model: shell.modelSelection.model,
      branch: shell.branch,
    };
  });

  // Merge remote-environment threads (and any unknown local threads from client context).
  const seenThreads = new Set(
    localThreadSummaries.map((thread) => `${thread.environmentId}:${thread.threadId}`),
  );
  const mergedThreads: Array<VoiceWorkspaceThreadSummary> = [...localThreadSummaries];
  for (const clientThread of reqContext.threads) {
    const key = `${clientThread.environmentId}:${clientThread.threadId}`;
    if (seenThreads.has(key)) continue;
    if (clientThread.environmentId !== localEnvironmentId) {
      seenThreads.add(key);
      mergedThreads.push(clientThread);
    }
  }

  // Merge pending questions (deduplicating by environmentId + requestId).
  // Remote entries always merge; local client entries are only kept if that thread wasn't loaded
  // from the local server (so stale client entries for already-answered local requests drop).
  const seenQuestions = new Set(
    hydratedQuestions.map((entry) => `${entry.environmentId}:${entry.requestId}`),
  );
  const mergedQuestions: Array<VoiceWorkspaceQuestionSummary> = [...hydratedQuestions];
  for (const clientQuestion of reqContext.pendingQuestions) {
    const key = `${clientQuestion.environmentId}:${clientQuestion.requestId}`;
    if (seenQuestions.has(key)) continue;
    if (
      clientQuestion.environmentId !== localEnvironmentId ||
      !shellById.has(ThreadId.make(clientQuestion.threadId))
    ) {
      seenQuestions.add(key);
      mergedQuestions.push(clientQuestion);
    }
  }

  // Merge pending approvals (same deduplication & staleness rule).
  const seenApprovals = new Set(
    hydratedApprovals.map((entry) => `${entry.environmentId}:${entry.requestId}`),
  );
  const mergedApprovals: Array<VoiceWorkspaceApprovalSummary> = [...hydratedApprovals];
  for (const clientApproval of reqContext.pendingApprovals) {
    const key = `${clientApproval.environmentId}:${clientApproval.requestId}`;
    if (seenApprovals.has(key)) continue;
    if (
      clientApproval.environmentId !== localEnvironmentId ||
      !shellById.has(ThreadId.make(clientApproval.threadId))
    ) {
      seenApprovals.add(key);
      mergedApprovals.push(clientApproval);
    }
  }

  return {
    ...reqContext,
    projects: mergedProjects,
    threads: mergedThreads,
    pendingQuestions: mergedQuestions,
    pendingApprovals: mergedApprovals,
  };
});
