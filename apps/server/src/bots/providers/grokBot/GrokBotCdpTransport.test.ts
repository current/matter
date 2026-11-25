import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as NetAddress from "effect/net/NetAddress";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { describe, expect } from "vite-plus/test";

import {
  buildGrokBotLaunchCommand,
  buildGrokBotPluginDeepLink,
  buildGrokBotPromptDeepLink,
  deduplicateGrokBotMessages,
  getGrokBotActionFallback,
  GROK_BOT_BUNDLE_ID,
  GROK_BOT_CDP_CAPABILITIES,
  GROK_BOT_DEEP_LINK_ONLY_CAPABILITIES,
  GROK_BOT_MAX_PROMPT_LENGTH,
  GROK_BOT_URL_SCHEME,
  GrokBotCdpTransport,
  GrokBotProvider,
  GrokBotTransport,
  normalizeGrokBotStatus,
  parseGrokBotInfoPlist,
  sanitizeGrokBotAvatarDataUrl,
  selectGrokBotRendererTarget,
  validateLoopbackEndpoint,
  validateLoopbackWebSocketUrl,
} from "./index.ts";
import {
  isGrokBotAppUnavailableError,
  isGrokBotLoopbackViolationError,
  type GrokBotMessage,
} from "./GrokBotTransport.ts";

const SAMPLE_GROK_BOT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.anysphere.sand</string>
  <key>CFBundleShortVersionString</key>
  <string>1.3.0</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>grokbot</string>
        <string>sand</string>
      </array>
    </dict>
  </array>
</dict>
</plist>`;

const VALID_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+8J0AAAAASUVORK5CYII=";
const XSS_SVG_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==";

const makeMockFs = (installed: boolean) =>
  FileSystem.layerNoop({
    readFileString: (path) =>
      installed && path.endsWith("/Contents/Info.plist")
        ? Effect.succeed(SAMPLE_GROK_BOT_PLIST)
        : Effect.fail(new Error(`ENOENT: ${path}`) as never),
  });

interface MockCdpBehavior {
  readonly targets?: (port: number) => readonly Record<string, unknown>[];
  readonly onEvaluate: (
    expression: string,
    callIndex: number,
  ) =>
    | { readonly type: "value"; readonly value: unknown }
    | { readonly type: "close_socket" }
    | { readonly type: "rpc_error"; readonly code: number; readonly message: string };
  readonly onSocketClosed?: Deferred.Deferred<void>;
}

const withMockCdpServer = <A, E, R>(
  behavior: MockCdpBehavior,
  run: (port: number) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    let evaluateCount = 0;
    const portRef = { current: 0 };

    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/json",
        Effect.sync(() => {
          const targets = behavior.targets
            ? behavior.targets(portRef.current)
            : [
                {
                  id: "target-devtools",
                  type: "other",
                  title: "DevTools",
                  url: "devtools://devtools/bundled/inspector.html",
                  webSocketDebuggerUrl: `ws://127.0.0.1:${portRef.current}/devtools/page/devtools`,
                },
                {
                  id: "target-grok-bot",
                  type: "page",
                  title: "Grok Bot",
                  url: "file:///Applications/Grok%20Bot.app/Contents/Resources/app.asar/dist/renderer/index.html",
                  webSocketDebuggerUrl: `ws://127.0.0.1:${portRef.current}/devtools/page/grok`,
                },
              ];
          return HttpServerResponse.text(JSON.stringify(targets), {
            contentType: "application/json",
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/devtools/page/grok",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const socket = yield* request.upgrade;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              const decoder = new TextDecoder();
              while (true) {
                const frames = yield* reader.pull;
                for (const frame of frames) {
                  const text = typeof frame === "string" ? frame : decoder.decode(frame);
                  const rpc = JSON.parse(text) as {
                    readonly id: number;
                    readonly params: { readonly expression: string };
                  };
                  evaluateCount += 1;
                  const outcome = behavior.onEvaluate(rpc.params.expression, evaluateCount);
                  if (outcome.type === "close_socket") {
                    return;
                  }
                  if (outcome.type === "rpc_error") {
                    yield* writer.write(
                      JSON.stringify({
                        id: rpc.id,
                        error: { code: outcome.code, message: outcome.message },
                      }),
                    );
                    continue;
                  }
                  yield* writer.write(
                    JSON.stringify({
                      id: rpc.id,
                      result: {
                        result: {
                          type: "object",
                          value: outcome.value,
                        },
                      },
                    }),
                  );
                }
              }
            }),
          ).pipe(
            Effect.ensuring(
              behavior.onSocketClosed
                ? Deferred.succeed(behavior.onSocketClosed, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.ignoreCause,
          );
          return HttpServerResponse.empty();
        }),
      ),
    );

    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
    const server = yield* HttpServer.HttpServer;
    const address = server.address as NetAddress.InetAddress;
    portRef.current = address.port;
    return yield* run(address.port);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));

