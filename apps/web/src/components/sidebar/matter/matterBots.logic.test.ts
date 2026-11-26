import type { BotIdentity, BotPendingRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botNeedsAttention, hostDotTone, rankCrew, shortHostLabel } from "./matterBots.logic";

const bot = (overrides: Partial<BotIdentity> & Pick<BotIdentity, "remoteBotId">): BotIdentity => ({
  providerId: "grok-bot",
  accountScopeId: "acct",
  name: overrides.remoteBotId,
  avatar: null,
  status: "idle",
  unreadCount: 0,
  defaultConversationId: null,
  officialAppUrl: null,
  metadata: {},
  ...overrides,
});

const request = (botId: string): BotPendingRequest => ({
  requestId: `r-${botId}`,
  providerId: "grok-bot",
  accountScopeId: "acct",
  botId,
  conversationId: null,
  kind: "question",
  title: "Which branch?",
  detail: null,
  options: [],
  allowFreeText: true,
  createdAt: "2026-11-25T12:00:00.000Z",
  expiresAt: null,
});

describe("botNeedsAttention", () => {
  it("ignores unread alone", () => {
    expect(botNeedsAttention(bot({ remoteBotId: "a", unreadCount: 4 }), [])).toBe(false);
  });

  it("counts waiting states, pending requests and provider asks", () => {
    expect(botNeedsAttention(bot({ remoteBotId: "a", status: "waiting_for_user" }), [])).toBe(true);
    expect(botNeedsAttention(bot({ remoteBotId: "a" }), [request("a")])).toBe(true);
    expect(botNeedsAttention(bot({ remoteBotId: "a" }), [request("b")])).toBe(false);
    expect(botNeedsAttention(bot({ remoteBotId: "a", metadata: { pendingAsks: 2 } }), [])).toBe(
      true,
    );
  });
});

describe("rankCrew", () => {
  it("lifts working and unread Bots and keeps the rest in order", () => {
    const ranked = rankCrew([
      bot({ remoteBotId: "idle-1" }),
      bot({ remoteBotId: "unread", unreadCount: 1 }),
      bot({ remoteBotId: "idle-2" }),
      bot({ remoteBotId: "working", status: "working" }),
    ]);
    expect(ranked.map((entry) => entry.remoteBotId)).toEqual([
      "working",
      "unread",
      "idle-1",
      "idle-2",
    ]);
  });
});

describe("hostDotTone", () => {
  it("shows no dot while connected and up to date", () => {
    expect(hostDotTone("connected", "up-to-date")).toBeNull();
    expect(hostDotTone(undefined, undefined)).toBeNull();
  });

  it("is blue for an update and red only when the connection is lost", () => {
    expect(hostDotTone("connected", "available")).toBe("update");
    expect(hostDotTone("connected", "downloaded")).toBe("update");
    expect(hostDotTone("connecting", undefined)).toBe("connecting");
    expect(hostDotTone("offline", "available")).toBe("error");
    expect(hostDotTone("backoff", undefined)).toBe("error");
  });
});

describe("shortHostLabel", () => {
  it("drops a possessive owner prefix", () => {
    expect(shortHostLabel("Christopher’s MacBook Pro")).toBe("MacBook Pro");
    expect(shortHostLabel("Chris's Mac mini")).toBe("Mac mini");
    expect(shortHostLabel("build-server")).toBe("build-server");
  });
});
