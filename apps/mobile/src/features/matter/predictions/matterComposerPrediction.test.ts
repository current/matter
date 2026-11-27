import { describe, expect, it } from "vite-plus/test";

import { canOfferMatterComposerPrediction } from "./matterComposerPrediction";

const OPEN = {
  isDraft: false,
  hidden: false,
  canOperateThread: true,
  busy: false,
  locked: false,
  sendBlocked: false,
  redirectsApproval: false,
  editingQueuedMessage: false,
  pendingUserInput: false,
  freshSessionArmed: false,
  voiceInputActive: false,
  draftText: "",
  attachmentCount: 0,
};

describe("canOfferMatterComposerPrediction", () => {
  it("offers it in an idle, empty composer", () => {
    expect(canOfferMatterComposerPrediction(OPEN)).toBe(true);
  });

  it("hides it as soon as the draft has text or an attachment", () => {
    expect(canOfferMatterComposerPrediction({ ...OPEN, draftText: "h" })).toBe(false);
    expect(canOfferMatterComposerPrediction({ ...OPEN, draftText: " " })).toBe(false);
    expect(canOfferMatterComposerPrediction({ ...OPEN, attachmentCount: 1 })).toBe(false);
  });

  it.each([
    ["isDraft", true],
    ["hidden", true],
    ["canOperateThread", false],
    ["busy", true],
    ["locked", true],
    ["sendBlocked", true],
    ["redirectsApproval", true],
    ["editingQueuedMessage", true],
    ["pendingUserInput", true],
    ["freshSessionArmed", true],
    ["voiceInputActive", true],
  ] as const)("hides it when %s is %s", (key, value) => {
    expect(canOfferMatterComposerPrediction({ ...OPEN, [key]: value })).toBe(false);
  });
});
