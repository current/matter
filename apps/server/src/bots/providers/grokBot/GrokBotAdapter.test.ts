import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { BotEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as NetAddress from "effect/net/NetAddress";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import * as AddonConfigService from "../../AddonConfigService.ts";
import * as BotsPlatformService from "../../BotsPlatformService.ts";
import * as GrokBotAdapter from "./GrokBotAdapter.ts";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.anysphere.sand</string>
  <key>CFBundleShortVersionString</key><string>1.3.0</string>
</dict></plist>`;

const layer = BotsPlatformService.layer.pipe(
  Layer.provideMerge(AddonConfigService.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-adapter-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

interface MockGrokBot {
  jsonRequests: number;
  readonly sentNonces: Array<string>;
  readonly messages: Array<Record<string, unknown>>;
  readonly socketClosed: Deferred.Deferred<void>;
}

/** A loopback stand-in for Grok Bot's DevTools endpoint and renderer store bridge. */
const startMockGrokBot = Effect.gen(function* () {
  const state: MockGrokBot = {
    jsonRequests: 0,
    sentNonces: [],
    messages: [
      { id: "remote-1", seq: 1, role: "user", text: "Run checks", timestampMs: 1_000 },
      { id: "remote-2", seq: 2, role: "assistant", text: "All green!", timestampMs: 1_020 },
    ],
    socketClosed: yield* Deferred.make<void>(),
  };
  const portRef = { current: 0 };
  const answer = (expression: string): unknown => {
    if (expression.includes("stores.roster.getAgents")) {
      return {
        ok: true,
        data: {
          bots: [
            {
              id: "bot-alpha",
              name: "Alpha",
              avatarShape: "squircle",
              avatarColor: "cobalt",
              status: "thinking",
              isRunning: true,
              unreadCount: 1,
              lastMessagePreview: String(state.messages.at(-1)?.text ?? ""),
            },
          ],
        },
      };
    }
    if (expression.includes("transcript.getMessages")) {
      return { ok: true, data: { messages: state.messages, nextCursor: "seq:0", hasMore: true } };
    }
    if (expression.includes("transcript.sendMessage")) {
      const nonce = /"clientNonce":"([^"]+)"/.exec(expression)?.[1];
      if (nonce) state.sentNonces.push(nonce);
      return { ok: true, data: { accepted: true, messageId: "remote-3" } };
    }
    if (expression.includes("transcript.cancelRun")) {
      return { ok: true, data: { cancelled: true } };
    }
    return { ok: false, reason: "store_unavailable" };
  };

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/json",
      Effect.sync(() => {
        state.jsonRequests += 1;
        return HttpServerResponse.text(
          JSON.stringify([
            {
              id: "grok",
              type: "page",
              title: "Grok Bot",
              url: "file:///Applications/Grok%20Bot.app/Contents/Resources/app.asar/dist/renderer/index.html",
              webSocketDebuggerUrl: `ws://127.0.0.1:${portRef.current}/devtools/page/grok`,
            },
          ]),
          { contentType: "application/json" },
        );
      }),
    ),
    HttpRouter.add(
      "GET",
      "/devtools/page/grok",
      Effect.gen(function* () {
        const socket = yield* (yield* HttpServerRequest.HttpServerRequest).upgrade;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            const decoder = new TextDecoder();
            while (true) {
              for (const frame of yield* reader.pull) {
                const rpc = JSON.parse(
                  typeof frame === "string" ? frame : decoder.decode(frame),
                ) as { readonly id: number; readonly params: { readonly expression: string } };
                yield* writer.write(
                  JSON.stringify({
                    id: rpc.id,
                    result: { result: { type: "object", value: answer(rpc.params.expression) } },
                  }),
                );
              }
            }
          }),
        ).pipe(
          Effect.ensuring(Deferred.succeed(state.socketClosed, undefined)),
          Effect.ignoreCause,
        );
        return HttpServerResponse.empty();
      }),
    ),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const server = yield* HttpServer.HttpServer;
  portRef.current = (server.address as NetAddress.InetAddress).port;
  return { state, port: portRef.current };
});

/** A fake `/Applications/Grok Bot.app`, so the test never depends on this Mac. */
const fakeApp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "grok-bot-app-" });
  yield* fs.makeDirectory(`${dir}/Contents`, { recursive: true });
  yield* fs.writeFileString(`${dir}/Contents/Info.plist`, INFO_PLIST);
  return dir;
});

const collectEvents = Effect.gen(function* () {
  const platform = yield* BotsPlatformService.BotsPlatformService;
  const queue = yield* Queue.unbounded<BotEvent>();
  yield* platform.events.pipe(
    Stream.runForEach((event) => Queue.offer(queue, event)),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return Effect.fn("waitForEvent")(function* (predicate: (event: BotEvent) => boolean) {
    while (true) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  }, Effect.timeout("15 seconds"));
});

const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
});

