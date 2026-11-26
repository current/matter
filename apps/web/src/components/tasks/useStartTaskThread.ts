import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  MatterTaskInteractionMode,
  MatterTaskWorkspaceMode,
  ModelSelection,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { newMessageId, newThreadId } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { vcsEnvironment } from "../../state/vcs";

export interface StartTaskThreadInput {
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: MatterTaskInteractionMode;
  readonly workspaceMode: MatterTaskWorkspaceMode;
}

/** Launches a real thread for a task: created, given its prompt and started in one command. */
export function useStartTaskThread() {
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const readStatus = useAtomCommand(vcsEnvironment.refreshLocalStatusForPicker, {
    reportFailure: false,
  });

  return async (input: StartTaskThreadInput): Promise<ScopedThreadRef> => {
    const { project } = input;
    let baseBranch: string | null = null;
    if (input.workspaceMode === "worktree") {
      const status = await readStatus({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot },
      });
      baseBranch =
        status._tag === "Success" && status.value.isRepo ? (status.value.refName ?? null) : null;
      if (baseBranch === null) {
        throw new Error(m(msg("A worktree needs a Git project with a checked-out branch.")));
      }
    }
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const result = await startThreadTurn({
      environmentId: project.environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        modelSelection: input.modelSelection,
        titleSeed: input.title,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        bootstrap: {
          createThread: {
            projectId: project.id,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: baseBranch,
            worktreePath: null,
            createdAt,
          },
          ...(baseBranch === null
            ? {}
            : {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch,
                  requireWorktree: true,
                },
                runSetupScript: true,
              }),
        },
        createdAt,
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return scopeThreadRef(project.environmentId, threadId);
  };
}
