import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { msg } from "gt-react-native";

import type {
  VoiceAssistantClientAction,
  VoiceWorkspaceContext,
} from "../../../../../antimatter/voice-assistant/types";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, sessionHasScope } from "../../state/session";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import {
  buildVoiceWorkspaceContext,
  type VoiceContextApprovalInput,
  type VoiceContextQuestionInput,
} from "./voiceContextLogic";

type ThreadShell = ReturnType<typeof readShells>[number];

function readShells() {
  return appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
}

function hasPendingRequest(shell: ThreadShell) {
  return shell.hasPendingApprovals || shell.hasPendingUserInput;
}

function readPending(shells: ReadonlyArray<ThreadShell>) {
  const approvals: VoiceContextApprovalInput[] = [];
  const questions: VoiceContextQuestionInput[] = [];
  for (const shell of shells) {
    if (shell.archivedAt !== null || !hasPendingRequest(shell)) continue;
    const pending = appAtomRegistry.get(
      environmentThreadDetails.pendingRequestsAtom({
        environmentId: shell.environmentId,
        threadId: shell.id,
      }),
    );
    if (!pending) continue;
    for (const approval of pending.approvals) {
      // A request its provider can no longer answer would only read out as a dead end.
      if (approval.responseCapability !== "live") continue;
      approvals.push({
        environmentId: shell.environmentId,
        threadId: shell.id,
        requestId: approval.requestId,
        requestKind: approval.requestKind,
        appName: approval.appName,
        detail: approval.detail,
        reason: approval.reason,
      });
    }
    for (const input of pending.userInputs) {
      if (input.responseCapability === "not_resumable") continue;
      questions.push({
        environmentId: shell.environmentId,
        threadId: shell.id,
        requestId: input.requestId,
        questions: input.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({ label: option.label })),
        })),
      });
    }
  }
  return { approvals, questions };
}

/** Reads the phone's current projects, threads and pending requests for a voice turn. */
export function readVoiceWorkspaceContext(): VoiceWorkspaceContext {
  const shells = readShells();
  const { approvals, questions } = readPending(shells);
  const newest = shells
    .filter((shell) => shell.archivedAt === null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return buildVoiceWorkspaceContext({
    activeEnvironmentId: newest?.environmentId ?? null,
    activeThreadId: null,
    activeRoute: "MattrVoiceMode",
    projects: appAtomRegistry.get(environmentProjects.projectsAtom).map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      archivedAt: project.archivedAt ?? null,
    })),
    threads: shells.map((shell) => ({
      environmentId: shell.environmentId,
      id: shell.id,
      title: shell.title,
      projectId: shell.projectId,
      updatedAt: shell.updatedAt,
      archivedAt: shell.archivedAt,
      hasPendingApprovals: shell.hasPendingApprovals,
      hasPendingUserInput: shell.hasPendingUserInput,
      runStatus: shell.latestRun?.status ?? null,
      limited: shell.limitRecovery != null,
    })),
    approvals,
    questions,
  });
}

/**
 * Calls `onChange` whenever the thread list or a pending approval or question changes. Pending
 * requests stream with their thread's detail, so each such thread is subscribed while it waits.
 */
export function watchVoiceWorkspace(onChange: () => void): () => void {
  const detailWatches = new Map<string, () => void>();
  const syncDetailWatches = () => {
    const wanted = new Map<string, { environmentId: EnvironmentId; threadId: ThreadId }>();
    for (const shell of readShells()) {
      if (shell.archivedAt !== null || !hasPendingRequest(shell)) continue;
      const ref = { environmentId: shell.environmentId, threadId: shell.id };
      wanted.set(threadKey(ref), ref);
    }
    for (const [key, stop] of detailWatches) {
      if (wanted.has(key)) continue;
      stop();
      detailWatches.delete(key);
    }
    for (const [key, ref] of wanted) {
      if (detailWatches.has(key)) continue;
      detailWatches.set(
        key,
        appAtomRegistry.subscribe(environmentThreadDetails.pendingRequestsAtom(ref), onChange, {
          immediate: false,
        }),
      );
    }
  };
  const stopShells = appAtomRegistry.subscribe(
    environmentThreadShells.threadShellsAtom,
    () => {
      syncDetailWatches();
      onChange();
    },
    { immediate: true },
  );
  return () => {
    stopShells();
    for (const stop of detailWatches.values()) stop();
    detailWatches.clear();
  };
}

/**
 * The environment that answers voice turns: the one holding the newest thread when it is
 * connected with operate rights, else the first connected one.
 */
export function pickVoiceConnection(): PreparedConnection | null {
  const newest = readShells()
    .filter((shell) => shell.archivedAt === null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  const ordered = [...presentations.keys()].sort(
    (a, b) => Number(b === newest?.environmentId) - Number(a === newest?.environmentId),
  );
  for (const environmentId of ordered) {
    const presentation = presentations.get(environmentId);
    if (presentation?.connection.phase !== "connected") continue;
    if (
      !sessionHasScope(
        appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      )
    ) {
      continue;
    }
    const prepared = Option.getOrNull(
      appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    if (prepared) return prepared;
  }
  return null;
}

function requireSuccess<A, E>(result: AtomCommandResult<A, E>) {
  if (result._tag === "Success") return;
  const failure = squashAtomCommandFailure(result);
  throw failure instanceof Error ? failure : new Error(m(msg("The action didn't go through.")));
}

/** Applies the actions a voice turn asks the phone to take (answering requests, opening threads). */
export async function executeVoiceClientAction(
  action: VoiceAssistantClientAction,
  handlers: {
    readonly openThread: (target: { environmentId: string; threadId: string }) => void;
  },
): Promise<void> {
  switch (action.type) {
    case "navigate-thread":
      handlers.openThread({ environmentId: action.environmentId, threadId: action.threadId });
      return;
    case "respond-approval":
      requireSuccess(
        await runAtomCommand(appAtomRegistry, threadEnvironment.respondToApproval, {
          environmentId: EnvironmentId.make(action.environmentId),
          input: {
            threadId: ThreadId.make(action.threadId),
            requestId: RuntimeRequestId.make(action.requestId),
            decision: action.decision as ProviderApprovalDecision,
          },
        }),
      );
      return;
    case "respond-question":
      requireSuccess(
        await runAtomCommand(appAtomRegistry, threadEnvironment.respondToUserInput, {
          environmentId: EnvironmentId.make(action.environmentId),
          input: {
            threadId: ThreadId.make(action.threadId),
            requestId: RuntimeRequestId.make(action.requestId),
            answers: action.answers,
          },
        }),
      );
      return;
    case "dismiss-question":
      requireSuccess(
        await runAtomCommand(appAtomRegistry, threadEnvironment.dismissUserInput, {
          environmentId: EnvironmentId.make(action.environmentId),
          input: {
            threadId: ThreadId.make(action.threadId),
            requestId: RuntimeRequestId.make(action.requestId),
          },
        }),
      );
      return;
    // Window focus, routes and composer dictation are desktop ideas with no phone equivalent.
    case "navigate-route":
    case "focus-window":
    case "insert-dictation":
      return;
  }
}
