import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";

import {
  buildGrokBotLaunchCommand,
  buildGrokBotPromptDeepLink,
  GROK_BOT_APP_PATH,
  GROK_BOT_CDP_CAPABILITIES,
  GROK_BOT_DEFAULT_CDP_HOST,
  GROK_BOT_DEFAULT_CDP_PORT,
} from "./grokBotDeepLinks.ts";
import {
  buildCancelRunExpression,
  buildDiscoverBotsExpression,
  buildListMessagesExpression,
  buildSendMessageExpression,
  deduplicateGrokBotMessages,
  normalizeGrokBotMessage,
  normalizeGrokBotSummary,
  parseGrokBotInfoPlist,
  selectGrokBotRendererTarget,
  validateLoopbackEndpoint,
  type CdpTargetDescriptor,
  type ValidatedLoopbackEndpoint,
} from "./grokBotStoreNormalization.ts";
import {
  GrokBotAppUnavailableError,
  GrokBotCdpConnectionError,
  GrokBotCdpProtocolError,
  GrokBotStoreBridgeError,
  GrokBotTransport,
  type GrokBotAppInfo,
  type GrokBotAvailability,
  type GrokBotCancelResult,
  type GrokBotMessagePage,
  type GrokBotSendResult,
  type GrokBotSummary,
  type GrokBotTransportError,
  type GrokBotTransportEvent,
} from "./GrokBotTransport.ts";

export interface GrokBotCdpTransportConfig {
  readonly host?: string;
  readonly port?: number;
  readonly appPath?: string;
  readonly connectTimeout?: Duration.Input;
  readonly requestTimeout?: Duration.Input;
  readonly pollInterval?: Duration.Input;
  readonly baseReconnectDelay?: Duration.Input;
  readonly maxReconnectDelay?: Duration.Input;
}

const DEFAULT_CONNECT_TIMEOUT: Duration.Input = "3 seconds";
const DEFAULT_REQUEST_TIMEOUT: Duration.Input = "5 seconds";
const DEFAULT_POLL_INTERVAL: Duration.Input = "2 seconds";
const DEFAULT_BASE_RECONNECT_DELAY: Duration.Input = "500 millis";
const DEFAULT_MAX_RECONNECT_DELAY: Duration.Input = "30 seconds";

const CdpTargetSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  webSocketDebuggerUrl: Schema.optionalKey(Schema.String),
});

const CdpTargetListFromJson = Schema.fromJsonString(Schema.Array(CdpTargetSchema));
const decodeCdpTargetList = Schema.decodeUnknownEffect(CdpTargetListFromJson);

const CdpEvaluateRequestSchema = Schema.Struct({
  id: Schema.Number,
  method: Schema.Literal("Runtime.evaluate"),
  params: Schema.Struct({
    expression: Schema.String,
    returnByValue: Schema.Boolean,
    awaitPromise: Schema.Boolean,
  }),
});

const encodeCdpEvaluateRequest = Schema.encodeEffect(
  Schema.fromJsonString(CdpEvaluateRequestSchema),
);

const CdpRpcErrorSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.String),
});

const CdpRpcResponseSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(CdpRpcErrorSchema),
});

const decodeCdpRpcResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CdpRpcResponseSchema),
);

type CdpRpcResponse = Schema.Schema.Type<typeof CdpRpcResponseSchema>;

interface ActiveCdpConnection {
  readonly wsUrl: string;
  readonly scope: Scope.Closeable;
  readonly write: (chunk: string) => Effect.Effect<void, Socket.SocketError>;
  readonly pending: Map<number, Deferred.Deferred<CdpRpcResponse, GrokBotTransportError>>;
}

export function computeReconnectBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const safeBase = Math.max(10, Math.floor(baseDelayMs));
  const safeMax = Math.max(safeBase, Math.floor(maxDelayMs));
  const clampedAttempt = Math.max(0, Math.min(16, Math.floor(attempt)));
  return Math.min(safeBase * 2 ** clampedAttempt, safeMax);
}

