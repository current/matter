import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NO_BOT_PROVIDER_CAPABILITIES,
  type BotIdentity,
  type BotPendingRequest,
  type BotProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as AddonConfigService from "./AddonConfigService.ts";
import { BotProviderError, type BotProviderAdapter } from "./BotProviderAdapter.ts";
import * as BotsPlatformService from "./BotsPlatformService.ts";

const layer = BotsPlatformService.layer.pipe(
  Layer.provideMerge(AddonConfigService.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-platform-" })),
  Layer.provideMerge(NodeServices.layer),
);

const BOT: BotIdentity = {
  providerId: "fake-bot",
  remoteBotId: "bot-1",
  accountScopeId: "acct-1",
  name: "Research Bot",
  avatar: { kind: "parametric", shape: "blob", color: "teal" },
  status: "idle",
  unreadCount: 0,
  defaultConversationId: "conv-1",
  officialAppUrl: null,
  metadata: {},
};

const PENDING: BotPendingRequest = {
  requestId: "req-1",
  providerId: "fake-bot",
  accountScopeId: "acct-1",
  botId: "bot-1",
  conversationId: "conv-1",
  kind: "approval",
  title: "Open a pull request?",
  detail: null,
  options: [],
  allowFreeText: false,
  createdAt: "2026-11-25T00:00:00.000Z",
  expiresAt: null,
};

interface FakeCounters {
  starts: number;
  stops: number;
  polls: number;
  sends: number;
  cancels: number;
  responses: number;
}

function makeFakeAdapter(
  options: {
    readonly capabilities?: Partial<BotProviderCapabilities>;
    readonly failStart?: BotProviderError["reason"];
  } = {},
) {
  const counters: FakeCounters = {
    starts: 0,
    stops: 0,
    polls: 0,
    sends: 0,
    cancels: 0,
    responses: 0,
  };
  const capabilities: BotProviderCapabilities = {
    ...NO_BOT_PROVIDER_CAPABILITIES,
    agentDiscovery: true,
    history: "paged",
    sendMessage: true,
    sync: "poll",
    approvals: true,
    ...options.capabilities,
  };
  const adapter: BotProviderAdapter = {
    providerId: "fake-bot",
    addonId: "grok-bot",
    displayName: "Fake Bot",
    transport: "direct-api",
    experimental: false,
    officialAppUrl: "fakebot://open",
    pollIntervals: { idleMs: 10_000, activeMs: 3_000 },
    start: () =>
      Effect.gen(function* () {
        counters.starts += 1;
        if (options.failStart) {
          return yield* new BotProviderError({
            providerId: "fake-bot",
            reason: options.failStart,
            detail: "Fake Bot is not running.",
          });
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            counters.stops += 1;
          }),
        );
        return {
          capabilities,
          status: Effect.succeed({ kind: "connected" as const }),
          listBots: Effect.succeed([BOT]),
          listConversations: () => Effect.succeed([]),
          getMessages: (input) =>
            Effect.succeed({ messages: [], olderCursor: input.olderCursor ?? "older" }),
          sendMessage: (input) =>
            Effect.sync(() => {
              counters.sends += 1;
              return {
                remoteId: "msg-1",
                conversationId: input.conversationId,
                providerId: "fake-bot",
                role: "user" as const,
                attribution: "user-via-matter" as const,
                authorBotId: null,
                markdown: input.text,
                parts: [{ type: "markdown" as const, text: input.text }],
                replyToId: input.replyToId,
                attachments: [],
                artifacts: [],
                createdAt: "2026-11-25T00:00:00.000Z",
                seq: null,
                clientNonce: input.clientNonce,
                deliveryState: "sent" as const,
              };
            }),
          cancel: () =>
            Effect.sync(() => {
              counters.cancels += 1;
            }),
          respondToRequest: () =>
            Effect.sync(() => {
              counters.responses += 1;
            }),
          listPendingRequests: Effect.succeed([PENDING]),
          poll: Effect.sync(() => {
            counters.polls += 1;
            return { active: false };
          }),
        };
      }),
  };
  return { adapter, counters };
}

