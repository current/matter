import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  matterPromptPredictionToAccept,
  offeredMatterPromptPrediction,
} from "@t3tools/client-runtime/matter/prompt-prediction";
import type { RefObject } from "react";

import type { ComposerEditorHandle } from "../../../components/ComposerEditor";
import { orchestrationEnvironment } from "../../../state/orchestration";
import { useEnvironmentQuery } from "../../../state/query";
import { useComposerDraft } from "../../../state/use-composer-drafts";
import { useQuietThreadStructure } from "../../../state/use-thread-detail";
import type { ThreadComposerProps } from "../../threads/ThreadComposer";
import { canOfferMatterComposerPrediction } from "./matterComposerPrediction";

const NO_RUNS: never[] = [];

/**
 * Matter: the server's predicted next message for this thread while the composer is empty and idle,
 * and the accept action that fills it in. Touch has no Tab key, so a chip accepts it.
 */
export function useMatterComposerPrediction(input: {
  readonly props: Pick<
    ThreadComposerProps,
    | "isDraft"
    | "hidden"
    | "canOperateThread"
    | "activeThreadBusy"
    | "redirectsApproval"
    | "queuedEdit"
    | "sendBlockedReason"
    | "environmentId"
    | "selectedThread"
    | "serverConfig"
    | "onChangeDraftMessage"
  >;
  readonly draftKey: string;
  readonly locked: boolean;
  readonly voiceInputActive: boolean;
  readonly editorRef: RefObject<ComposerEditorHandle | null>;
  readonly onSelectionChange: (selection: { start: number; end: number }) => void;
}): { readonly text: string | null; readonly accept: () => void } {
  const { props } = input;
  const thread = props.selectedThread;
  const draft = useComposerDraft(input.draftKey);
  // Older servers decode the missing setting as false, so true also proves the method exists.
  const enabled = props.serverConfig?.settings.promptSuggestionsEnabled === true;
  const { data } = useEnvironmentQuery(
    enabled && !props.isDraft && thread.latestRun !== null
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId: props.environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const runs =
    useQuietThreadStructure(scopeThreadRef(props.environmentId, thread.id))?.projection.runs ??
    NO_RUNS;
  const offered = offeredMatterPromptPrediction(data, thread.latestRun, runs);
  const text =
    offered !== null &&
    canOfferMatterComposerPrediction({
      isDraft: props.isDraft === true,
      hidden: props.hidden,
      canOperateThread: props.canOperateThread,
      busy: props.activeThreadBusy,
      locked: input.locked,
      sendBlocked: props.sendBlockedReason != null,
      redirectsApproval: props.redirectsApproval,
      editingQueuedMessage: props.queuedEdit != null,
      pendingUserInput: thread.hasPendingUserInput,
      freshSessionArmed: draft.freshContext === true,
      voiceInputActive: input.voiceInputActive,
      draftText: draft.text,
      attachmentCount: draft.attachments.length,
    })
      ? offered.text
      : null;

  return {
    text,
    accept: () => {
      const accepted = matterPromptPredictionToAccept(text, draft.text);
      if (accepted === null) return;
      props.onChangeDraftMessage(accepted);
      input.onSelectionChange({ start: accepted.length, end: accepted.length });
      input.editorRef.current?.focus();
    },
  };
}