// Effect drops listeners before closing a connecting socket, which can trigger an unhandled `ws` error.
export const safeWebSocketConstructorLayer = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const makeSocket = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = makeSocket(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

function extractBridgeEnvelope(
  operation: "discover_bots" | "list_messages" | "send_message" | "cancel_run",
  rpcResponse: CdpRpcResponse,
  botId?: string,
):
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly error: GrokBotCdpProtocolError | GrokBotStoreBridgeError;
    } {
  if (rpcResponse.error) {
    return {
      ok: false,
      error: new GrokBotCdpProtocolError({
        operation,
        ...(rpcResponse.error.code !== undefined ? { code: rpcResponse.error.code } : {}),
      }),
    };
  }

  if (typeof rpcResponse.result !== "object" || rpcResponse.result === null) {
    return {
      ok: false,
      error: new GrokBotStoreBridgeError({
        operation,
        ...(botId ? { botId } : {}),
        reason: "invalid_payload",
      }),
    };
  }

  const evalResult = rpcResponse.result as Record<string, unknown>;
  if (evalResult.exceptionDetails !== undefined) {
    return {
      ok: false,
      error: new GrokBotCdpProtocolError({ operation }),
    };
  }

  const remoteObject = evalResult.result;
  if (typeof remoteObject !== "object" || remoteObject === null) {
    return {
      ok: false,
      error: new GrokBotStoreBridgeError({
        operation,
        ...(botId ? { botId } : {}),
        reason: "invalid_payload",
      }),
    };
  }

  const value = (remoteObject as Record<string, unknown>).value;
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      error: new GrokBotStoreBridgeError({
        operation,
        ...(botId ? { botId } : {}),
        reason: "invalid_payload",
      }),
    };
  }

  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== true) {
    const rawReason = envelope.reason;
    const reason =
      rawReason === "store_unavailable" ||
      rawReason === "bot_not_found" ||
      rawReason === "action_rejected"
        ? rawReason
        : "invalid_payload";
    return {
      ok: false,
      error: new GrokBotStoreBridgeError({
        operation,
        ...(botId ? { botId } : {}),
        reason,
      }),
    };
  }

  if (typeof envelope.data !== "object" || envelope.data === null) {
    return {
      ok: false,
      error: new GrokBotStoreBridgeError({
        operation,
        ...(botId ? { botId } : {}),
        reason: "invalid_payload",
      }),
    };
  }

  return { ok: true, data: envelope.data as Record<string, unknown> };
}