/** Lets forked provider fibers run to their next suspension point. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
});

const enable = (id: string, enabled: boolean) =>
  Effect.gen(function* () {
    const config = yield* AddonConfigService.AddonConfigService;
    const platform = yield* BotsPlatformService.BotsPlatformService;
    yield* config.setEnabled({ id, enabled });
    yield* platform.reconcile;
    yield* settle;
  });

const subscribe = Effect.gen(function* () {
  const platform = yield* BotsPlatformService.BotsPlatformService;
  yield* platform.events.pipe(Stream.runDrain, Effect.forkScoped);
  yield* settle;
});

describe("BotsPlatformService", () => {
  it.effect("does no work at all for a provider whose add-on is disabled", () =>
    Effect.gen(function* () {
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const { adapter, counters } = makeFakeAdapter();
      yield* platform.register(adapter);
      yield* subscribe;
      yield* TestClock.adjust("10 minutes");
      yield* settle;
      assert.deepStrictEqual(counters, {
        starts: 0,
        stops: 0,
        polls: 0,
        sends: 0,
        cancels: 0,
        responses: 0,
      });
      assert.deepStrictEqual(yield* platform.runningProviderIds, []);
      assert.deepStrictEqual(yield* platform.listProviders, []);
      assert.deepStrictEqual(yield* platform.addonStatus("grok-bot"), { kind: "disabled" });
      const error = yield* Effect.flip(platform.listBots("fake-bot"));
      assert.strictEqual(error.code, "provider_disabled");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("starts on enable, polls only while a client listens, and stops on disable", () =>
    Effect.gen(function* () {
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const config = yield* AddonConfigService.AddonConfigService;
      const { adapter, counters } = makeFakeAdapter();
      yield* platform.register(adapter);
      yield* config.updateConfig("grok-bot", { transport: "local-app" });
      yield* enable("grok-bot", true);

      assert.strictEqual(counters.starts, 1);
      assert.deepStrictEqual(yield* platform.listBots("fake-bot"), [BOT]);
      assert.deepStrictEqual(yield* platform.addonStatus("grok-bot"), { kind: "connected" });
      const [descriptor] = yield* platform.listProviders;
      assert.strictEqual(descriptor?.capabilities.sendMessage, true);
      assert.deepStrictEqual(yield* platform.listPendingRequests, [PENDING]);

      // Nobody listening: no polls, however long we wait.
      yield* TestClock.adjust("1 minute");
      yield* settle;
      assert.strictEqual(counters.polls, 0);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* subscribe;
          assert.strictEqual(counters.polls, 1);
          yield* TestClock.adjust("10 seconds");
          yield* settle;
          assert.strictEqual(counters.polls, 2);
        }),
      );
      // The listener left: the loop parks before its next tick.
      yield* TestClock.adjust("10 minutes");
      yield* settle;
      assert.strictEqual(counters.polls, 2);

      yield* enable("grok-bot", false);
      assert.strictEqual(counters.stops, 1);
      assert.strictEqual(counters.cancels, 0, "disabling never cancels remote work");
      assert.deepStrictEqual(yield* platform.runningProviderIds, []);
      assert.deepStrictEqual(yield* platform.listPendingRequests, []);
      assert.deepStrictEqual(yield* config.getConfig("grok-bot"), { transport: "local-app" });

      yield* subscribe;
      yield* TestClock.adjust("10 minutes");
      yield* settle;
      assert.strictEqual(counters.polls, 2);
      assert.strictEqual(counters.starts, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("enforces declared capabilities and usage confirmation", () =>
    Effect.gen(function* () {
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const { adapter, counters } = makeFakeAdapter({
        capabilities: { creditSpendWarning: true, cancel: false, history: "recent" },
      });
      yield* platform.register(adapter);
      yield* enable("grok-bot", true);

      const send = {
        providerId: "fake-bot",
        conversationId: "conv-1",
        text: "Investigate the flaky test",
        clientNonce: "nonce-1",
      };
      const unconfirmed = yield* Effect.flip(platform.sendMessage(send));
      assert.strictEqual(unconfirmed.code, "usage_confirmation_required");
      assert.strictEqual(counters.sends, 0);
      const message = yield* platform.sendMessage({ ...send, confirmUsage: true });
      assert.strictEqual(message.clientNonce, "nonce-1");

      const cancelled = yield* Effect.flip(
        platform.cancel({ providerId: "fake-bot", conversationId: "conv-1" }),
      );
      assert.strictEqual(cancelled.code, "unsupported");

      // "recent" history ignores cursors instead of pretending to page.
      const page = yield* platform.getMessages({
        providerId: "fake-bot",
        conversationId: "conv-1",
        olderCursor: "cursor-x",
        limit: 5_000,
      });
      assert.strictEqual(page.olderCursor, "older");

      yield* platform.respondToRequest({
        providerId: "fake-bot",
        requestId: "req-1",
        response: { kind: "decision", decision: "approve" },
      });
      assert.strictEqual(counters.responses, 1);
      assert.deepStrictEqual(yield* platform.listPendingRequests, []);
      const missing = yield* Effect.flip(
        platform.respondToRequest({
          providerId: "fake-bot",
          requestId: "req-1",
          response: { kind: "decision", decision: "approve" },
        }),
      );
      assert.strictEqual(missing.code, "not_found");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports an unreachable provider and retries with bounded backoff", () =>
    Effect.gen(function* () {
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const { adapter, counters } = makeFakeAdapter({ failStart: "unavailable" });
      yield* platform.register(adapter);
      yield* enable("grok-bot", true);
      assert.strictEqual(counters.starts, 1);
      const status = yield* platform.addonStatus("grok-bot");
      assert.strictEqual(status?.kind, "app_unavailable");
      assert.strictEqual(status?.detail, "Fake Bot is not running.");
      const error = yield* Effect.flip(platform.listBots("fake-bot"));
      assert.strictEqual(error.code, "provider_unavailable");

      yield* TestClock.adjust("30 seconds");
      yield* settle;
      assert.strictEqual(counters.starts, 2);
      yield* TestClock.adjust("59 seconds");
      yield* settle;
      assert.strictEqual(counters.starts, 2);
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.strictEqual(counters.starts, 3);

      yield* enable("grok-bot", false);
      yield* TestClock.adjust("1 hour");
      yield* settle;
      assert.strictEqual(counters.starts, 3);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it("caps backoff at five minutes", () => {
    assert.strictEqual(BotsPlatformService.backoffMs(30_000, 0), 30_000);
    assert.strictEqual(BotsPlatformService.backoffMs(30_000, 1), 60_000);
    assert.strictEqual(BotsPlatformService.backoffMs(30_000, 20), 300_000);
    assert.strictEqual(BotsPlatformService.backoffMs(10, 0), 2_000);
  });
});
