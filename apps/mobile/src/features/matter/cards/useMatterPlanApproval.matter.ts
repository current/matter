import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  type EnvironmentId,
  type PlanId,
} from "@t3tools/contracts";

import { scopedThreadKey } from "../../../lib/scopedEntities";
import { uuidv4 } from "../../../lib/uuid";
import { useEnvironmentScope } from "../../../state/session";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { updateComposerDraftSettings } from "../../../state/use-composer-drafts";
import {
  useSelectedThreadPendingRequests,
  useSelectedThreadProjection,
} from "../../../state/use-thread-detail";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { approveMatterPlanMobile, resolveMobileProposedPlanArtifact } from "./matterPlanApproval";

export type MatterPlanApproveResult = AtomCommandResult<unknown, unknown>;

export function useMatterProposedPlanApprove(input: {
  readonly environmentId: EnvironmentId;
  readonly planId?: PlanId | undefined;
  readonly markdown: string;
}): ((planMarkdown: string) => Promise<MatterPlanApproveResult>) | null {
  const { selectedThread } = useThreadSelection();
  const threadProjection = useSelectedThreadProjection();
  const pendingRequests = useSelectedThreadPendingRequests();
  const canOperateThread = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

  if (!selectedThread || selectedThread.environmentId !== input.environmentId) {
    return null;
  }

  const artifact = resolveMobileProposedPlanArtifact({
    plans: threadProjection?.projection.plans,
    turnItems: threadProjection?.projection.visibleTurnItems,
    planId: input.planId,
    markdown: input.markdown,
  });
  const isWorking =
    (selectedThread.runtime?.activeRunId ?? null) !== null ||
    threadRuntimeIsActive(selectedThread.runtime);
  const awaitingUser =
    selectedThread.hasPendingApprovals ||
    selectedThread.hasPendingUserInput ||
    (pendingRequests?.approvals.length ?? 0) > 0 ||
    (pendingRequests?.userInputs.length ?? 0) > 0;

  if (!artifact || artifact.status !== "active" || !canOperateThread || isWorking || awaitingUser) {
    return null;
  }

  const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  return (planMarkdown: string) =>
    approveMatterPlanMobile({
      environmentId: selectedThread.environmentId,
      threadId: selectedThread.id,
      planId: artifact.id,
      planMarkdown,
      thread: selectedThread,
      messageId: MessageId.make(uuidv4()),
      createdAt: new Date().toISOString(),
      clearDraftInteractionMode: () =>
        updateComposerDraftSettings(threadKey, { interactionMode: undefined }),
      setInteractionMode,
      startTurn,
    });
}
