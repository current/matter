import type { BotMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyBotConversationEvent,
  prependBotMessages,
  upsertBotMessage,
} from "./botConversationModel";

const message = (overrides: Partial<BotMessage> & Pick<BotMessage, "remoteId">): BotMessage => ({
  conversationId: "c1",
  providerId: "grok-bot",
  role: "agent",
  attribution: "agent",
  authorBotId: "bot-1",
  markdown: "",
  parts: [],
  replyToId: null,
  attachments: [],
  artifacts: [],
  createdAt: "2026-11-25T10:00:00.000Z",
  seq: null,
  clientNonce: null,
  deliveryState: "sent",
  ...overrides,
});

const conversation = { providerId: "grok-bot", conversationId: "c1" };

describe("botConversationModel", () => {
  it("replaces an optimistic send with the confirmed message carrying its nonce", () => {
    const optimistic = message({
      remoteId: "local-1",
      role: "user",
      attribution: "user-via-mattr",
      clientNonce: "n1",
      deliveryState: "pending",
    });
    const confirmed = { ...optimistic, remoteId: "r1", deliveryState: "sent" as const };
    expect(upsertBotMessage([optimistic], confirmed)).toEqual([confirmed]);
  });

  it("orders by provider sequence, falling back to time", () => {
    const second = message({ remoteId: "b", seq: 2, createdAt: "2026-11-25T09:00:00.000Z" });
    const first = message({ remoteId: "a", seq: 1, createdAt: "2026-11-25T11:00:00.000Z" });
    expect(upsertBotMessage([second], first).map((m) => m.remoteId)).toEqual(["a", "b"]);
    const late = message({ remoteId: "x", createdAt: "2026-11-25T12:00:00.000Z" });
    const early = message({ remoteId: "y", createdAt: "2026-11-25T08:00:00.000Z" });
    expect(upsertBotMessage([late], early).map((m) => m.remoteId)).toEqual(["y", "x"]);
  });

  it("merges an older page without duplicates", () => {
    const shown = [message({ remoteId: "b", seq: 2 }), message({ remoteId: "c", seq: 3 })];
    const older = [message({ remoteId: "a", seq: 1 }), message({ remoteId: "b", seq: 2 })];
    expect(prependBotMessages(shown, older).map((m) => m.remoteId)).toEqual(["a", "b", "c"]);
  });

  it("streams deltas into this conversation and ignores other conversations", () => {
    const messages = [message({ remoteId: "r1", markdown: "Hel" })];
    const streamed = applyBotConversationEvent(messages, conversation, {
      type: "message-delta",
      providerId: "grok-bot",
      conversationId: "c1",
      remoteId: "r1",
      delta: "lo",
    });
    expect(streamed[0]?.markdown).toBe("Hello");
    const elsewhere = applyBotConversationEvent(messages, conversation, {
      type: "message-upserted",
      message: message({ remoteId: "r2", conversationId: "c2" }),
    });
    expect(elsewhere).toBe(messages);
  });
});
