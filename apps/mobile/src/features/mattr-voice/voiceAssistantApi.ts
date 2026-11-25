import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { executeMattrEnvironmentRequest } from "@t3tools/client-runtime/mattr-voice-http";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fetch as expoFetch } from "expo/fetch";

import type {
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceAvailableTtsInfo,
  VoiceSpeakRequest,
  VoiceTranscribeResponse,
} from "../../../../../antimatter/voice-assistant/types";
import { runSpeech } from "../voice-input/voiceDestination";

const BASE_PATH = "/api/mattr/voice-assistant";
const FLUX_WS_PATH = `${BASE_PATH}/flux`;
const MEDIA_TICKET_PATH = "/api/auth/websocket-ticket/media";

const TURN_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const SPEAK_TIMEOUT_MS = 60_000;
const INFO_TIMEOUT_MS = 15_000;

export class VoiceAssistantApiError extends Schema.TaggedError<VoiceAssistantApiError>()(
  "VoiceAssistantApiError",
  {
    status: Schema.Number,
    code: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
) {
  /** The server has no provider for this feature (for example no Deepgram key). */
  get unavailable() {
    return this.status === 501;
  }
}

export const isVoiceAssistantApiError = Schema.is(VoiceAssistantApiError);

class VoiceRequestFailure extends Schema.TaggedError<VoiceRequestFailure>()("VoiceRequestFailure", {
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface SpokenAudio {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

async function failureOf(response: Response): Promise<VoiceAssistantApiError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = (body as { readonly error: unknown }).error;
      if (typeof error === "string") code = error;
    }
  } catch {}
  return new VoiceAssistantApiError({
    status: response.status,
    code,
    message: code ?? `Voice assistant request failed (${response.status}).`,
  });
}

/**
 * The voice routes are fork-only HTTP routes with their own JSON, so they go through the shared
 * authorized request path (Bearer, cookie, DPoP) with a plain fetch for the body.
 */
export function createVoiceAssistantApi(prepared: PreparedConnection) {
  const send = <T>(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly contentType?: string;
    readonly body?: BodyInit | undefined;
    readonly read: (response: Response, url: string) => Promise<T>;
  }): Promise<T> => {
    let requestUrl = "";
    // Typed HTTP failures travel as values so callers see the original error, not a fiber wrapper.
    return runSpeech(
      executeMattrEnvironmentRequest<Response, VoiceRequestFailure>({
        prepared,
        method: input.method,
        path: input.path,
        timeoutMs: input.timeoutMs,
        isUnauthorizedResponse: (response: Response) => response.status === 401,
        send: ({ url, headers }) =>
          Effect.tryPromise({
            try: (abort) => {
              requestUrl = url;
              return expoFetch(url, {
                method: input.method,
                redirect: "error",
                // Cookie-authenticated environments carry their session in the cookie jar.
                ...(prepared.httpAuthorization === null ? { credentials: "include" as const } : {}),
                headers: {
                  ...(headers.authorization ? { authorization: headers.authorization } : {}),
                  ...(headers.dpop ? { dpop: headers.dpop } : {}),
                  ...(input.contentType ? { "content-type": input.contentType } : {}),
                  accept: "application/json, audio/*",
                },
                signal: abort,
                ...(input.body === undefined ? {} : { body: input.body }),
              }) as unknown as Promise<Response>;
            },
            catch: (cause) => new VoiceRequestFailure({ cause }),
          }),
      }).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: async () =>
              response.ok
                ? { value: await input.read(response, requestUrl) }
                : { failure: await failureOf(response) },
            catch: (cause) => new VoiceRequestFailure({ cause }),
          }),
        ),
      ),
      input.signal,
    ).then((result) => {
      if ("failure" in result) throw result.failure;
      return result.value;
    });
  };

  const json = <T>(response: Response) => response.json() as Promise<T>;

  return {
    /**
     * The Deepgram Flux streaming socket, authorized by a one-use media ticket because a
     * WebSocket cannot carry the environment's request headers.
     */
    fluxSocketUrl: (signal?: AbortSignal) =>
      send<string>({
        method: "POST",
        path: MEDIA_TICKET_PATH,
        timeoutMs: INFO_TIMEOUT_MS,
        signal,
        read: async (response, url) => {
          const body: unknown = await response.json();
          const ticket =
            typeof body === "object" && body !== null && "ticket" in body
              ? (body as { readonly ticket: unknown }).ticket
              : null;
          if (typeof ticket !== "string" || ticket.trim().length === 0) {
            throw new Error("The server did not issue a voice streaming ticket.");
          }
          const socketUrl = new URL(FLUX_WS_PATH, url);
          socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
          socketUrl.searchParams.set("wsTicket", ticket.trim());
          return socketUrl.toString();
        },
      }),
    ttsInfo: (signal?: AbortSignal) =>
      send<VoiceAvailableTtsInfo>({
        method: "GET",
        path: `${BASE_PATH}/tts-info`,
        timeoutMs: INFO_TIMEOUT_MS,
        signal,
        read: json,
      }),
    transcribe: (wav: Uint8Array, signal?: AbortSignal, language?: string) =>
      send<VoiceTranscribeResponse>({
        method: "POST",
        path: `${BASE_PATH}/transcribe${language ? `?language=${encodeURIComponent(language)}` : ""}`,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        signal,
        contentType: "audio/wav",
        body: wav as unknown as BodyInit,
        read: json,
      }),
    turn: (request: VoiceAssistantTurnRequest, signal?: AbortSignal) =>
      send<VoiceAssistantTurnResponse>({
        method: "POST",
        path: `${BASE_PATH}/turn`,
        timeoutMs: TURN_TIMEOUT_MS,
        signal,
        contentType: "application/json",
        body: JSON.stringify(request),
        read: json,
      }),
    speak: (request: VoiceSpeakRequest, signal?: AbortSignal) =>
      send<SpokenAudio>({
        method: "POST",
        path: `${BASE_PATH}/speak`,
        timeoutMs: SPEAK_TIMEOUT_MS,
        signal,
        contentType: "application/json",
        body: JSON.stringify(request),
        read: async (response) => ({
          bytes: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") ?? "audio/mpeg",
        }),
      }),
  };
}

export type VoiceAssistantApi = ReturnType<typeof createVoiceAssistantApi>;
