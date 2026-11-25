import type { BotEvent, BotMessage } from "@t3tools/contracts";

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
