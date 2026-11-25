import {
  AuthOrchestrationOperateScope,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import type {
  VoiceAssistantTurnRequest,
  VoiceBriefingRequest,
  VoiceCredentialsStatus,
  VoiceServerTtsPreferences,
  VoiceSpeakRequest,
  VoiceTranscribeResponse,
} from "../../../../antimatter/voice-assistant/types.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as VoiceAssistantService from "./VoiceAssistantService.ts";
import { makeVoiceAssistantFluxRoute } from "./voiceAssistantFluxWs.ts";
import { encodeVoiceTurnStream, makeVoiceTurnStream } from "./voiceTurnStream.ts";
import * as VoiceTtsService from "./VoiceTtsService.ts";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const VoiceProjectSummarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  archived: Schema.optionalKey(Schema.Boolean),
});

const VoiceThreadSummarySchema = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "approval", "input", "done", "failed", "limited", "idle"]),
  updatedAt: Schema.String,
  latestUserMessage: Schema.NullOr(Schema.String),
  latestAssistantMessage: Schema.NullOr(Schema.String),
  isActive: Schema.optionalKey(Schema.Boolean),
});

const VoiceApprovalSummarySchema = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
  requestId: Schema.String,
  requestKind: Schema.String,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});

const VoiceQuestionSummarySchema = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
  requestId: Schema.String,
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(Schema.String),
    }),
  ),
});

const VoiceTurnRequestSchema = Schema.Struct({
  utterance: Schema.String,
  mode: Schema.Literals(["smart", "assistant", "dictation", "voice-mode"]),
  history: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      toolSummary: Schema.optional(Schema.String),
    }),
  ),
  context: Schema.Struct({
    activeEnvironmentId: Schema.NullOr(Schema.String),
    activeThreadId: Schema.NullOr(Schema.String),
    activeRoute: Schema.NullOr(Schema.String),
    mainWindowFocused: Schema.Boolean,
    composerFocused: Schema.Boolean,
    projects: Schema.Array(VoiceProjectSummarySchema),
    threads: Schema.Array(VoiceThreadSummarySchema),
    pendingApprovals: Schema.Array(VoiceApprovalSummarySchema),
    pendingQuestions: Schema.Array(VoiceQuestionSummarySchema),
  }),
});

const VoiceSpeakOptionsSchema = Schema.Struct({
  provider: Schema.optional(
    Schema.Literals(["auto", "elevenlabs", "deepgram", "openai", "macos", "browser", "off"]),
  ),
  voice: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  speed: Schema.optional(Schema.Number),
});

/** `/turn` plus how to speak it; `speak: null` streams text only. */
const VoiceTurnStreamRequestSchema = Schema.Struct({
  ...VoiceTurnRequestSchema.fields,
  speak: Schema.optional(Schema.NullOr(VoiceSpeakOptionsSchema)),
});

const VoiceBriefingRequestSchema = Schema.Struct({
  kind: Schema.Literals(["approval", "question", "completed", "failed", "limited"]),
  threadTitle: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  latestAssistantMessage: Schema.NullOr(Schema.String),
  questionPrompts: Schema.optional(Schema.Array(Schema.String)),
  count: Schema.optional(Schema.Number),
  extraTitles: Schema.optional(Schema.Array(Schema.String)),
});

const VoiceSpeakRequestSchema = Schema.Struct({
  text: Schema.String,
  provider: Schema.optional(
    Schema.Literals(["auto", "elevenlabs", "deepgram", "openai", "macos", "browser", "off"]),
  ),
  voice: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  speed: Schema.optional(Schema.Number),
});

const VoiceCredentialsRequestSchema = Schema.Struct({
  deepgramApiKey: Schema.optional(Schema.String),
  elevenlabsApiKey: Schema.optional(Schema.String),
});

const VoiceConfigRequestSchema = Schema.Struct({
  ttsProvider: Schema.optional(Schema.String),
  elevenlabsModel: Schema.optional(Schema.String),
  elevenlabsVoice: Schema.optional(Schema.String),
  deepgramVoice: Schema.optional(Schema.String),
});

