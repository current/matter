import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { authenticateMediaRequest, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import type * as VoiceTtsService from "./VoiceTtsService.ts";

export const VOICE_ASSISTANT_FLUX_WS_PATH = "/api/mattr/voice-assistant/flux";
const DEEPGRAM_FLUX_WS_URL =
  "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.72";
export const FLUX_NOT_CONFIGURED_CLOSE_CODE = 4401;
const FLUX_UPSTREAM_ERROR_CLOSE_CODE = 4502;

const FLUX_CONNECT_TIMEOUT: Duration.Input = "10 seconds";
const FLUX_IDLE_TIMEOUT: Duration.Input = "120 seconds";
const FLUX_MAX_SESSION_DURATION: Duration.Input = "30 minutes";
const FLUX_MAX_CHUNK_BYTES = 262_144;
const FLUX_MAX_CONTROL_BYTES = 256;

export type DeepgramFluxTurnEventKind =
  | "StartOfTurn"
  | "Update"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn";

export type DeepgramFluxEvent =
  | {
      readonly type: "Connected";
      readonly request_id?: string;
    }
  | {
      readonly type: "TurnInfo";
      readonly event: DeepgramFluxTurnEventKind;
      readonly transcript: string;
      readonly turn_index?: number;
      readonly end_of_turn_confidence?: number;
    }
  | {
      readonly type: "Error";
      readonly description?: string;
    };

const DeepgramFluxEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("Connected"),
    request_id: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("TurnInfo"),
    event: Schema.Literals(["StartOfTurn", "Update", "EagerEndOfTurn", "TurnResumed", "EndOfTurn"]),
    transcript: Schema.String,
    turn_index: Schema.optionalKey(Schema.Number),
    end_of_turn_confidence: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("Error"),
    description: Schema.optionalKey(Schema.String),
  }),
]);

const encodeDeepgramFluxEvent = Schema.encodeSync(Schema.fromJsonString(DeepgramFluxEventSchema));

const VALID_TURN_EVENTS: ReadonlySet<string> = new Set<DeepgramFluxTurnEventKind>([
  "StartOfTurn",
  "Update",
  "EagerEndOfTurn",
  "TurnResumed",
  "EndOfTurn",
]);

function isTurnEventKind(value: unknown): value is DeepgramFluxTurnEventKind {
  return typeof value === "string" && VALID_TURN_EVENTS.has(value);
}

export function parseDeepgramFluxEvent(raw: string): DeepgramFluxEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;

  if (type === "Connected") {
    return {
      type: "Connected",
      ...(typeof obj.request_id === "string" ? { request_id: obj.request_id } : {}),
    };
  }

  if (type === "TurnInfo" && isTurnEventKind(obj.event)) {
    return {
      type: "TurnInfo",
      event: obj.event,
      transcript: typeof obj.transcript === "string" ? obj.transcript : "",
      ...(typeof obj.turn_index === "number" && Number.isFinite(obj.turn_index)
        ? { turn_index: obj.turn_index }
        : {}),
      ...(typeof obj.end_of_turn_confidence === "number" &&
      Number.isFinite(obj.end_of_turn_confidence)
        ? { end_of_turn_confidence: obj.end_of_turn_confidence }
        : {}),
    };
  }

  if (type === "Error" || type === "FatalError") {
    const description =
      typeof obj.description === "string"
        ? obj.description
        : typeof obj.message === "string"
          ? obj.message
          : undefined;
    return {
      type: "Error",
      ...(description !== undefined ? { description } : {}),
    };
  }

  return null;
}

function isAllowedClientControlMessage(raw: string): boolean {
  if (raw.length === 0 || raw.length > FLUX_MAX_CONTROL_BYTES) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      (parsed as { readonly type?: unknown }).type === "CloseStream"
    );
  } catch {
    return false;
  }
}

// Effect drops its listeners before closing a socket that is still connecting, and `ws` then
// emits an `error` nobody handles, which exits the server.
const upstreamWebSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