const make = Effect.fn("GrokBotCdpTransport.make")(function* (config?: GrokBotCdpTransportConfig) {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const wsConstructor = yield* Socket.WebSocketConstructor;
  const transportScope = yield* Effect.scope;

  const rawHost = config?.host ?? GROK_BOT_DEFAULT_CDP_HOST;
  const rawPort = config?.port ?? GROK_BOT_DEFAULT_CDP_PORT;
  const appPath = config?.appPath ?? GROK_BOT_APP_PATH;
  const connectTimeout = config?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
  const requestTimeout = config?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const defaultPollInterval = config?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const baseReconnectMs = Duration.toMillis(
    Duration.fromInputUnsafe(config?.baseReconnectDelay ?? DEFAULT_BASE_RECONNECT_DELAY),
  );
  const maxReconnectMs = Duration.toMillis(
    Duration.fromInputUnsafe(config?.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY),
  );

  const events = yield* PubSub.unbounded<GrokBotTransportEvent>();
  const connectionLock = yield* Semaphore.make(1);
  const activeConnectionRef = yield* Ref.make<ActiveCdpConnection | null>(null);
  const nextRequestIdRef = yield* Ref.make(1);
  const nextNonceSeqRef = yield* Ref.make(1);
  const reconnectAttemptsRef = yield* Ref.make(0);

  const requireEndpoint = Effect.fn("GrokBotCdpTransport.requireEndpoint")(function* () {
    const checked = validateLoopbackEndpoint({ host: rawHost, port: rawPort });
    if (!checked.ok) {
      return yield* checked.error;
    }
    return checked.endpoint;
  });

  const inspectApp = Effect.fn("GrokBotCdpTransport.inspectApp")(
    function* (): Effect.fn.Return<GrokBotAppInfo> {
      const plistPath = `${appPath}/Contents/Info.plist`;
      const xmlOption = yield* fileSystem.readFileString(plistPath).pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      if (Option.isNone(xmlOption)) {
        return {
          installed: false,
          appPath,
          bundleId: null,
          version: null,
          urlSchemes: [],
        };
      }
      const parsed = parseGrokBotInfoPlist(xmlOption.value);
      return {
        installed: true,
        appPath,
        bundleId: parsed.bundleId,
        version: parsed.version,
        urlSchemes: parsed.urlSchemes,
      };
    },
  );

  const fetchTargets = Effect.fn("GrokBotCdpTransport.fetchTargets")(function* (
    endpoint: ValidatedLoopbackEndpoint,
  ) {
    const request = HttpClientRequest.get(endpoint.jsonListUrl);
    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(
        (cause) =>
          new GrokBotCdpConnectionError({
            stage: "discover_targets",
            endpoint: endpoint.jsonListUrl,
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: connectTimeout,
        orElse: () =>
          Effect.fail(
            new GrokBotCdpConnectionError({
              stage: "timeout",
              endpoint: endpoint.jsonListUrl,
              cause: "CDP target discovery timed out",
            }),
          ),
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new GrokBotCdpConnectionError({
        stage: "discover_targets",
        endpoint: endpoint.jsonListUrl,
        cause: `HTTP ${response.status}`,
      });
    }
    const bodyText = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new GrokBotCdpConnectionError({
            stage: "discover_targets",
            endpoint: endpoint.jsonListUrl,
            cause,
          }),
      ),
    );
    const decoded = yield* decodeCdpTargetList(bodyText).pipe(
      Effect.mapError(
        (cause) =>
          new GrokBotCdpProtocolError({
            operation: "discover_targets",
            cause,
          }),
      ),
    );
    return decoded as readonly CdpTargetDescriptor[];
  });

  const failPendingRequests = (
    pending: Map<number, Deferred.Deferred<CdpRpcResponse, GrokBotTransportError>>,
    endpoint: string,
    cause: unknown,
  ) =>
    Effect.forEach(
      [...pending.entries()],
      ([id, deferred]) => {
        pending.delete(id);
        return Deferred.fail(
          deferred,
          new GrokBotCdpConnectionError({
            stage: "socket_closed",
            endpoint,
            cause,
          }),
        ).pipe(Effect.ignore);
      },
      { discard: true },
    );

  const dropActiveConnection = Effect.fn("GrokBotCdpTransport.dropActiveConnection")(function* (
    reason: string,
  ) {
    const current = yield* Ref.getAndSet(activeConnectionRef, null);
    if (!current) return;
    yield* failPendingRequests(current.pending, current.wsUrl, reason);
    yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
    yield* PubSub.publish(events, { type: "disconnected", reason }).pipe(Effect.ignore);
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* dropActiveConnection("transport_disposed");
      yield* PubSub.shutdown(events).pipe(Effect.ignore);
    }),
  );

  const detectAvailability = Effect.fn("GrokBotCdpTransport.detectAvailability")(function* () {
    const endpoint = yield* requireEndpoint();
    const launchCommand = buildGrokBotLaunchCommand(endpoint.port);
    const app = yield* inspectApp();

    if (!app.installed) {
      return {
        state: "app_unavailable",
        app,
        cdpEndpoint: endpoint.httpOrigin,
        targetTitle: null,
        targetUrl: null,
        launchCommand,
        detail: `Grok Bot is not installed at ${appPath}.`,
      } satisfies GrokBotAvailability;
    }

    const targetsResult = yield* fetchTargets(endpoint).pipe(Effect.result);
    if (targetsResult._tag === "Failure") {
      return {
        state: "enabled_unconfigured",
        app,
        cdpEndpoint: endpoint.httpOrigin,
        targetTitle: null,
        targetUrl: null,
        launchCommand,
        detail: `Grok Bot is installed (${app.version ?? "unknown version"}), but its loopback debug port is not active. Launch with: ${launchCommand}`,
      } satisfies GrokBotAvailability;
    }

    const selected = selectGrokBotRendererTarget(targetsResult.success, endpoint.port);
    if (!selected) {
      return {
        state: "incompatible_version",
        app,
        cdpEndpoint: endpoint.httpOrigin,
        targetTitle: null,
        targetUrl: null,
        launchCommand,
        detail:
          "Loopback debug port responded, but no compatible Grok Bot renderer target was found.",
      } satisfies GrokBotAvailability;
    }

    return {
      state: "connected",
      app,
      cdpEndpoint: endpoint.httpOrigin,
      targetTitle: selected.target.title ?? null,
      targetUrl: selected.target.url ?? null,
      launchCommand,
      detail: "Connected to local Grok Bot loopback debug target.",
    } satisfies GrokBotAvailability;
  });

  const ensureConnected = Effect.fn("GrokBotCdpTransport.ensureConnected")(function* () {
    const endpoint = yield* requireEndpoint();
    return yield* connectionLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* Ref.get(activeConnectionRef);
        if (existing) return existing;

        const launchCommand = buildGrokBotLaunchCommand(endpoint.port);
        const app = yield* inspectApp();
        if (!app.installed) {
          return yield* new GrokBotAppUnavailableError({
            appPath,
            state: "app_unavailable",
            launchCommand,
          });
        }

        const targets = yield* fetchTargets(endpoint).pipe(
          Effect.catchTags({
            GrokBotCdpConnectionError: () =>
              Effect.fail(
                new GrokBotAppUnavailableError({
                  appPath,
                  state: "enabled_unconfigured",
                  launchCommand,
                }),
              ),
          }),
        );

        const selected = selectGrokBotRendererTarget(targets, endpoint.port);
        if (!selected) {
          return yield* new GrokBotAppUnavailableError({
            appPath,
            state: "incompatible_version",
            launchCommand,
          });
        }

        const wsUrl = selected.webSocketDebuggerUrl;
        const connScope = yield* Scope.fork(transportScope);
        const pending = new Map<number, Deferred.Deferred<CdpRpcResponse, GrokBotTransportError>>();

        const socketResult = yield* Socket.makeWebSocket(wsUrl, {
          openTimeout: connectTimeout,
        }).pipe(
          Effect.provideService(Socket.WebSocketConstructor, wsConstructor),
          Effect.flatMap((socket) =>
            Effect.gen(function* () {
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              return { reader, writer };
            }),
          ),
          Scope.provide(connScope),
          Effect.result,
        );

        if (socketResult._tag === "Failure") {
          yield* Scope.close(connScope, Exit.void).pipe(Effect.ignore);
          return yield* new GrokBotCdpConnectionError({
            stage: "connect_socket",
            endpoint: wsUrl,
            cause: socketResult.failure,
          });
        }

        const { reader, writer } = socketResult.success;
        const connection: ActiveCdpConnection = {
          wsUrl,
          scope: connScope,
          write: (chunk) => writer.write(chunk),
          pending,
        };

        yield* Ref.set(activeConnectionRef, connection);
        yield* Ref.set(reconnectAttemptsRef, 0);

        const decoder = new TextDecoder();
        const pumpLoop = Effect.gen(function* () {
          while (true) {
            const frames = yield* reader.pull;
            for (const frame of frames) {
              const rawText = typeof frame === "string" ? frame : decoder.decode(frame);
              const parsed = yield* decodeCdpRpcResponse(rawText).pipe(Effect.result);
              if (parsed._tag === "Success" && parsed.success.id !== undefined) {
                const deferred = pending.get(parsed.success.id);
                if (deferred) {
                  pending.delete(parsed.success.id);
                  yield* Deferred.succeed(deferred, parsed.success).pipe(Effect.ignore);
                }
              }
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const current = yield* Ref.get(activeConnectionRef);
              if (current === connection) {
                yield* Ref.set(activeConnectionRef, null);
                yield* failPendingRequests(pending, wsUrl, "cdp_socket_closed");
                yield* PubSub.publish(events, {
                  type: "disconnected",
                  reason: "cdp_socket_closed",
                }).pipe(Effect.ignore);
              } else {
                yield* failPendingRequests(pending, wsUrl, "cdp_socket_closed");
              }
            }),
          ),
          Effect.ignoreCause,
        );

        yield* Effect.forkIn(pumpLoop, connScope);
        return connection;
      }),
    );
  });

  const evaluateInRenderer = Effect.fn("GrokBotCdpTransport.evaluateInRenderer")(function* (
    operation: "discover_bots" | "list_messages" | "send_message" | "cancel_run",
    expression: string,
    botId?: string,
  ) {
    const connection = yield* ensureConnected();
    const id = yield* Ref.getAndUpdate(nextRequestIdRef, (current) => current + 1);
    const deferred = yield* Deferred.make<CdpRpcResponse, GrokBotTransportError>();
    connection.pending.set(id, deferred);

    const encodedPayload = yield* encodeCdpEvaluateRequest({
      id,
      method: "Runtime.evaluate",
      params: {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GrokBotCdpProtocolError({
            operation,
            cause,
          }),
      ),
    );

    const writeResult = yield* connection.write(encodedPayload).pipe(Effect.result);
    if (writeResult._tag === "Failure") {
      connection.pending.delete(id);
      yield* dropActiveConnection("cdp_write_failed");
      return yield* new GrokBotCdpConnectionError({
        stage: "socket_closed",
        endpoint: connection.wsUrl,
        cause: writeResult.failure,
      });
    }

    const rpcResponseOption = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(requestTimeout),
    );
    if (Option.isNone(rpcResponseOption)) {
      connection.pending.delete(id);
      yield* dropActiveConnection("cdp_request_timeout");
      return yield* new GrokBotCdpConnectionError({
        stage: "timeout",
        endpoint: connection.wsUrl,
        cause: `CDP request timed out during ${operation}`,
      });
    }
    const rpcResponse = rpcResponseOption.value;

    const extracted = extractBridgeEnvelope(operation, rpcResponse, botId);
    if (!extracted.ok) {
      return yield* extracted.error;
    }
    return extracted.data;
  });

  const discoverBots = Effect.fn("GrokBotCdpTransport.discoverBots")(function* () {
    const data = yield* evaluateInRenderer("discover_bots", buildDiscoverBotsExpression());
    const rawBots = Array.isArray(data.bots) ? data.bots : [];
    const normalized: GrokBotSummary[] = [];
    for (const entry of rawBots) {
      const bot = normalizeGrokBotSummary(entry);
      if (bot) {
        normalized.push(bot);
      }
    }
    return normalized as readonly GrokBotSummary[];
  });

  const listMessages = Effect.fn("GrokBotCdpTransport.listMessages")(function* (
    botId: string,
    cursor?: string,
  ) {
    const data = yield* evaluateInRenderer(
      "list_messages",
      buildListMessagesExpression(botId, cursor),
      botId,
    );
    const rawMessages = Array.isArray(data.messages) ? data.messages : [];
    const parsed = rawMessages
      .map((entry, index) => normalizeGrokBotMessage(botId, entry, index))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const messages = deduplicateGrokBotMessages(parsed);
    const nextCursor = typeof data.nextCursor === "string" ? data.nextCursor : null;
    const hasMore = data.hasMore === true && nextCursor !== null;

    return {
      botId,
      messages,
      nextCursor,
      hasMore,
    } satisfies GrokBotMessagePage;
  });

  const sendMessage = Effect.fn("GrokBotCdpTransport.sendMessage")(function* (
    botId: string,
    text: string,
    options?: { readonly clientNonce?: string },
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const seq = yield* Ref.getAndUpdate(nextNonceSeqRef, (current) => current + 1);
    const clientNonce =
      options?.clientNonce && options.clientNonce.trim().length > 0
        ? options.clientNonce.trim()
        : `mattr-${nowMs}-${seq}`;

    const data = yield* evaluateInRenderer(
      "send_message",
      buildSendMessageExpression(botId, text, clientNonce),
      botId,
    );
    const accepted = data.accepted !== false;
    const messageId = typeof data.messageId === "string" ? data.messageId : null;

    return {
      botId,
      clientNonce,
      accepted,
      messageId,
    } satisfies GrokBotSendResult;
  });

  const cancelRun = Effect.fn("GrokBotCdpTransport.cancelRun")(function* (botId: string) {
    const fallbackDeepLinkUrl = buildGrokBotPromptDeepLink({ botId });
    const data = yield* evaluateInRenderer("cancel_run", buildCancelRunExpression(botId), botId);
    return {
      botId,
      cancelled: data.cancelled === true,
      fallbackDeepLinkUrl,
    } satisfies GrokBotCancelResult;
  });

  const subscribe = Effect.fn("GrokBotCdpTransport.subscribe")(function* (options?: {
    readonly pollInterval?: Duration.Input;
  }) {
    yield* requireEndpoint();
    const subscriberScope = yield* Effect.scope;
    const dequeue = yield* PubSub.subscribe(events);
    const pollInterval = options?.pollInterval ?? defaultPollInterval;

    const pollFiber = Effect.gen(function* () {
      let previousById = new Map<string, GrokBotSummary>();
      while (true) {
        const result = yield* discoverBots().pipe(Effect.result);
        if (result._tag === "Success") {
          yield* Ref.set(reconnectAttemptsRef, 0);
          const bots = result.success;
          let changed = bots.length !== previousById.size;
          const nextById = new Map<string, GrokBotSummary>();
          for (const bot of bots) {
            nextById.set(bot.id, bot);
            const prev = previousById.get(bot.id);
            if (
              !prev ||
              prev.status !== bot.status ||
              prev.unreadCount !== bot.unreadCount ||
              prev.lastMessagePreview !== bot.lastMessagePreview
            ) {
              changed = true;
            }
            if (prev && (prev.status !== bot.status || prev.unreadCount !== bot.unreadCount)) {
              yield* PubSub.publish(events, {
                type: "bot_status_changed",
                botId: bot.id,
                previousStatus: prev.status,
                status: bot.status,
                unreadCount: bot.unreadCount,
              });
            }
          }
          if (changed) {
            previousById = nextById;
            yield* PubSub.publish(events, { type: "bots_updated", bots });
          }
          yield* Effect.sleep(pollInterval);
        } else {
          const attempt = yield* Ref.getAndUpdate(reconnectAttemptsRef, (count) => count + 1);
          const delayMs = computeReconnectBackoffMs(attempt, baseReconnectMs, maxReconnectMs);
          yield* Effect.sleep(Duration.millis(delayMs));
        }
      }
    }).pipe(Effect.ignoreCause);

    yield* Effect.forkIn(pollFiber, subscriberScope);
    return dequeue;
  });

  return GrokBotTransport.of({
    kind: "cdp-loopback",
    capabilities: GROK_BOT_CDP_CAPABILITIES,
    detectAvailability,
    discoverBots,
    listMessages,
    sendMessage,
    cancelRun,
    subscribe,
  });
});

export const layer = (config?: GrokBotCdpTransportConfig) =>
  Layer.effect(GrokBotTransport, make(config));

export const layerLive = (config?: GrokBotCdpTransportConfig) =>
  layer(config).pipe(Layer.provide([FetchHttpClient.layer, safeWebSocketConstructorLayer]));
