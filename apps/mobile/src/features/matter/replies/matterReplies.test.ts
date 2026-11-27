import { EnvironmentId, MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { finishThreadMessageJump, pendingThreadMessageJump } from "../../threads/threadMessageJump";
import {
  clearMatterReply,
  jumpToMatterReplyTarget,
  matterLeadingReply,
  matterReplyBubbleText,
  matterReplyFor,
  replyToMatterMessage,
  resetMatterRepliesForTests,
  subscribeMatterReplyRequests,
  takeMatterReplyForSend,
} from "./matterReplies";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const threadKey = `${environmentId}:${threadId}`;

function startReply(role: "user" | "assistant", text: string, messageId = "msg-1") {
  return replyToMatterMessage({
    role,
    environmentId,
    threadId,
    messageId: MessageId.make(messageId),
    itemId: TurnItemId.make(`item-${messageId}`),
    text,
  });
}

afterEach(() => {
  resetMatterRepliesForTests();
  finishThreadMessageJump(threadKey);
  vi.useRealTimers();
});

describe("matter replies", () => {
  it("keeps one pending reply per thread composer and asks it to take focus", () => {
    const focused = vi.fn();
    const unsubscribe = subscribeMatterReplyRequests(threadKey, focused);
    expect(startReply("assistant", "First answer", "msg-a")).toBe(true);
    expect(startReply("user", "My question", "msg-u")).toBe(true);
    expect(focused).toHaveBeenCalledTimes(2);
    expect(matterReplyFor(threadKey)).toMatchObject({
      role: "user",
      itemId: "item-msg-u",
      citation: { messageId: "msg-u", text: "My question" },
    });
    unsubscribe();
    clearMatterReply(threadKey);
    expect(matterReplyFor(threadKey)).toBeNull();
  });

  it("does not start a reply to a message with no text", () => {
    expect(startReply("assistant", "  ")).toBe(false);
    expect(matterReplyFor(threadKey)).toBeNull();
  });

  it("folds the reply into the send once, as web sends it", () => {
    startReply("assistant", "Here is the plan.", "msg-a");
    const record = matterReplyFor(threadKey)!;
    const sent = takeMatterReplyForSend(threadKey, { text: "Go ahead", context: undefined });
    const token = formatComposerContextReference({
      kind: "response",
      contextId: record.contextId,
      label: record.label,
    });
    expect(sent).toEqual({ text: `${token} Go ahead`, context: { version: 1, records: [record] } });
    expect(matterReplyFor(threadKey)).toBeNull();
    expect(takeMatterReplyForSend(threadKey, { text: "Again", context: undefined })).toEqual({
      text: "Again",
      context: undefined,
    });
  });

  it("splits a sent reply card from the bubble text", () => {
    startReply("user", "Can we refactor the composer?", "msg-u");
    const sent = takeMatterReplyForSend(threadKey, { text: "Yes, next", context: undefined });
    expect(matterReplyBubbleText(sent.text, sent.context)).toBe("Yes, next");
    expect(matterLeadingReply(sent.text, sent.context)?.citation.messageId).toBe("msg-u");
    expect(matterReplyBubbleText("Plain text", undefined)).toBe("Plain text");
    expect(matterLeadingReply("Plain text", undefined)).toBeNull();
  });

  it("jumps to the replied message", () => {
    vi.useFakeTimers();
    startReply("assistant", "Answer", "msg-a");
    jumpToMatterReplyTarget(matterReplyFor(threadKey)!);
    expect(pendingThreadMessageJump(threadKey)).toBe("msg-a");
  });
});
