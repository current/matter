/** Matter: whether the empty composer may show the predicted next message instead of its placeholder. */
export function canOfferMatterComposerPrediction(input: {
  readonly isDraft: boolean;
  readonly hidden: boolean;
  readonly canOperateThread: boolean;
  readonly busy: boolean;
  readonly locked: boolean;
  readonly sendBlocked: boolean;
  readonly redirectsApproval: boolean;
  readonly editingQueuedMessage: boolean;
  readonly pendingUserInput: boolean;
  readonly freshSessionArmed: boolean;
  readonly voiceInputActive: boolean;
  readonly draftText: string;
  readonly attachmentCount: number;
}): boolean {
  return (
    !input.isDraft &&
    !input.hidden &&
    input.canOperateThread &&
    !input.busy &&
    !input.locked &&
    !input.sendBlocked &&
    !input.redirectsApproval &&
    !input.editingQueuedMessage &&
    !input.pendingUserInput &&
    // The next message starts a fresh session that cannot see what the prediction refers to.
    !input.freshSessionArmed &&
    !input.voiceInputActive &&
    input.draftText.length === 0 &&
    input.attachmentCount === 0
  );
}
