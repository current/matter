import {
  NO_BOT_PROVIDER_CAPABILITIES,
  type BotIdentity,
  type BotMessage,
  type BotProviderDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyBotConversationEvent,
  botActivityDetail,
  botMessageRuns,
  botPresence,
  confirmBotSend,
  otherBotAuthor,
  prependBotMessages,
  scheduledTriggerDetail,
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

  it("reconciles a send by nonce whichever copy arrives first, never duplicating it", () => {
    const optimistic = message({
      remoteId: "pending:n1",
      role: "user",
      clientNonce: "n1",
      deliveryState: "pending",
    });
    const echo = { ...optimistic, remoteId: "sent:n1", deliveryState: "sent" as const };
    const transcript = {
      ...optimistic,
      remoteId: "grok-42",
      seq: 7,
      deliveryState: "sent" as const,
    };
    const target = { providerId: "grok-bot", conversationId: "c1" };
    const upserted = { type: "message-upserted" as const, message: transcript };

    const echoFirst = applyBotConversationEvent(
      confirmBotSend([optimistic], echo),
      target,
      upserted,
    );
    expect(echoFirst).toEqual([transcript]);

    const transcriptFirst = applyBotConversationEvent([optimistic], target, upserted);
    expect(confirmBotSend(transcriptFirst, echo)).toEqual([transcript]);
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

const bot: BotIdentity = {
  providerId: "grok-bot",
  remoteBotId: "bot-1",
  accountScopeId: "local",
  name: "Scout",
  avatar: null,
  status: "working",
  unreadCount: 0,
  defaultConversationId: "c1",
  officialAppUrl: null,
  metadata: { activityDetail: "is searching X for composers" },
};

const provider: BotProviderDescriptor = {
  providerId: "grok-bot",
  addonId: "grok-bot",
  displayName: "Grok Bot",
  transport: "local-app-bridge",
  experimental: true,
  status: { kind: "connected" },
  capabilities: NO_BOT_PROVIDER_CAPABILITIES,
  officialAppUrl: null,
};

describe("botPresence", () => {
  it("turns Grok's live status line into a sentence only while working", () => {
    expect(botActivityDetail(bot)).toBe("Searching X for composers");
    expect(botActivityDetail({ ...bot, metadata: { activityDetail: "  " } })).toBeNull();
    expect(botActivityDetail({ ...bot, status: "idle" })).toBeNull();
    expect(botPresence(provider, bot, [])).toEqual({
      kind: "working",
      detail: "Searching X for composers",
    });
  });

  it("puts a lost connection before what the Bot is doing", () => {
    const disconnected = { ...provider, status: { kind: "disconnected" as const } };
    expect(botPresence(disconnected, bot, []).kind).toBe("disconnected");
    expect(botPresence(provider, { ...bot, status: "waiting_for_user" }, []).kind).toBe(
      "needs-you",
    );
    expect(botPresence(provider, { ...bot, status: "idle" }, []).kind).toBe("ready");
  });
});

describe("scheduledTriggerDetail", () => {
  it("folds a promise check into its ticket id", () => {
    expect(
      scheduledTriggerDetail("Promise check: TASK-1 — promise promise-7930 is past its deadline."),
    ).toEqual({ detail: "TASK-1" });
  });

  it("folds a scheduled triggering event into its first line", () => {
    const text = "Run the nightly digest.\n\n---\n\n## Triggering Event\n**Source:** schedule";
    expect(scheduledTriggerDetail(text)).toEqual({ detail: "Run the nightly digest." });
  });

  it("leaves ordinary messages alone", () => {
    expect(scheduledTriggerDetail("Can you check the schedule for tomorrow?")).toBeNull();
    expect(scheduledTriggerDetail("## Triggering Event\n**Source:** webhook")).toBeNull();
  });

  it("groups consecutive messages by sender, keeping other Bots and scheduled checks apart", () => {
    const user = (remoteId: string, markdown = "hi") =>
      message({
        remoteId,
        role: "user",
        attribution: "user-via-mattr",
        authorBotId: null,
        markdown,
      });
    const runs = botMessageRuns([
      user("u1"),
      user("u2"),
      message({ remoteId: "a1", markdown: "one" }),
      message({ remoteId: "a2", markdown: "two" }),
      message({
        remoteId: "o1",
        role: "user",
        attribution: "other-agent",
        authorBotId: "bot-2",
        markdown: "**Trading:** hello",
      }),
      user("p1", "Promise check: TASK-1 — overdue"),
      user("u3"),
    ]);
    expect(runs.map((run) => run.map((entry) => entry.remoteId))).toEqual([
      ["u1", "u2"],
      ["a1", "a2"],
      ["o1"],
      ["p1"],
      ["u3"],
    ]);
  });

  it("reads another Bot's name from its message prefix", () => {
    const other = message({
      remoteId: "o1",
      role: "user",
      attribution: "other-agent",
      markdown: "**Trading:** Welcome.",
    });
    expect(otherBotAuthor(other)).toEqual({ name: "Trading", markdown: "Welcome." });
    expect(otherBotAuthor(message({ remoteId: "a1", markdown: "**Bold:** text" }))).toBeNull();
  });
});