describe("GrokBotAdapter through BotsPlatformService", () => {
  it.live("opens no CDP connection and no timers while the add-on is disabled", () =>
    Effect.gen(function* () {
      const { state, port } = yield* startMockGrokBot;
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const config = yield* AddonConfigService.AddonConfigService;
      yield* config.updateConfig("grok-bot", { cdpPort: port });
      yield* platform.register(
        yield* GrokBotAdapter.make({
          appPath: yield* fakeApp,
          pollIntervals: { idleMs: 2_000, activeMs: 2_000 },
        }),
      );
      yield* collectEvents;
      yield* platform.reconcile;
      yield* settle;

      assert.strictEqual(state.jsonRequests, 0);
      assert.deepStrictEqual(yield* platform.runningProviderIds, []);
      assert.deepStrictEqual(yield* platform.listProviders, []);
      assert.deepStrictEqual(yield* platform.addonStatus("grok-bot"), { kind: "disabled" });
      assert.deepStrictEqual(yield* platform.reconnect("grok-bot"), { kind: "disabled" });
      assert.strictEqual(state.jsonRequests, 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("discovers, reads, sends, streams and tears down cleanly on disable", () =>
    Effect.gen(function* () {
      const { state, port } = yield* startMockGrokBot;
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const config = yield* AddonConfigService.AddonConfigService;
      yield* config.updateConfig("grok-bot", { cdpPort: port });
      yield* platform.register(
        yield* GrokBotAdapter.make({
          appPath: yield* fakeApp,
          pollIntervals: { idleMs: 2_000, activeMs: 2_000 },
        }),
      );
      const waitFor = yield* collectEvents;

      // Enabling alone starts the provider: the platform follows the add-on's changes.
      yield* config.setEnabled({ id: "grok-bot", enabled: true });
      yield* waitFor((e) => e.type === "provider-status" && e.status.kind === "connected");
      const changed = yield* waitFor((e) => e.type === "bots-changed");
      assert.strictEqual(changed.type === "bots-changed" && changed.bots[0]?.name, "Alpha");
      yield* waitFor((e) => e.type === "message-upserted" && e.message.remoteId === "remote-2");

      const [descriptor] = yield* platform.listProviders;
      assert.strictEqual(descriptor?.transport, "local-app-bridge");
      assert.strictEqual(descriptor?.officialAppUrl, "grokbot://app/v1/prompt");
      assert.deepStrictEqual(
        {
          sendMessage: descriptor?.capabilities.sendMessage,
          history: descriptor?.capabilities.history,
          cancel: descriptor?.capabilities.cancel,
          approvals: descriptor?.capabilities.approvals,
          questions: descriptor?.capabilities.questions,
          streaming: descriptor?.capabilities.streaming,
          sync: descriptor?.capabilities.sync,
        },
        {
          sendMessage: true,
          history: "paged",
          cancel: true,
          approvals: false,
          questions: false,
          streaming: false,
          sync: "poll",
        },
      );

      const [bot] = yield* platform.listBots("grok-bot");
      assert.deepStrictEqual(bot?.avatar, {
        kind: "parametric",
        shape: "squircle",
        color: "cobalt",
        seed: "bot-alpha",
      });
      assert.strictEqual(bot?.status, "working");
      assert.strictEqual(bot?.metadata.grokActivity, "thinking");
      assert.strictEqual(bot?.defaultConversationId, "bot-alpha");
      assert.strictEqual(bot?.officialAppUrl, "grokbot://app/v1/prompt?id=bot-alpha");

      const page = yield* platform.getMessages({
        providerId: "grok-bot",
        conversationId: "bot-alpha",
        olderCursor: null,
        limit: 50,
      });
      assert.deepStrictEqual(
        page.messages.map((message) => [message.remoteId, message.role]),
        [
          ["remote-1", "user"],
          ["remote-2", "agent"],
        ],
      );
      assert.strictEqual(page.olderCursor, "seq:0");

      const sent = yield* platform.sendMessage({
        providerId: "grok-bot",
        conversationId: "bot-alpha",
        text: "Ship it",
        clientNonce: "nonce-ship",
      });
      assert.strictEqual(sent.remoteId, "remote-3");
      assert.strictEqual(sent.attribution, "user-via-mattr");
      assert.deepStrictEqual(state.sentNonces, ["nonce-ship"]);
      yield* platform.cancel({ providerId: "grok-bot", conversationId: "bot-alpha" });

      state.messages.push({
        id: "remote-4",
        seq: 4,
        role: "assistant",
        text: "Shipped.",
        timestampMs: 1_100,
      });
      const streamed = yield* waitFor(
        (e) => e.type === "message-upserted" && e.message.remoteId === "remote-4",
      );
      assert.strictEqual(
        streamed.type === "message-upserted" && streamed.message.markdown,
        "Shipped.",
      );

      yield* config.setEnabled({ id: "grok-bot", enabled: false });
      yield* waitFor((e) => e.type === "provider-status" && e.status.kind === "disabled");
      yield* Deferred.await(state.socketClosed).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(yield* platform.runningProviderIds, []);
      assert.deepStrictEqual(yield* config.getConfig("grok-bot"), { cdpPort: port });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("reports a missing debug port and a missing app without touching Grok Bot", () =>
    Effect.gen(function* () {
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const config = yield* AddonConfigService.AddonConfigService;
      const appPath = yield* fakeApp;
      // Port 1 is never a Grok Bot debug port, so the probe is refused at once.
      yield* config.updateConfig("grok-bot", { cdpPort: 1 });
      yield* platform.register(yield* GrokBotAdapter.make({ appPath }));
      yield* config.setEnabled({ id: "grok-bot", enabled: true });

      const unconfigured = yield* platform.reconnect("grok-bot");
      assert.strictEqual(unconfigured?.kind, "enabled_unconfigured");
      assert.strictEqual(unconfigured?.action?.kind, "configure");
      assert.strictEqual(unconfigured?.detail, "Grok Bot isn't reachable on debug port 1.");

      yield* platform.register(yield* GrokBotAdapter.make({ appPath: `${appPath}/missing.app` }));
      const missing = yield* platform.reconnect("grok-bot");
      assert.strictEqual(missing?.kind, "app_unavailable");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