const decodeTurnRequest = Schema.decodeUnknownEffect(VoiceTurnRequestSchema);
const decodeTurnStreamRequest = Schema.decodeUnknownEffect(VoiceTurnStreamRequestSchema);
const decodeBriefingRequest = Schema.decodeUnknownEffect(VoiceBriefingRequestSchema);
const decodeSpeakRequest = Schema.decodeUnknownEffect(VoiceSpeakRequestSchema);
const decodeCredentialsRequest = Schema.decodeUnknownEffect(VoiceCredentialsRequestSchema);
const decodeConfigRequest = Schema.decodeUnknownEffect(VoiceConfigRequestSchema);

const authenticateOperate = Effect.fnUntraced(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

const catchAuthErrors = <A, R>(
  effect: Effect.Effect<
    A,
    EnvironmentAuthInvalidError | EnvironmentInternalError | EnvironmentScopeRequiredError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  );

export const layerVoiceAssistantRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const assistant = yield* VoiceAssistantService.VoiceAssistantService;
    const tts = yield* VoiceTtsService.VoiceTtsService;

    const turnRoute = HttpRouter.add(
      "POST",
      "/api/mattr/voice-assistant/turn",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const raw = yield* request.json.pipe(Effect.option);
        if (raw._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_json" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const decoded = yield* decodeTurnRequest(raw.value).pipe(Effect.option);
        if (decoded._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_request" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const result = yield* assistant.handleTurn(
          decoded.value satisfies VoiceAssistantTurnRequest,
        );
        return HttpServerResponse.jsonUnsafe(result, { headers: NO_STORE_HEADERS });
      }).pipe(catchAuthErrors),
    );

    const turnStreamRoute = HttpRouter.add(
      "POST",
      "/api/mattr/voice-assistant/turn-stream",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const raw = yield* request.json.pipe(Effect.option);
        if (raw._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_json" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const decoded = yield* decodeTurnStreamRequest(raw.value).pipe(Effect.option);
        if (decoded._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_request" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const { speak, ...turn } = decoded.value;
        const speakOptions =
          speak === null || speak?.provider === "off" || speak?.provider === "browser"
            ? null
            : (speak ?? {});
        return HttpServerResponse.stream(
          encodeVoiceTurnStream(
            makeVoiceTurnStream({
              request: turn satisfies VoiceAssistantTurnRequest,
              assistant,
              tts,
              speak: speakOptions,
            }),
          ),
          { contentType: "application/x-ndjson", headers: NO_STORE_HEADERS },
        );
      }).pipe(catchAuthErrors),
    );

    const briefingRoute = HttpRouter.add(
      "POST",
      "/api/mattr/voice-assistant/briefing",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const raw = yield* request.json.pipe(Effect.option);
        if (raw._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_json" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const decoded = yield* decodeBriefingRequest(raw.value).pipe(Effect.option);
        if (decoded._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_request" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const result = yield* assistant.generateBriefing(
          decoded.value satisfies VoiceBriefingRequest,
        );
        return HttpServerResponse.jsonUnsafe(result, { headers: NO_STORE_HEADERS });
      }).pipe(catchAuthErrors),
    );

    const speakRoute = HttpRouter.add(
      "POST",
      "/api/mattr/voice-assistant/speak",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const raw = yield* request.json.pipe(Effect.option);
        if (raw._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_json" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const decoded = yield* decodeSpeakRequest(raw.value).pipe(Effect.option);
        if (decoded._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_request" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        return yield* tts.speak(decoded.value satisfies VoiceSpeakRequest).pipe(
          Effect.map((audio) =>
            HttpServerResponse.uint8Array(audio.bytes, {
              contentType: audio.contentType,
              headers: NO_STORE_HEADERS,
            }),
          ),
          Effect.catchTags({
            VoiceTtsUnavailableError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    error: error.reason === "empty-text" ? "empty_text" : "tts_unavailable",
                    reason: error.reason,
                    fallback: error.reason === "empty-text" ? "none" : "browser",
                  },
                  { status: error.reason === "empty-text" ? 400 : 501, headers: NO_STORE_HEADERS },
                ),
              ),
            VoiceTtsSynthesisError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    error: "tts_synthesis_failed",
                    provider: error.provider,
                    fallback: "browser",
                  },
                  { status: 502, headers: NO_STORE_HEADERS },
                ),
              ),
          }),
        );
      }).pipe(catchAuthErrors),
    );

    const ttsInfoRoute = HttpRouter.add(
      "GET",
      "/api/mattr/voice-assistant/tts-info",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const info = yield* tts.getAvailableTtsInfo;
        return HttpServerResponse.jsonUnsafe(info, { headers: NO_STORE_HEADERS });
      }).pipe(catchAuthErrors),
    );

    const transcribeRoute = HttpRouter.add(
      "POST",
      "/api/mattr/voice-assistant/transcribe",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const buf = yield* request.arrayBuffer.pipe(Effect.option);
        if (buf._tag === "None" || buf.value.byteLength === 0) {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_audio" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const queryIndex = request.url.indexOf("?");
        const langQuery =
          queryIndex === -1
            ? undefined
            : (new URLSearchParams(request.url.slice(queryIndex + 1)).get("language") ?? undefined);
        return yield* tts.transcribeDeepgram(new Uint8Array(buf.value), langQuery).pipe(
          Effect.map((result) =>
            HttpServerResponse.jsonUnsafe(result satisfies VoiceTranscribeResponse, {
              headers: NO_STORE_HEADERS,
            }),
          ),
          Effect.catchTags({
            VoiceTtsUnavailableError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    error: error.reason === "empty-text" ? "invalid_audio" : "stt_unavailable",
                    fallback: "client",
                  },
                  {
                    status: error.reason === "empty-text" ? 400 : 501,
                    headers: NO_STORE_HEADERS,
                  },
                ),
              ),
            VoiceTtsSynthesisError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    error: "stt_failed",
                    provider: error.provider,
                    fallback: "client",
                  },
                  { status: 502, headers: NO_STORE_HEADERS },
                ),
              ),
          }),
        );
      }).pipe(catchAuthErrors),
    );

    const credentialsRoute = HttpRouter.add(
      "POST",
      "/api/mattr/voice-assistant/credentials",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const raw = yield* request.json.pipe(Effect.option);
        if (raw._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_json" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const decoded = yield* decodeCredentialsRequest(raw.value).pipe(Effect.option);
        if (decoded._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_request" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const status: VoiceCredentialsStatus = yield* tts.saveCredentials(decoded.value);
        return HttpServerResponse.jsonUnsafe(status, { headers: NO_STORE_HEADERS });
      }).pipe(catchAuthErrors),
    );

    const credentialsStatusRoute = HttpRouter.add(
      "GET",
      "/api/mattr/voice-assistant/credentials",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const status: VoiceCredentialsStatus = yield* tts.getCredentialsStatus;
        return HttpServerResponse.jsonUnsafe(status, { headers: NO_STORE_HEADERS });
      }).pipe(catchAuthErrors),
    );

    const configGetRoute = HttpRouter.add(
      "GET",
      "/api/mattr/voice-assistant/config",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const preferences: VoiceServerTtsPreferences = yield* tts.getTtsPreferences;
        return HttpServerResponse.jsonUnsafe(preferences, { headers: NO_STORE_HEADERS });
      }).pipe(catchAuthErrors),
    );

    const configSaveRoute = HttpRouter.add(
      "POST",
      "/api/mattr/voice-assistant/config",
      Effect.gen(function* () {
        yield* authenticateOperate();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const raw = yield* request.json.pipe(Effect.option);
        if (raw._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_json" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const decoded = yield* decodeConfigRequest(raw.value).pipe(Effect.option);
        if (decoded._tag === "None") {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_request" },
            { status: 400, headers: NO_STORE_HEADERS },
          );
        }
        const preferences: VoiceServerTtsPreferences = yield* tts.saveTtsPreferences(decoded.value);
        return HttpServerResponse.jsonUnsafe(preferences, { headers: NO_STORE_HEADERS });
      }).pipe(catchAuthErrors),
    );

    return Layer.mergeAll(
      turnRoute,
      turnStreamRoute,
      briefingRoute,
      speakRoute,
      ttsInfoRoute,
      transcribeRoute,
      credentialsRoute,
      credentialsStatusRoute,
      configGetRoute,
      configSaveRoute,
      makeVoiceAssistantFluxRoute(tts),
    );
  }),
);