describe("loopback enforcement & normalization", () => {
  it("accepts only 127.0.0.1 with valid integer ports and rejects non-loopback hosts", () => {
    expect(validateLoopbackEndpoint()).toEqual({
      ok: true,
      endpoint: {
        host: "127.0.0.1",
        port: 9222,
        httpOrigin: "http://127.0.0.1:9222",
        jsonListUrl: "http://127.0.0.1:9222/json",
      },
    });

    for (const bad of [
      { host: "0.0.0.0", port: 9222 },
      { host: "localhost", port: 9222 },
      { host: "192.168.1.5", port: 9222 },
      { host: "example.com", port: 9222 },
      { host: "::1", port: 9222 },
      { host: "127.0.0.1", port: 0 },
      { host: "127.0.0.1", port: 70_000 },
      { host: "127.0.0.1", port: 9222.5 },
    ]) {
      const result = validateLoopbackEndpoint(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(isGrokBotLoopbackViolationError(result.error)).toBe(true);
      }
    }
  });

  it("rejects non-loopback or mismatched-port WebSocket debugger URLs", () => {
    expect(validateLoopbackWebSocketUrl("ws://127.0.0.1:9222/devtools/page/1", 9222)).toBe(
      "ws://127.0.0.1:9222/devtools/page/1",
    );
    expect(validateLoopbackWebSocketUrl("ws://localhost:9222/devtools/page/1", 9222)).toBeNull();
    expect(validateLoopbackWebSocketUrl("ws://evil.test:9222/devtools/page/1", 9222)).toBeNull();
    expect(validateLoopbackWebSocketUrl("ws://127.0.0.1:9333/devtools/page/1", 9222)).toBeNull();
    expect(validateLoopbackWebSocketUrl("wss://127.0.0.1:9222/devtools/page/1", 9222)).toBeNull();
  });

  it("parses Grok Bot Info.plist metadata and selects only loopback renderer targets", () => {
    expect(parseGrokBotInfoPlist(SAMPLE_GROK_BOT_PLIST)).toEqual({
      bundleId: GROK_BOT_BUNDLE_ID,
      version: "1.3.0",
      urlSchemes: [GROK_BOT_URL_SCHEME, "sand"],
    });
    expect(GrokBotCdpTransport.computeReconnectBackoffMs(0, 500, 30_000)).toBe(500);
    expect(GrokBotCdpTransport.computeReconnectBackoffMs(3, 500, 30_000)).toBe(4_000);
    expect(GrokBotCdpTransport.computeReconnectBackoffMs(10, 500, 30_000)).toBe(30_000);
    expect(normalizeGrokBotStatus({ awaitingUserResponse: true, isRunning: true })).toBe(
      "attention",
    );
    expect(normalizeGrokBotStatus({ hasError: true, isRunning: true })).toBe("error");
    expect(normalizeGrokBotStatus({ status: "searching" })).toBe("searching");
    expect(normalizeGrokBotStatus({ isOffline: true })).toBe("offline");

    const selected = selectGrokBotRendererTarget(
      [
        {
          id: "external",
          type: "page",
          title: "Grok Bot",
          url: "https://example.com",
          webSocketDebuggerUrl: "ws://192.168.0.2:9222/devtools/page/evil",
        },
        {
          id: "local",
          type: "page",
          title: "Grok Bot",
          url: "file:///app/index.html",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/local",
        },
      ],
      9222,
    );
    expect(selected?.target.id).toBe("local");
    expect(selected?.webSocketDebuggerUrl).toBe("ws://127.0.0.1:9222/devtools/page/local");
  });

  it("sanitizes avatar data URLs and deduplicates optimistic vs authoritative messages", () => {
    expect(sanitizeGrokBotAvatarDataUrl(VALID_PNG_DATA_URL)).toBe(VALID_PNG_DATA_URL);
    expect(sanitizeGrokBotAvatarDataUrl(XSS_SVG_DATA_URL)).toBeNull();
    expect(sanitizeGrokBotAvatarDataUrl("javascript:alert(1)")).toBeNull();

    const messages: readonly GrokBotMessage[] = [
      {
        id: "optimistic-1",
        seq: null,
        botId: "bot-1",
        role: "user",
        text: "hello",
        timestampMs: 100,
        clientNonce: "nonce-1",
        replyToId: null,
        isStreaming: false,
      },
      {
        id: "msg-remote-1",
        seq: 1,
        botId: "bot-1",
        role: "user",
        text: "hello",
        timestampMs: 105,
        clientNonce: "nonce-1",
        replyToId: null,
        isStreaming: false,
      },
      {
        id: "msg-remote-2",
        seq: 2,
        botId: "bot-1",
        role: "assistant",
        text: "hi there",
        timestampMs: 120,
        clientNonce: null,
        replyToId: "msg-remote-1",
        isStreaming: false,
      },
    ];
    expect(deduplicateGrokBotMessages(messages).map((m) => m.id)).toEqual([
      "msg-remote-1",
      "msg-remote-2",
    ]);
  });

  it("builds safe grokbot:// deep links and Open in Grok Bot fallbacks", () => {
    expect(buildGrokBotLaunchCommand()).toBe(
      'open -a "Grok Bot" --args --remote-debugging-port=9222',
    );
    expect(buildGrokBotLaunchCommand(9333)).toBe(
      'open -a "Grok Bot" --args --remote-debugging-port=9333',
    );
    expect(buildGrokBotPromptDeepLink({ botId: "bot_123", text: "Check build" })).toBe(
      "grokbot://app/v1/prompt?id=bot_123&text=Check+build",
    );
    expect(buildGrokBotPromptDeepLink({ botId: "bad id/../../x", text: "Hello" })).toBe(
      "grokbot://app/v1/prompt?text=Hello",
    );
    const longPrompt = "a".repeat(GROK_BOT_MAX_PROMPT_LENGTH + 250);
    const parsedLong = new URL(buildGrokBotPromptDeepLink({ text: longPrompt }));
    expect(parsedLong.searchParams.get("text")?.length).toBe(GROK_BOT_MAX_PROMPT_LENGTH);

    expect(buildGrokBotPluginDeepLink("plugin-1")).toBe("grokbot://app/v1/plugin/add?id=plugin-1");
    expect(buildGrokBotPluginDeepLink("bad plugin")).toBeNull();

    const fallback = getGrokBotActionFallback(GROK_BOT_CDP_CAPABILITIES, "routines", {
      botId: "bot_1",
    });
    expect(fallback).toEqual({
      supported: false,
      label: "Open in Grok Bot",
      deepLinkUrl: "grokbot://app/v1/prompt?id=bot_1",
    });
    expect(GROK_BOT_DEEP_LINK_ONLY_CAPABILITIES.discoverBots).toBe(false);
    expect(GROK_BOT_DEEP_LINK_ONLY_CAPABILITIES.deepLinkUrl).toBe(true);
  });
});

