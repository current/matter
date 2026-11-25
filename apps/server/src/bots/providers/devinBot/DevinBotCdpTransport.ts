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

import { safeWebSocketConstructorLayer } from "../grokBot/GrokBotCdpTransport.ts";
import { parseGrokBotInfoPlist } from "../grokBot/grokBotStoreNormalization.ts";
import {
  DEVIN_APP_PATH,
  DEVIN_BOT_DEFAULT_CDP_PORT,
  devinBotLaunchCommand,
} from "./devinBotDeepLinks.ts";
import {
  buildDevinBridgeExpression,
  DEVIN_SESSION_ID,
  isDevinBoardId,
  isDevinCursor,
  isDevinTicketId,
  normalizeDevinChildSessions,
  normalizeDevinInboxTickets,
  normalizeDevinMessagePage,
  normalizeDevinSnapshot,
  sanitizeDevinAvatarDataUrl,
  selectDevinWorkbenchTarget,
  validateDevinLoopbackEndpoint,
  type CdpTargetDescriptor,
  type DevinBridgeOperation,
  type ValidatedDevinEndpoint,
} from "./devinBotStoreNormalization.ts";
import {
  DevinBotAppUnavailableError,
  DevinBotBridgeError,
  DevinBotBridgeReason,
  DevinBotCdpConnectionError,
  DevinBotCdpProtocolError,
  DevinBotTransport,
  type DevinBotAvailability,
  type DevinBotTransportError,
  type DevinBotTransportShape,
} from "./DevinBotTransport.ts";

export interface DevinBotCdpTransportConfig {
  readonly host?: string;
  readonly port?: number;
  readonly appPath?: string;
  readonly connectTimeout?: Duration.Input;
  readonly requestTimeout?: Duration.Input;
}

const DEFAULT_CONNECT_TIMEOUT: Duration.Input = "3 seconds";
// The bridge's own HTTP calls time out at 15s each; a snapshot runs them in parallel.
const DEFAULT_REQUEST_TIMEOUT: Duration.Input = "25 seconds";
const MAX_MESSAGE_LENGTH = 32_000;

const CdpTargetSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  webSocketDebuggerUrl: Schema.optionalKey(Schema.String),
});
const decodeCdpTargetList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(CdpTargetSchema)),
);

const encodeCdpEvaluateRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      method: Schema.Literal("Runtime.evaluate"),
      params: Schema.Struct({
        expression: Schema.String,
        returnByValue: Schema.Boolean,
        awaitPromise: Schema.Boolean,
      }),
    }),
  ),
);

const CdpRpcResponseSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.Number),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeCdpRpcResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CdpRpcResponseSchema),
);
type CdpRpcResponse = typeof CdpRpcResponseSchema.Type;

const isBridgeReason = Schema.is(DevinBotBridgeReason);

interface ActiveCdpConnection {
  readonly wsUrl: string;
  readonly scope: Scope.Closeable;
  readonly write: (chunk: string) => Effect.Effect<void, Socket.SocketError>;
  readonly pending: Map<number, Deferred.Deferred<CdpRpcResponse, DevinBotTransportError>>;
}

function readBridgeEnvelope(
  operation: DevinBridgeOperation,
  response: CdpRpcResponse,
): Effect.Effect<Record<string, unknown>, DevinBotCdpProtocolError | DevinBotBridgeError> {
  const invalid = new DevinBotBridgeError({ operation, reason: "invalid_payload" });
  if (response.error) {
    return Effect.fail(
      new DevinBotCdpProtocolError({
        operation,
        ...(response.error.code !== undefined ? { code: response.error.code } : {}),
      }),
    );
  }
  const evaluation = response.result as Record<string, unknown> | undefined;
  if (typeof evaluation !== "object" || evaluation === null) return Effect.fail(invalid);
  if (evaluation.exceptionDetails !== undefined) {
    return Effect.fail(new DevinBotCdpProtocolError({ operation }));
  }
  const remote = evaluation.result as Record<string, unknown> | undefined;
  const envelope = remote?.value as Record<string, unknown> | undefined;
  if (typeof envelope !== "object" || envelope === null) return Effect.fail(invalid);
  if (envelope.ok !== true) {
    return Effect.fail(
      new DevinBotBridgeError({
        operation,
        reason: isBridgeReason(envelope.reason) ? envelope.reason : "invalid_payload",
        ...(typeof envelope.status === "number" ? { status: envelope.status } : {}),
      }),
    );
  }
  const data = envelope.data as Record<string, unknown> | undefined;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? Effect.succeed(data)
    : Effect.fail(invalid);
}

