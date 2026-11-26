import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  buildRespondToWidgetExpression,
  buildSendMessageExpression,
  GROK_BOT_SEND_SETTLE_MS,
  normalizeGrokBotOpenWidget,
  normalizeGrokBotSummary,
  normalizeGrokBotTranscript,
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
  type GrokBotBridgeOperation,
  type GrokBotCancelResult,
  type GrokBotMessagePage,
  type GrokBotOpenWidget,
  type GrokBotRoster,
  type GrokBotSendResult,
  type GrokBotSummary,
  type GrokBotTransportError,
} from "./GrokBotTransport.ts";

export interface GrokBotCdpTransportConfig {
  readonly host?: string;
  readonly port?: number;
  readonly appPath?: string;
  readonly connectTimeout?: Duration.Input;
  /** How long a read waits for the renderer; sends and stops wait on Grok Bot itself too. */
  readonly requestTimeout?: Duration.Input;
}

const DEFAULT_CONNECT_TIMEOUT: Duration.Input = "3 seconds";
const DEFAULT_REQUEST_TIMEOUT: Duration.Input = "8 seconds";
/** The renderer settles a send within GROK_BOT_SEND_SETTLE_MS; this leaves room for the socket. */
const ACTION_REQUEST_TIMEOUT: Duration.Input = Duration.millis(GROK_BOT_SEND_SETTLE_MS + 5_000);

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
  operation: GrokBotBridgeOperation,
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
    const code =
      typeof envelope.code === "string" && envelope.code.length > 0
        ? envelope.code.slice(0, 120)
        : undefined;
    return {
      ok: false,
      error: new GrokBotStoreBridgeError({
        operation,
        ...(botId ? { botId } : {}),
        reason,
        ...(code ? { code } : {}),
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

  const connectionLock = yield* Semaphore.make(1);
  const activeConnectionRef = yield* Ref.make<ActiveCdpConnection | null>(null);
  const nextRequestIdRef = yield* Ref.make(1);

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
  });

  yield* Effect.addFinalizer(() => dropActiveConnection("transport_disposed"));

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
              if (current === connection) yield* Ref.set(activeConnectionRef, null);
              yield* failPendingRequests(pending, wsUrl, "cdp_socket_closed");
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
    operation: GrokBotBridgeOperation,
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

    const isAction = operation !== "discover_bots" && operation !== "list_messages";
    const rpcResponseOption = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(isAction ? ACTION_REQUEST_TIMEOUT : requestTimeout),
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
    const bots: GrokBotSummary[] = [];
    for (const entry of Array.isArray(data.bots) ? data.bots : []) {
      const bot = normalizeGrokBotSummary(entry);
      if (bot) bots.push(bot);
    }
    const openWidgets: GrokBotOpenWidget[] = [];
    for (const entry of Array.isArray(data.widgets) ? data.widgets : []) {
      const widget = normalizeGrokBotOpenWidget(entry);
      if (widget) openWidgets.push(widget);
    }
    return { bots, openWidgets } satisfies GrokBotRoster;
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
    const messages = normalizeGrokBotTranscript(
      botId,
      Array.isArray(data.messages) ? data.messages : [],
    );
    const nextCursor = typeof data.nextCursor === "string" ? data.nextCursor : null;
    return {
      botId,
      messages,
      nextCursor,
      hasMore: data.hasMore === true && nextCursor !== null,
    } satisfies GrokBotMessagePage;
  });

  const sendMessage = Effect.fn("GrokBotCdpTransport.sendMessage")(function* (
    botId: string,
    text: string,
  ) {
    const data = yield* evaluateInRenderer(
      "send_message",
      buildSendMessageExpression(botId, text),
      botId,
    );
    return {
      botId,
      grokNonce: typeof data.nonce === "string" ? data.nonce : null,
      state: data.state === "delivered" ? "delivered" : "queued",
    } satisfies GrokBotSendResult;
  });

  const cancelRun = Effect.fn("GrokBotCdpTransport.cancelRun")(function* (botId: string) {
    const data = yield* evaluateInRenderer("cancel_run", buildCancelRunExpression(botId), botId);
    return {
      botId,
      cancelled: data.cancelled === true,
      fallbackDeepLinkUrl: buildGrokBotPromptDeepLink({ botId }),
    } satisfies GrokBotCancelResult;
  });

  const respondToWidget = Effect.fn("GrokBotCdpTransport.respondToWidget")(function* (
    botId: string,
    entryId: string,
    value: string,
  ) {
    yield* evaluateInRenderer(
      "respond_widget",
      buildRespondToWidgetExpression(botId, entryId, value),
      botId,
    );
  });

  return GrokBotTransport.of({
    kind: "cdp-loopback",
    capabilities: GROK_BOT_CDP_CAPABILITIES,
    detectAvailability,
    discoverBots,
    listMessages,
    sendMessage,
    cancelRun,
    respondToWidget,
  });
});

export const layer = (config?: GrokBotCdpTransportConfig) =>
  Layer.effect(GrokBotTransport, make(config));

export const layerLive = (config?: GrokBotCdpTransportConfig) =>
  layer(config).pipe(Layer.provide([FetchHttpClient.layer, safeWebSocketConstructorLayer]));