describe("GrokBotCdpTransport integration", () => {
  it.effect("refuses non-loopback host before touching filesystem or network", () =>
    Effect.gen(function* () {
      const transport = yield* GrokBotTransport.GrokBotTransport;
      const result = yield* transport.detectAvailability().pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(isGrokBotLoopbackViolationError(result.failure)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        GrokBotCdpTransport.layer({ host: "0.0.0.0", port: 9222 }).pipe(
          Layer.provide([
            makeMockFs(true),
            FetchHttpClient.layer,
            NodeSocket.layerWebSocketConstructor,
          ]),
        ),
      ),
    ),
  );

  it.effect("reports app_unavailable when Grok Bot.app is missing", () =>
    Effect.gen(function* () {
      const transport = yield* GrokBotTransport.GrokBotTransport;
      const availability = yield* transport.detectAvailability();
      expect(availability.state).toBe("app_unavailable");
      expect(availability.app.installed).toBe(false);
      expect(availability.launchCommand).toBe(
        'open -a "Grok Bot" --args --remote-debugging-port=9222',
      );
    }).pipe(
      Effect.provide(
        GrokBotCdpTransport.layer({ port: 9222 }).pipe(
          Layer.provide([
            makeMockFs(false),
            FetchHttpClient.layer,
            NodeSocket.layerWebSocketConstructor,
          ]),
        ),
      ),
    ),
  );

  it.live("reports enabled_unconfigured with safe launch command when CDP port is closed", () =>
    Effect.gen(function* () {
      const transport = yield* GrokBotTransport.GrokBotTransport;
      const availability = yield* transport.detectAvailability();
      expect(availability.state).toBe("enabled_unconfigured");
      expect(availability.app.installed).toBe(true);
      expect(availability.app.bundleId).toBe("com.anysphere.sand");
      expect(availability.app.version).toBe("1.3.0");
      expect(availability.launchCommand).toBe(
        'open -a "Grok Bot" --args --remote-debugging-port=1',
      );

      const discoverResult = yield* transport.discoverBots().pipe(Effect.result);
      expect(discoverResult._tag).toBe("Failure");
      if (discoverResult._tag === "Failure") {
        expect(isGrokBotAppUnavailableError(discoverResult.failure)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        GrokBotCdpTransport.layer({ port: 1, connectTimeout: "500 millis" }).pipe(
          Layer.provide([
            makeMockFs(true),
            FetchHttpClient.layer,
            NodeSocket.layerWebSocketConstructor,
          ]),
        ),
      ),
    ),
  );

  it.live(
    "discovers bots, lists deduplicated history, sends, cancels, and disposes WS cleanly on scope close",
    () =>
      Effect.gen(function* () {
        const socketClosed = yield* Deferred.make<void>();
        const sentNonces: string[] = [];

        yield* withMockCdpServer(
          {
            onSocketClosed: socketClosed,
            onEvaluate: (expression) => {
              if (expression.includes("stores.roster.getAgents")) {
                return {
                  type: "value",
                  value: {
                    ok: true,
                    data: {
                      bots: [
                        {
                          id: "bot-alpha",
                          name: "Alpha",
                          avatarDataUrl: VALID_PNG_DATA_URL,
                          avatarShape: "squircle",
                          avatarColor: "cobalt",
                          isRunning: true,
                          unreadCount: 2,
                          lastMessagePreview: "Working on build",
                        },
                        {
                          id: "bot-xss",
                          name: "Unsafe",
                          avatarDataUrl: XSS_SVG_DATA_URL,
                          avatarShape: "cloud",
                          avatarColor: "emerald",
                          awaitingUserResponse: true,
                        },
                      ],
                    },
                  },
                };
              }
              if (expression.includes("transcript.getMessages")) {
                return {
                  type: "value",
                  value: {
                    ok: true,
                    data: {
                      messages: [
                        {
                          id: "local-echo",
                          role: "user",
                          text: "Run checks",
                          clientNonce: "nonce-abc",
                          timestampMs: 1000,
                        },
                        {
                          id: "remote-1",
                          seq: 1,
                          role: "user",
                          text: "Run checks",
                          clientNonce: "nonce-abc",
                          timestampMs: 1005,
                        },
                        {
                          id: "remote-2",
                          seq: 2,
                          role: "assistant",
                          text: "All green!",
                          timestampMs: 1020,
                        },
                      ],
                      nextCursor: "seq:0",
                      hasMore: true,
                    },
                  },
                };
              }
              if (expression.includes("transcript.sendMessage")) {
                const nonceMatch = /"clientNonce":"([^"]+)"/.exec(expression);
                if (nonceMatch?.[1]) sentNonces.push(nonceMatch[1]);
                return {
                  type: "value",
                  value: {
                    ok: true,
                    data: { accepted: true, messageId: "remote-3" },
                  },
                };
              }
              if (expression.includes("transcript.cancelRun")) {
                return {
                  type: "value",
                  value: {
                    ok: true,
                    data: { cancelled: true },
                  },
                };
              }
              return { type: "value", value: { ok: false, reason: "store_unavailable" } };
            },
          },
          (port) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const providerLayer = GrokBotProvider.layer.pipe(
                Layer.provide(
                  GrokBotCdpTransport.layer({ port }).pipe(
                    Layer.provide([
                      makeMockFs(true),
                      FetchHttpClient.layer,
                      GrokBotCdpTransport.safeWebSocketConstructorLayer,
                    ]),
                  ),
                ),
              );
              const env = yield* Layer.buildWithScope(providerLayer, scope);
              const provider = yield* Effect.service(GrokBotProvider.GrokBotProvider).pipe(
                Effect.provide(env),
              );
              expect(provider.id).toBe(GrokBotProvider.GROK_BOT_PROVIDER_ID);
              expect(provider.name).toBe(GrokBotProvider.GROK_BOT_PROVIDER_NAME);

              const availability = yield* provider.detectAvailability();
              expect(availability.state).toBe("connected");
              expect(availability.targetTitle).toBe("Grok Bot");

              const bots = yield* provider.discoverBots();
              expect(bots).toHaveLength(2);
              expect(bots[0]).toMatchObject({
                id: "bot-alpha",
                name: "Alpha",
                avatarDataUrl: VALID_PNG_DATA_URL,
                avatarShape: "squircle",
                avatarColor: "cobalt",
                status: "working",
                unreadCount: 2,
                lastMessagePreview: "Working on build",
                deepLinkUrl: "grokbot://app/v1/prompt?id=bot-alpha",
              });
              expect(bots[1]).toMatchObject({
                id: "bot-xss",
                avatarDataUrl: null,
                status: "attention",
              });

              const page = yield* provider.listMessages("bot-alpha");
              expect(page.messages.map((m) => m.id)).toEqual(["remote-1", "remote-2"]);
              expect(page.nextCursor).toBe("seq:0");
              expect(page.hasMore).toBe(true);

              const sent = yield* provider.sendMessage("bot-alpha", "Ship it", {
                clientNonce: "nonce-ship",
              });
              expect(sent).toEqual({
                botId: "bot-alpha",
                clientNonce: "nonce-ship",
                accepted: true,
                messageId: "remote-3",
              });
              expect(sentNonces).toEqual(["nonce-ship"]);

              const cancelled = yield* provider.cancelRun("bot-alpha");
              expect(cancelled).toEqual({
                botId: "bot-alpha",
                cancelled: true,
                fallbackDeepLinkUrl: "grokbot://app/v1/prompt?id=bot-alpha",
              });

              // Disposing the transport scope must close the live CDP socket cleanly.
              yield* Scope.close(scope, Exit.void);
              yield* Deferred.await(socketClosed);
            }),
        );
      }),
  );

  it.live("handles unexpected CDP socket drop, emits disconnected event, and reconnects", () =>
    withMockCdpServer(
      {
        onEvaluate: (_expression, callIndex) => {
          if (callIndex === 1) {
            return { type: "close_socket" };
          }
          return {
            type: "value",
            value: {
              ok: true,
              data: {
                bots: [
                  {
                    id: "bot-recovered",
                    name: "Recovered",
                    isRunning: false,
                  },
                ],
              },
            },
          };
        },
      },
      (port) =>
        Effect.gen(function* () {
          const transport = yield* GrokBotTransport.GrokBotTransport;
          const events = yield* transport.subscribe({ pollInterval: "60 seconds" });

          const firstAttempt = yield* transport.discoverBots().pipe(Effect.result);
          expect(firstAttempt._tag).toBe("Failure");

          // Wait for either disconnected or recovered bots event cleanly via PubSub.take.
          const event = yield* PubSub.take(events);
          expect(["disconnected", "bots_updated"]).toContain(event.type);

          const recovered = yield* transport.discoverBots();
          expect(recovered).toHaveLength(1);
          expect(recovered[0]?.id).toBe("bot-recovered");
        }).pipe(
          Effect.scoped,
          Effect.provide(
            GrokBotCdpTransport.layerLive({ port }).pipe(Layer.provide(makeMockFs(true))),
          ),
        ),
    ),
  );
});
