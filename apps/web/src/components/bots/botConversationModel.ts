import type {
  BotEvent,
  BotIdentity,
  BotMessage,
  BotPendingRequest,
  BotProviderDescriptor,
} from "@t3tools/contracts";

import { botNeedsAttention } from "../sidebar/mattr/mattrBots.logic";

/** Orders by provider sequence when both have one, otherwise by time. */
function compareMessages(left: BotMessage, right: BotMessage) {
  if (left.seq !== null && right.seq !== null) return left.seq - right.seq;
  return left.createdAt.localeCompare(right.createdAt);
}

/**
 * Inserts or replaces a message. A confirmed message replaces the optimistic copy that carries
 * the same client nonce, so a send never shows twice.
 */
export function upsertBotMessage(
  messages: ReadonlyArray<BotMessage>,
  message: BotMessage,
): ReadonlyArray<BotMessage> {
  const rest = messages.filter(
    (existing) =>
      existing.remoteId !== message.remoteId &&
      !(message.clientNonce !== null && existing.clientNonce === message.clientNonce),
  );
  return [...rest, message].toSorted(compareMessages);
}

/**
 * Applies the copy the send request returned. The provider's own transcript copy can arrive over
 * the event stream before the request settles; it is the truth, so the echo never replaces it.
 */
export function confirmBotSend(
  messages: ReadonlyArray<BotMessage>,
  echo: BotMessage,
): ReadonlyArray<BotMessage> {
  const current = messages.find(
    (message) => echo.clientNonce !== null && message.clientNonce === echo.clientNonce,
  );
  if (current && current.deliveryState === "sent") return messages;
  return upsertBotMessage(messages, echo);
}

/** Older messages from a page load, merged without duplicating any already shown. */
export function prependBotMessages(
  messages: ReadonlyArray<BotMessage>,
  older: ReadonlyArray<BotMessage>,
): ReadonlyArray<BotMessage> {
  const known = new Set(messages.map((message) => message.remoteId));
  return [...older.filter((message) => !known.has(message.remoteId)), ...messages].toSorted(
    compareMessages,
  );
}

export function applyBotConversationEvent(
  messages: ReadonlyArray<BotMessage>,
  conversation: { readonly providerId: string; readonly conversationId: string },
  event: BotEvent,
): ReadonlyArray<BotMessage> {
  if (event.type === "message-upserted") {
    const { message } = event;
    if (
      message.providerId !== conversation.providerId ||
      message.conversationId !== conversation.conversationId
    ) {
      return messages;
    }
    return upsertBotMessage(messages, message);
  }
  if (event.type === "message-delta") {
    if (
      event.providerId !== conversation.providerId ||
      event.conversationId !== conversation.conversationId
    ) {
      return messages;
    }
    return messages.map((message) =>
      message.remoteId === event.remoteId
        ? { ...message, markdown: message.markdown + event.delta }
        : message,
    );
  }
  return messages;
}

/**
 * Automated prompts (a scheduled trigger or a promise check) arrive as user messages. Returns the
 * detail to show beside "Scheduled check" so the transcript can fold them into a quiet event row,
 * or null for an ordinary message.
 */
export function scheduledTriggerDetail(markdown: string): { readonly detail: string } | null {
  const text = markdown.trim();
  const promiseCheck = /^Promise check:\s*([^\s—–]+)/i.exec(text);
  if (promiseCheck?.[1]) return { detail: promiseCheck[1] };
  if (!/Triggering Event/i.test(text) || !/Source\W*schedule\b/i.test(text)) return null;
  const firstLine = (text.split("\n").find((line) => line.trim().length > 0) ?? "")
    .replace(/[#*_`>]/g, "")
    .trim();
  return { detail: firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine };
}

/**
 * Grok Bot's live status line ("is searching X for composers") as a sentence fragment
 * ("Searching X for composers"). Only meaningful while the Bot is working.
 */
export function botActivityDetail(bot: BotIdentity): string | null {
  if (bot.status !== "working") return null;
  const raw = bot.metadata["activityDetail"];
  if (typeof raw !== "string") return null;
  const text = raw
    .trim()
    .replace(/^is\s+/i, "")
    .trim();
  if (text.length === 0) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type BotPresence =
  | { readonly kind: "disconnected" }
  | { readonly kind: "offline" }
  | { readonly kind: "connecting" }
  | { readonly kind: "needs-you" }
  | { readonly kind: "working"; readonly detail: string | null }
  | { readonly kind: "error" }
  | { readonly kind: "ready" };

/** The one status a Bot's header shows: the connection first, then what the Bot is doing. */
export function botPresence(
  provider: BotProviderDescriptor,
  bot: BotIdentity,
  pending: ReadonlyArray<BotPendingRequest>,
): BotPresence {
  if (provider.status.kind === "connecting") return { kind: "connecting" };
  if (provider.status.kind !== "connected") return { kind: "disconnected" };
  if (bot.status === "offline") return { kind: "offline" };
  if (botNeedsAttention(bot, pending)) return { kind: "needs-you" };
  if (bot.status === "working") return { kind: "working", detail: botActivityDetail(bot) };
  if (bot.status === "error") return { kind: "error" };
  return { kind: "ready" };
}

/**
 * A message another Bot wrote into this conversation. Providers prefix its text with the sender
 * (`**Trading:** …`); the prefix becomes the row's author and leaves the body.
 */
export function otherBotAuthor(
  message: BotMessage,
): { readonly name: string | null; readonly markdown: string } | null {
  if (message.attribution !== "other-agent") return null;
  const match = /^\*\*([^*\n]{1,80}):\*\*\s*/.exec(message.markdown);
  return match?.[1]
    ? { name: match[1].trim(), markdown: message.markdown.slice(match[0].length) }
    : { name: null, markdown: message.markdown };
}

function senderKey(message: BotMessage): string {
  if (message.role !== "agent" && scheduledTriggerDetail(message.markdown)) {
    return `trigger:${message.remoteId}`;
  }
  const other = otherBotAuthor(message);
  if (other) return `other:${message.authorBotId ?? other.name ?? ""}`;
  return message.role;
}

/** Consecutive messages from one sender, shown as one block like a native chat turn. */
export function botMessageRuns(
  messages: ReadonlyArray<BotMessage>,
): ReadonlyArray<ReadonlyArray<BotMessage>> {
  const runs: Array<Array<BotMessage>> = [];
  let lastKey: string | null = null;
  for (const message of messages) {
    const key = senderKey(message);
    const current = runs.at(-1);
    if (current && key === lastKey) current.push(message);
    else runs.push([message]);
    lastKey = key;
  }
  return runs;
}
