import type {
  VoiceAssistantHistoryMessage,
  VoiceWorkspaceApprovalSummary,
  VoiceWorkspaceContext,
  VoiceWorkspaceQuestionSummary,
  VoiceWorkspaceThreadSummary,
} from "../../../../../antimatter/voice-assistant/types";

export const MAX_VOICE_CONTEXT_THREADS = 12;
export const MAX_VOICE_HISTORY_MESSAGES = 12;

export interface VoiceContextProjectInput {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly archivedAt: string | null;
}

export interface VoiceContextThreadInput {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /** `latestRun.status` of the thread shell. */
  readonly runStatus: string | null;
  /** Server-reported usage limit pause. */
  readonly limited?: boolean;
}

export interface VoiceContextApprovalInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly requestKind: string;
  readonly appName?: string | undefined;
  readonly detail?: string | undefined;
  readonly reason?: string | undefined;
}

export interface VoiceContextQuestionInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{ readonly label: string }>;
  }>;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FAILED_RUN_STATUSES = new Set(["failed"]);

export function mapVoiceThreadStatus(
  input: Pick<
    VoiceContextThreadInput,
    "hasPendingApprovals" | "hasPendingUserInput" | "runStatus" | "limited"
  >,
): VoiceWorkspaceThreadSummary["status"] {
  if (input.hasPendingApprovals) return "approval";
  if (input.hasPendingUserInput) return "input";
  if (input.limited) return "limited";
  if (input.runStatus === null) return "idle";
  if (ACTIVE_RUN_STATUSES.has(input.runStatus)) return "running";
  if (FAILED_RUN_STATUSES.has(input.runStatus)) return "failed";
  if (input.runStatus === "completed") return "done";
  return "idle";
}

function humanizeRequestKind(requestKind: string): string {
  const words = requestKind.replaceAll(/[_-]+/g, " ").trim();
  // oxlint-disable-next-line t3code/no-untranslated-copy -- model-facing context sent to the voice assistant, not UI copy
  return words.length === 0 ? "Approval" : words.charAt(0).toUpperCase() + words.slice(1);
}

export function approvalTitle(approval: {
  readonly requestKind: string;
  readonly appName?: string | undefined;
}): string {
  return approval.appName ?? humanizeRequestKind(approval.requestKind);
}

export function buildVoiceWorkspaceContext(input: {
  readonly activeEnvironmentId: string | null;
  readonly activeThreadId: string | null;
  readonly activeRoute: string | null;
  readonly projects: ReadonlyArray<VoiceContextProjectInput>;
  readonly threads: ReadonlyArray<VoiceContextThreadInput>;
  readonly approvals: ReadonlyArray<VoiceContextApprovalInput>;
  readonly questions: ReadonlyArray<VoiceContextQuestionInput>;
}): VoiceWorkspaceContext {
  const projectTitles = new Map(input.projects.map((project) => [project.id, project.title]));
  const threadTitles = new Map(
    input.threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.title]),
  );
  const threadTitle = (environmentId: string, threadId: string) =>
    threadTitles.get(`${environmentId}:${threadId}`) ?? "Untitled thread";
  const recent = input.threads
    .filter((thread) => thread.archivedAt === null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_VOICE_CONTEXT_THREADS);
  return {
    activeEnvironmentId: input.activeEnvironmentId,
    activeThreadId: input.activeThreadId,
    activeRoute: input.activeRoute,
    // A phone has one foreground app; in a car the screen is often locked.
    mainWindowFocused: true,
    composerFocused: false,
    projects: input.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      archived: project.archivedAt !== null,
    })),
    threads: recent.map((thread) => ({
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      projectId: thread.projectId,
      projectTitle:
        thread.projectId === null ? null : (projectTitles.get(thread.projectId) ?? null),
      status: mapVoiceThreadStatus(thread),
      updatedAt: thread.updatedAt,
      latestUserMessage: null,
      latestAssistantMessage: null,
      isActive: thread.id === input.activeThreadId,
    })),
    pendingApprovals: input.approvals.map((approval): VoiceWorkspaceApprovalSummary => ({
      environmentId: approval.environmentId,
      threadId: approval.threadId,
      threadTitle: threadTitle(approval.environmentId, approval.threadId),
      requestId: approval.requestId,
      requestKind: approval.requestKind,
      title: approvalTitle(approval),
      detail: approval.detail ?? null,
      reason: approval.reason ?? null,
    })),
    pendingQuestions: input.questions.map((question): VoiceWorkspaceQuestionSummary => ({
      environmentId: question.environmentId,
      threadId: question.threadId,
      threadTitle: threadTitle(question.environmentId, question.threadId),
      requestId: question.requestId,
      questions: question.questions.map((item) => ({
        id: item.id,
        header: item.header,
        question: item.question,
        options: item.options.map((option) => option.label),
      })),
    })),
  };
}

/** Keeps the server prompt small: the newest messages only, oldest first. */
export function trimVoiceHistory(
  history: ReadonlyArray<VoiceAssistantHistoryMessage>,
  limit = MAX_VOICE_HISTORY_MESSAGES,
): ReadonlyArray<VoiceAssistantHistoryMessage> {
  return history.length <= limit ? history : history.slice(history.length - limit);
}

export interface VoiceTurnEntry {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolBadges: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly ok: boolean;
  }>;
}

export function historyFromTurns(
  turns: ReadonlyArray<VoiceTurnEntry>,
): ReadonlyArray<VoiceAssistantHistoryMessage> {
  return trimVoiceHistory(
    turns
      .filter((turn) => turn.text.trim().length > 0)
      .map((turn) => ({
        role: turn.role,
        text: turn.text,
        ...(turn.toolBadges.length > 0
          ? { toolSummary: turn.toolBadges.map((badge) => badge.label).join("; ") }
          : {}),
      })),
  );
}