const make = Effect.fn("DevinBotCdpTransport.make")(function* (
  config?: DevinBotCdpTransportConfig,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const wsConstructor = yield* Socket.WebSocketConstructor;
  const transportScope = yield* Effect.scope;

  const host = config?.host ?? "127.0.0.1";
  const port = config?.port ?? DEVIN_BOT_DEFAULT_CDP_PORT;
  const appPath = config?.appPath ?? DEVIN_APP_PATH;
  const connectTimeout = config?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
  const requestTimeout = config?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;

  const connectionLock = yield* Semaphore.make(1);
  const activeConnectionRef = yield* Ref.make<ActiveCdpConnection | null>(null);
  const nextRequestIdRef = yield* Ref.make(1);

  const requireEndpoint = Effect.suspend(() => {
    const checked = validateDevinLoopbackEndpoint({ host, port });
    return checked.ok ? Effect.succeed(checked.endpoint) : Effect.fail(checked.error);
  });

  /** Reads Info.plist only; never opens or launches the app. */
  const inspectApp = fileSystem.readFileString(`${appPath}/Contents/Info.plist`).pipe(
    Effect.map((xml) => Option.some(parseGrokBotInfoPlist(xml).version)),
    Effect.orElseSucceed(() => Option.none<string | null>()),
  );

  const fetchTargets = Effect.fn("DevinBotCdpTransport.fetchTargets")(function* (
    endpoint: ValidatedDevinEndpoint,
  ) {
    const connectionError = (cause: unknown) =>
      new DevinBotCdpConnectionError({
        stage: "discover_targets",
        endpoint: endpoint.jsonListUrl,
        cause,
      });
    const response = yield* httpClient.execute(HttpClientRequest.get(endpoint.jsonListUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(connectionError),
      Effect.timeoutOrElse({
        duration: connectTimeout,
        orElse: () =>
          Effect.fail(
            new DevinBotCdpConnectionError({
              stage: "timeout",
              endpoint: endpoint.jsonListUrl,
              cause: "CDP target discovery timed out",
            }),
          ),
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* connectionError(`HTTP ${response.status}`);
    }
    const body = yield* response.text.pipe(Effect.mapError(connectionError));
    const targets = yield* decodeCdpTargetList(body).pipe(
      Effect.mapError(
        (cause) => new DevinBotCdpProtocolError({ operation: "discover_targets", cause }),
      ),
    );
    return targets as ReadonlyArray<CdpTargetDescriptor>;
  });

  const failPending = (pending: ActiveCdpConnection["pending"], endpoint: string, cause: unknown) =>
    Effect.forEach(
      [...pending.entries()],
      ([id, deferred]) => {
        pending.delete(id);
        return Deferred.fail(
          deferred,
          new DevinBotCdpConnectionError({ stage: "socket_closed", endpoint, cause }),
        ).pipe(Effect.ignore);
      },
      { discard: true },
    );

  const dropActiveConnection = Effect.fn("DevinBotCdpTransport.dropActiveConnection")(function* (
    reason: string,
  ) {
    const current = yield* Ref.getAndSet(activeConnectionRef, null);
    if (!current) return;
    yield* failPending(current.pending, current.wsUrl, reason);
    yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
  });

  yield* Effect.addFinalizer(() => dropActiveConnection("transport_disposed"));

  const detectAvailability = Effect.gen(function* () {
    const endpoint = yield* requireEndpoint;
    const launchCommand = devinBotLaunchCommand(endpoint.port);
    const app = yield* inspectApp;
    if (Option.isNone(app)) {
      return {
        state: "app_unavailable",
        appVersion: null,
        targetUrl: null,
        launchCommand,
      } satisfies DevinBotAvailability;
    }
    const targets = yield* fetchTargets(endpoint).pipe(Effect.option);
    if (Option.isNone(targets)) {
      return {
        state: "enabled_unconfigured",
        appVersion: app.value,
        targetUrl: null,
        launchCommand,
      } satisfies DevinBotAvailability;
    }
    const selected = selectDevinWorkbenchTarget(targets.value, endpoint.port);
    return {
      state: selected ? "connected" : "incompatible_version",
      appVersion: app.value,
      targetUrl: selected?.target.url ?? null,
      launchCommand,
    } satisfies DevinBotAvailability;
  }).pipe(Effect.withSpan("DevinBotCdpTransport.detectAvailability"));

  const ensureConnected = Effect.gen(function* () {
    const endpoint = yield* requireEndpoint;
    return yield* connectionLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* Ref.get(activeConnectionRef);
        if (existing) return existing;

        if (Option.isNone(yield* inspectApp)) {
          return yield* new DevinBotAppUnavailableError({ state: "app_unavailable", port });
        }
        const targets = yield* fetchTargets(endpoint).pipe(
          Effect.catchTags({
            DevinBotCdpConnectionError: () =>
              Effect.fail(new DevinBotAppUnavailableError({ state: "enabled_unconfigured", port })),
          }),
        );
        const selected = selectDevinWorkbenchTarget(targets, endpoint.port);
        if (!selected) {
          return yield* new DevinBotAppUnavailableError({ state: "incompatible_version", port });
        }

        const wsUrl = selected.webSocketDebuggerUrl;
        const connScope = yield* Scope.fork(transportScope);
        const pending: ActiveCdpConnection["pending"] = new Map();
        const opened = yield* Socket.makeWebSocket(wsUrl, { openTimeout: connectTimeout }).pipe(
          Effect.provideService(Socket.WebSocketConstructor, wsConstructor),
          Effect.flatMap((socket) => Effect.all({ reader: socket.reader, writer: socket.writer })),
          Scope.provide(connScope),
          Effect.result,
        );
        if (opened._tag === "Failure") {
          yield* Scope.close(connScope, Exit.void).pipe(Effect.ignore);
          return yield* new DevinBotCdpConnectionError({
            stage: "connect_socket",
            endpoint: wsUrl,
            cause: opened.failure,
          });
        }

        const { reader, writer } = opened.success;
        const connection: ActiveCdpConnection = {
          wsUrl,
          scope: connScope,
          write: (chunk) => writer.write(chunk),
          pending,
        };
        yield* Ref.set(activeConnectionRef, connection);

        const decoder = new TextDecoder();
        const pump = Effect.gen(function* () {
          while (true) {
            for (const frame of yield* reader.pull) {
              const text = typeof frame === "string" ? frame : decoder.decode(frame);
              const parsed = yield* decodeCdpRpcResponse(text).pipe(Effect.option);
              if (Option.isNone(parsed) || parsed.value.id === undefined) continue;
              const deferred = pending.get(parsed.value.id);
              if (!deferred) continue;
              pending.delete(parsed.value.id);
              yield* Deferred.succeed(deferred, parsed.value);
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if ((yield* Ref.get(activeConnectionRef)) === connection) {
                yield* Ref.set(activeConnectionRef, null);
              }
              yield* failPending(pending, wsUrl, "cdp_socket_closed");
            }),
          ),
          Effect.ignoreCause,
        );
        yield* Effect.forkIn(pump, connScope);
        return connection;
      }),
    );
  });

  const evaluate = Effect.fn("DevinBotCdpTransport.evaluate")(function* (
    operation: DevinBridgeOperation,
    args: Readonly<Record<string, string | null>> = {},
  ) {
    const connection = yield* ensureConnected;
    const id = yield* Ref.getAndUpdate(nextRequestIdRef, (current) => current + 1);
    const deferred = yield* Deferred.make<CdpRpcResponse, DevinBotTransportError>();
    connection.pending.set(id, deferred);
    const payload = yield* encodeCdpEvaluateRequest({
      id,
      method: "Runtime.evaluate",
      params: {
        expression: buildDevinBridgeExpression(operation, args),
        returnByValue: true,
        awaitPromise: true,
      },
    }).pipe(Effect.mapError((cause) => new DevinBotCdpProtocolError({ operation, cause })));
    const written = yield* connection.write(payload).pipe(Effect.result);
    if (written._tag === "Failure") {
      connection.pending.delete(id);
      yield* dropActiveConnection("cdp_write_failed");
      return yield* new DevinBotCdpConnectionError({
        stage: "socket_closed",
        endpoint: connection.wsUrl,
        cause: written.failure,
      });
    }
    const response = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(requestTimeout));
    if (Option.isNone(response)) {
      connection.pending.delete(id);
      yield* dropActiveConnection("cdp_request_timeout");
      return yield* new DevinBotCdpConnectionError({
        stage: "timeout",
        endpoint: connection.wsUrl,
        cause: `CDP request timed out during ${operation}`,
      });
    }
    return yield* readBridgeEnvelope(operation, response.value);
  });

  const invalidArgs = (operation: DevinBridgeOperation) =>
    Effect.fail(new DevinBotBridgeError({ operation, reason: "invalid_args" }));
  const isSessionId = (value: string) => DEVIN_SESSION_ID.test(value);

  const snapshot = evaluate("snapshot").pipe(
    Effect.flatMap((data) => {
      const normalized = normalizeDevinSnapshot(data);
      return normalized
        ? Effect.succeed(normalized)
        : Effect.fail(
            new DevinBotBridgeError({ operation: "snapshot", reason: "invalid_payload" }),
          );
    }),
  );

  const avatar = Effect.fn("DevinBotCdpTransport.avatar")(function* (url: string) {
    const data = yield* evaluate("avatar", { url });
    return sanitizeDevinAvatarDataUrl(data.dataUrl);
  });

  const childSessions = Effect.fn("DevinBotCdpTransport.childSessions")(function* (
    devinId: string,
  ) {
    if (!isSessionId(devinId)) return yield* invalidArgs("children");
    return normalizeDevinChildSessions(yield* evaluate("children", { devinId }));
  });

  const messages = Effect.fn("DevinBotCdpTransport.messages")(function* (
    devinId: string,
    after: string | null,
  ) {
    if (!isSessionId(devinId) || (after !== null && !isDevinCursor(after))) {
      return yield* invalidArgs("messages");
    }
    return normalizeDevinMessagePage(yield* evaluate("messages", { devinId, after }));
  });

  const inbox = Effect.fn("DevinBotCdpTransport.inbox")(function* (boardId: string) {
    if (!isDevinBoardId(boardId)) return yield* invalidArgs("inbox");
    return normalizeDevinInboxTickets(boardId, yield* evaluate("inbox", { boardId }));
  });

  const sendMessage = Effect.fn("DevinBotCdpTransport.sendMessage")(function* (
    devinId: string,
    text: string,
  ) {
    if (!isSessionId(devinId) || text.trim().length === 0 || text.length > MAX_MESSAGE_LENGTH) {
      return yield* invalidArgs("send");
    }
    yield* evaluate("send", { devinId, text });
  });

  const sleep = Effect.fn("DevinBotCdpTransport.sleep")(function* (devinId: string) {
    if (!isSessionId(devinId)) return yield* invalidArgs("sleep");
    yield* evaluate("sleep", { devinId });
  });

  const resolveInboxTicket = Effect.fn("DevinBotCdpTransport.resolveInboxTicket")(function* (
    input: Parameters<DevinBotTransportShape["resolveInboxTicket"]>[0],
  ) {
    if (!isDevinBoardId(input.boardId) || !isDevinTicketId(input.ticketId)) {
      return yield* invalidArgs("resolve");
    }
    yield* evaluate("resolve", { ...input });
  });

  return DevinBotTransport.of({
    detectAvailability,
    snapshot,
    avatar,
    childSessions,
    messages,
    inbox,
    sendMessage,
    sleep,
    resolveInboxTicket,
  });
});

const layer = (config?: DevinBotCdpTransportConfig) =>
  Layer.effect(DevinBotTransport, make(config));

export const layerLive = (config?: DevinBotCdpTransportConfig) =>
  layer(config).pipe(Layer.provide([FetchHttpClient.layer, safeWebSocketConstructorLayer]));