const runVoiceAssistantFluxProxy = Effect.fn("voiceAssistant.runFluxProxy")(function* (
  client: Socket.Socket,
  upstream: Socket.Socket,
  options?: {
    readonly idleTimeout?: Duration.Input;
    readonly maxDuration?: Duration.Input;
  },
) {
  const idleTimeout = options?.idleTimeout ?? FLUX_IDLE_TIMEOUT;
  const maxDuration = options?.maxDuration ?? FLUX_MAX_SESSION_DURATION;

  yield* Effect.scoped(
    Effect.gen(function* () {
      const clientReader = yield* client.reader;
      const writeToClient = yield* client.writer;
      const upstreamReaderResult = yield* upstream.reader.pipe(Effect.result);
      if (upstreamReaderResult._tag === "Failure") {
        yield* Effect.logWarning("Deepgram Flux upstream connection failed.", {
          cause: upstreamReaderResult.failure,
        });
        yield* writeToClient
          .write(new Socket.CloseEvent(FLUX_UPSTREAM_ERROR_CLOSE_CODE, "deepgram_flux_unavailable"))
          .pipe(Effect.ignore);
        return;
      }
      const upstreamReader = upstreamReaderResult.success;
      const writeToUpstream = yield* upstream.writer;
      const activity = yield* Queue.sliding<void>(1);

      const pumpClientToUpstream = Effect.gen(function* () {
        while (true) {
          const frames = yield* clientReader.pull;
          yield* Queue.offer(activity, undefined);
          for (const frame of frames) {
            if (frame instanceof Uint8Array) {
              if (frame.byteLength > 0 && frame.byteLength <= FLUX_MAX_CHUNK_BYTES) {
                yield* writeToUpstream.write(frame);
              }
            } else if (typeof frame === "string" && isAllowedClientControlMessage(frame)) {
              yield* writeToUpstream.write(frame);
            }
          }
        }
      });

      const pumpUpstreamToClient = Effect.gen(function* () {
        const decoder = new TextDecoder();
        while (true) {
          const frames = yield* upstreamReader.pull;
          yield* Queue.offer(activity, undefined);
          for (const frame of frames) {
            const text = typeof frame === "string" ? frame : decoder.decode(frame);
            const event = parseDeepgramFluxEvent(text);
            if (event) {
              yield* writeToClient.write(encodeDeepgramFluxEvent(event));
            }
          }
        }
      }).pipe(
        Effect.onError(() =>
          writeToClient
            .write(new Socket.CloseEvent(FLUX_UPSTREAM_ERROR_CLOSE_CODE, "deepgram_flux_closed"))
            .pipe(Effect.ignore),
        ),
      );

      const idleWatchdog = Effect.gen(function* () {
        while (true) {
          const heard = yield* Queue.take(activity).pipe(Effect.timeoutOption(idleTimeout));
          if (Option.isNone(heard)) {
            yield* writeToClient
              .write(new Socket.CloseEvent(1000, "flux_idle_timeout"))
              .pipe(Effect.ignore);
            return;
          }
        }
      });

      yield* Effect.raceFirst(
        Effect.raceFirst(pumpUpstreamToClient, pumpClientToUpstream),
        idleWatchdog,
      ).pipe(
        Effect.timeoutOrElse({
          duration: maxDuration,
          orElse: () =>
            writeToClient
              .write(new Socket.CloseEvent(1000, "flux_session_limit"))
              .pipe(Effect.ignore),
        }),
      );
    }),
  ).pipe(Effect.ignoreCause);
});

export function makeVoiceAssistantFluxRoute(
  tts: Pick<VoiceTtsService.VoiceTtsService["Service"], "resolveDeepgramApiKey">,
  options?: {
    readonly upstreamUrl?: string;
    readonly connectTimeout?: Duration.Input;
    readonly idleTimeout?: Duration.Input;
    readonly maxDuration?: Duration.Input;
  },
) {
  const upstreamUrl = options?.upstreamUrl ?? DEEPGRAM_FLUX_WS_URL;
  const connectTimeout = options?.connectTimeout ?? FLUX_CONNECT_TIMEOUT;

  return HttpRouter.add(
    "GET",
    VOICE_ASSISTANT_FLUX_WS_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.upgrade?.toLowerCase() !== "websocket") {
        return HttpServerResponse.text("Upgrade Required", { status: 426 });
      }

      const session = yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
      const sessions = yield* SessionStore.SessionStore;
      const invalidated = sessions
        .awaitInvalidation(session.sessionId, session.proofKeyThumbprint)
        .pipe(
          Effect.catchTags({
            SessionCredentialVerificationError: (error) =>
              failEnvironmentInternal("internal_error", error).pipe(Effect.ignore),
          }),
        );

      const apiKey = yield* tts.resolveDeepgramApiKey();
      const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
      const client = yield* request.upgrade;

      if (!apiKey) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* client.reader;
            const writeToClient = yield* client.writer;
            yield* writeToClient.write(
              new Socket.CloseEvent(FLUX_NOT_CONFIGURED_CLOSE_CODE, "deepgram_not_configured"),
            );
          }),
        ).pipe(Effect.ignoreCause);
        return HttpServerResponse.empty();
      }

      const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
        openTimeout: connectTimeout,
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      }).pipe(Effect.provide(upstreamWebSocketConstructor));

      yield* Effect.raceFirst(
        runVoiceAssistantFluxProxy(client, upstream, {
          ...(options?.idleTimeout !== undefined ? { idleTimeout: options.idleTimeout } : {}),
          ...(options?.maxDuration !== undefined ? { maxDuration: options.maxDuration } : {}),
        }),
        invalidated,
      ).pipe(
        Effect.onInterrupt(() => Effect.sync(() => transport.destroy())),
        Effect.ignoreCause,
      );

      return HttpServerResponse.empty();
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );
}
