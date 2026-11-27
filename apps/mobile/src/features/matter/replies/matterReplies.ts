import { scopedThreadKey } from "../../../lib/scopedEntities";
import {
  buildMatterReplyRecord,
  extractLeadingReplyReference,
  withMatterReply,
  type MatterReplyRole,
} from "@t3tools/client-runtime/matter/message-reply";
import type {
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  ResponseContextRecord,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { requestThreadMessageJump } from "../../threads/threadMessageJump";

/*
 * Matter's in-chat replies on mobile. A pending reply lives per composer draft key (the thread's
 * scoped key) in memory, outside the persisted draft, and is folded into the outgoing message only
 * at enqueue time, so `/side`, `/plan` and `/goal` still parse from the typed text.
 */

const MATTER_REPLY_HIGHLIGHT_MS = 1_600;

let replies: Readonly<Record<string, ResponseContextRecord>> = {};
const replyListeners = new Set<() => void>();
const focusListeners = new Set<(draftKey: string) => void>();

function notifyReplies() {
  for (const listener of replyListeners) listener();
}

function subscribeReplies(listener: () => void) {
  replyListeners.add(listener);
  return () => {
    replyListeners.delete(listener);
  };
}

export function matterReplyFor(draftKey: string): ResponseContextRecord | null {
  return replies[draftKey] ?? null;
}

export function useMatterReply(draftKey: string | null): ResponseContextRecord | null {
  return useSyncExternalStore(subscribeReplies, () =>
    draftKey === null ? null : matterReplyFor(draftKey),
  );
}

export function setMatterReply(draftKey: string, record: ResponseContextRecord): void {
  replies = { ...replies, [draftKey]: record };
  notifyReplies();
  for (const listener of focusListeners) listener(draftKey);
}

export function clearMatterReply(draftKey: string): void {
  if (!(draftKey in replies)) return;
  const { [draftKey]: _removed, ...rest } = replies;
  replies = rest;
  notifyReplies();
}

/** Calls `listener` each time a Reply targets `draftKey`, so its composer can take focus. */
export function subscribeMatterReplyRequests(draftKey: string, listener: () => void): () => void {
  const onRequest = (key: string) => {
    if (key === draftKey) listener();
  };
  focusListeners.add(onRequest);
  return () => {
    focusListeners.delete(onRequest);
  };
}

/** Starts a reply to a feed message in the thread's composer; false when it has no text to cite. */
export function replyToMatterMessage(input: {
  readonly role: MatterReplyRole;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly itemId?: TurnItemId | undefined;
  readonly text: string;
}): boolean {
  const record = buildMatterReplyRecord(input);
  if (!record) return false;
  setMatterReply(scopedThreadKey(input.environmentId, input.threadId), record);
  return true;
}

/**
 * The outgoing message with this thread's pending reply folded in, as web sends it; the reply is
 * consumed, matching web clearing it on send.
 */
export function takeMatterReplyForSend(
  threadKey: string,
  message: { readonly text: string; readonly context: OrchestrationMessageContext | undefined },
): { text: string; context: OrchestrationMessageContext | undefined } {
  const replyTo = matterReplyFor(threadKey);
  if (replyTo) clearMatterReply(threadKey);
  return withMatterReply(message, replyTo);
}

/** A user message's bubble text without the reply card that leads it (shown above instead). */
export function matterReplyBubbleText(
  text: string,
  context: OrchestrationMessageContext | undefined,
): string {
  if (!context) return text;
  return extractLeadingReplyReference(text, context.records)?.bodyText ?? text;
}

export function matterLeadingReply(
  text: string,
  context: OrchestrationMessageContext | undefined,
): ResponseContextRecord | null {
  return context ? (extractLeadingReplyReference(text, context.records)?.record ?? null) : null;
}

let highlight: { readonly messageId: MessageId; readonly nonce: number } | null = null;
let highlightNonce = 0;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const highlightListeners = new Set<() => void>();

function notifyHighlight() {
  for (const listener of highlightListeners) listener();
}

function subscribeHighlight(listener: () => void) {
  highlightListeners.add(listener);
  return () => {
    highlightListeners.delete(listener);
  };
}

/** The nonce of a running highlight on `messageId`, or null. */
export function useMatterReplyHighlight(messageId: MessageId): number | null {
  return useSyncExternalStore(subscribeHighlight, () =>
    highlight?.messageId === messageId ? highlight.nonce : null,
  );
}

/** Scrolls the thread to the replied message, loading earlier history if needed, and flashes it. */
export function jumpToMatterReplyTarget(record: ResponseContextRecord): void {
  const { environmentId, threadId, messageId } = record.citation;
  requestThreadMessageJump(scopedThreadKey(environmentId, threadId), messageId);
  highlightNonce += 1;
  highlight = { messageId, nonce: highlightNonce };
  notifyHighlight();
  if (highlightTimer !== null) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    highlight = null;
    notifyHighlight();
  }, MATTER_REPLY_HIGHLIGHT_MS);
}

export function resetMatterRepliesForTests(): void {
  replies = {};
  highlight = null;
  if (highlightTimer !== null) clearTimeout(highlightTimer);
  highlightTimer = null;
  notifyReplies();
  notifyHighlight();
}
