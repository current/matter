import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type {
  VoiceAvailableTtsInfo,
  VoiceCredentialsStatus,
  VoiceSpeakRequest,
  VoiceTranscribeResponse,
} from "../../../../antimatter/voice-assistant/types.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";

const DEEPGRAM_TTS_VOICES = [
  "aura-2-thalia-en",
  "aura-2-asteria-en",
  "aura-2-apollo-en",
  "aura-2-orion-en",
  "aura-2-luna-en",
  "aura-2-arcas-en",
  "aura-2-helena-en",
] as const;

const OPENAI_TTS_VOICES = ["coral", "nova", "alloy", "ash", "sage", "onyx", "shimmer"] as const;

const DEFAULT_MACOS_VOICES = ["Samantha", "Alex", "Karen", "Daniel", "Moira"] as const;

const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const VOICE_SECRETS_FILENAME = "mattr-voice-secrets.json";

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_INSTRUCTIONS =
  "Speak naturally, warmly, and concisely like a sharp engineering co-pilot in a car.";
const MACOS_SAY_PATH = "/usr/bin/say";
const DEFAULT_MAX_SPEECH_CHARS = 1200;

const DeepgramListenResponseSchema = Schema.Struct({
  results: Schema.optional(
    Schema.Struct({
      channels: Schema.optional(
        Schema.Array(
          Schema.Struct({
            alternatives: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  transcript: Schema.optional(Schema.String),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
});

const decodeDeepgramListenResponse = Schema.decodeUnknownEffect(DeepgramListenResponseSchema);

export class VoiceTtsUnavailableError extends Schema.TaggedError<VoiceTtsUnavailableError>()(
  "VoiceTtsUnavailableError",
  {
    reason: Schema.Literals(["disabled", "no-provider", "empty-text"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Server TTS is disabled for this request; use client speech synthesis.";
      case "no-provider":
        return "No server TTS provider is available on this host.";
      case "empty-text":
        return "There is no speakable text to synthesize.";
    }
  }
}

export class VoiceTtsSynthesisError extends Schema.TaggedError<VoiceTtsSynthesisError>()(
  "VoiceTtsSynthesisError",
  {
    provider: Schema.Literals(["deepgram", "openai", "macos"]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `Voice synthesis failed using ${this.provider}.`
      : `Voice synthesis using ${this.provider} failed with HTTP ${this.status}.`;
  }
}

const isVoiceTtsSynthesisError = Schema.is(VoiceTtsSynthesisError);

const readEnvOpenAiKey = Config.String("OPENAI_API_KEY").pipe(
  Config.withDefault(""),
  Effect.map((value) => value.trim()),
  Effect.orElseSucceed(() => ""),
);

const readEnvDeepgramKey = Config.String("DEEPGRAM_API_KEY").pipe(
  Config.withDefault(""),
  Effect.map((value) => value.trim()),
  Effect.orElseSucceed(() => ""),
);

const VoiceSecretsFileSchema = Schema.Struct({
  deepgramApiKey: Schema.optional(Schema.String),
});

const VoiceSecretsJsonSchema = Schema.fromJsonString(VoiceSecretsFileSchema);
const decodeVoiceSecretsJson = Schema.decodeUnknownEffect(VoiceSecretsJsonSchema);
const encodeVoiceSecretsJson = Schema.encodeEffect(VoiceSecretsJsonSchema);

interface VoiceSecretsFile {
  readonly deepgramApiKey?: string;
}

export interface VoiceTtsSpeakResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export class VoiceTtsService extends Context.Service<
  VoiceTtsService,
  {
    readonly getAvailableTtsInfo: Effect.Effect<VoiceAvailableTtsInfo>;
    readonly speak: (
      req: VoiceSpeakRequest,
    ) => Effect.Effect<VoiceTtsSpeakResult, VoiceTtsUnavailableError | VoiceTtsSynthesisError>;
    readonly transcribeDeepgram: (
      wavBytes: Uint8Array,
      language?: string,
    ) => Effect.Effect<VoiceTranscribeResponse, VoiceTtsUnavailableError | VoiceTtsSynthesisError>;
    readonly saveDeepgramApiKey: (apiKey: string) => Effect.Effect<VoiceCredentialsStatus>;
  }
>()("t3/voiceAssistant/VoiceTtsService") {}

export function sanitizeSpeechText(raw: string, maxLength = DEFAULT_MAX_SPEECH_CHARS): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/^[\t ]*[-*+]\s+/gm, "")
    .replace(/^[\t ]*\d+\.\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, " ")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const sliced = cleaned.slice(0, maxLength);
  const lastSentence = Math.max(
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("! "),
    sliced.lastIndexOf("? "),
  );
  if (lastSentence >= Math.floor(maxLength * 0.5)) {
    return sliced.slice(0, lastSentence + 1).trim();
  }
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace >= Math.floor(maxLength * 0.6) ? sliced.slice(0, lastSpace) : sliced).trim();
}

function clampTtsSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed)) return 1.08;
  return Math.min(1.5, Math.max(0.75, speed));
}

function parseMacosSayVoices(stdout: string): ReadonlyArray<string> {
  const discovered = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9 ()'-]{0,40}?)\s+(en_[A-Z]{2})\s+#/.exec(line.trim());
    if (!match) continue;
    const name = match[1]?.trim();
    if (name && !name.includes("(")) {
      discovered.add(name);
    }
  }
  if (discovered.size === 0) return DEFAULT_MACOS_VOICES;
  const prioritized = DEFAULT_MACOS_VOICES.filter((voice) => discovered.has(voice));
  const rest = [...discovered]
    .filter((voice) => !(prioritized as ReadonlyArray<string>).includes(voice))
    .sort((a, b) => a.localeCompare(b));
  return [...prioritized, ...rest].slice(0, 24);
}

function sanitizeMacosVoice(voice: string | undefined): string {
  const candidate = voice?.trim();
  if (candidate && /^[A-Za-z][A-Za-z0-9 '-]{0,40}$/.test(candidate)) {
    return candidate;
  }
  return DEFAULT_MACOS_VOICES[0];
}

function sanitizeOpenAiVoice(voice: string | undefined): string {
  const candidate = voice?.trim().toLowerCase();
  if (candidate && (OPENAI_TTS_VOICES as ReadonlyArray<string>).includes(candidate)) {
    return candidate;
  }
  return OPENAI_TTS_VOICES[0];
}

function sanitizeDeepgramVoice(voice: string | undefined): string {
  const candidate = voice?.trim().toLowerCase();
  if (candidate && (DEEPGRAM_TTS_VOICES as ReadonlyArray<string>).includes(candidate)) {
    return candidate;
  }
  return DEEPGRAM_TTS_VOICES[0];
}

function sanitizeLanguageParam(language: string | undefined): string {
  const candidate = language?.trim();
  if (!candidate || candidate.toLowerCase() === "auto") return "";
  if (!/^[A-Za-z0-9-]{2,16}$/.test(candidate)) return "";
  return `&language=${encodeURIComponent(candidate)}`;
}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const secretsPath = path.join(serverConfig.stateDir, VOICE_SECRETS_FILENAME);

  const platform = yield* HostProcess.Platform;
  const isMacosSayAvailable =
    platform === "darwin"
      ? fileSystem.exists(MACOS_SAY_PATH).pipe(Effect.orElseSucceed(() => false))
      : Effect.succeed(false);

  const loadMacosVoices = yield* Effect.cached(
    Effect.gen(function* () {
      if (!(yield* isMacosSayAvailable)) return [] as ReadonlyArray<string>;
      const result = yield* processRunner
        .run({
          command: MACOS_SAY_PATH,
          args: ["-v", "?"],
          timeout: "3 seconds",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (!result || result.timedOut || result.code !== 0) {
        return DEFAULT_MACOS_VOICES;
      }
      return parseMacosSayVoices(result.stdout);
    }),
  );

  const readStoredVoiceSecrets = Effect.fn("VoiceTtsService.readStoredVoiceSecrets")(function* () {
    const raw = yield* fileSystem
      .readFileString(secretsPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (!raw) return {} as VoiceSecretsFile;
    const decoded = yield* decodeVoiceSecretsJson(raw).pipe(Effect.orElseSucceed(() => null));
    const deepgramApiKey = decoded?.deepgramApiKey?.trim();
    return deepgramApiKey ? ({ deepgramApiKey } satisfies VoiceSecretsFile) : {};
  });

  const resolveDeepgramKey = Effect.fn("VoiceTtsService.resolveDeepgramKey")(function* () {
    const stored = yield* readStoredVoiceSecrets();
    if (stored.deepgramApiKey) return stored.deepgramApiKey;
    const envKey = yield* readEnvDeepgramKey;
    return envKey.length > 0 ? envKey : null;
  });

  const hasDeepgramConfigured = Effect.fn("VoiceTtsService.hasDeepgramConfigured")(function* () {
    return (yield* resolveDeepgramKey()) !== null;
  });

  const saveDeepgramApiKey: VoiceTtsService["Service"]["saveDeepgramApiKey"] = Effect.fn(
    "VoiceTtsService.saveDeepgramApiKey",
  )(function* (apiKey: string) {
    const trimmed = apiKey.trim();
    const payload: VoiceSecretsFile = trimmed.length > 0 ? { deepgramApiKey: trimmed } : {};
    const encoded = yield* encodeVoiceSecretsJson(payload).pipe(Effect.orElseSucceed(() => "{}"));
    yield* fileSystem
      .makeDirectory(serverConfig.stateDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fileSystem
      .writeFileString(secretsPath, `${encoded}\n`, { mode: 0o600 })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fileSystem.chmod(secretsPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
    const deepgramAvailable = yield* hasDeepgramConfigured();
    return { deepgramAvailable } satisfies VoiceCredentialsStatus;
  });

  const resolveOpenAiKey = Effect.fn("VoiceTtsService.resolveOpenAiKey")(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const configured = settings?.cloudSpeechCredentials.openai;
    if (configured) {
      const resolved = yield* requireSettingsSecret(secretResolver, configured).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (resolved.trim().length > 0) return resolved.trim();
    }
    const envKey = yield* readEnvOpenAiKey;
    return envKey.length > 0 ? envKey : null;
  });

  const hasOpenAiConfigured = Effect.fn("VoiceTtsService.hasOpenAiConfigured")(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings?.cloudSpeechCredentials.openai) return true;
    return (yield* readEnvOpenAiKey).length > 0;
  });

  const getAvailableTtsInfo: VoiceTtsService["Service"]["getAvailableTtsInfo"] = Effect.gen(
    function* () {
      const [deepgramAvailable, openaiAvailable, macosAvailable, macosVoices] = yield* Effect.all(
        [hasDeepgramConfigured(), hasOpenAiConfigured(), isMacosSayAvailable, loadMacosVoices],
        { concurrency: "unbounded" },
      );
      const defaultProvider: VoiceAvailableTtsInfo["defaultProvider"] = deepgramAvailable
        ? "deepgram"
        : openaiAvailable
          ? "openai"
          : macosAvailable
            ? "macos"
            : "browser";
      return {
        deepgramAvailable,
        openaiAvailable,
        macosAvailable,
        defaultProvider,
        deepgramVoices: DEEPGRAM_TTS_VOICES,
        openaiVoices: OPENAI_TTS_VOICES,
        macosVoices: macosAvailable ? macosVoices : [],
      } satisfies VoiceAvailableTtsInfo;
    },
  );

  const speakWithDeepgram = Effect.fn("VoiceTtsService.speakWithDeepgram")(function* (input: {
    readonly apiKey: string;
    readonly text: string;
    readonly voice: string | undefined;
  }) {
    const voice = sanitizeDeepgramVoice(input.voice);
    const url = `${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(voice)}&encoding=mp3`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("authorization", `Token ${input.apiKey}`),
      HttpClientRequest.bodyJsonUnsafe({ text: input.text }),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new VoiceTtsSynthesisError({ provider: "deepgram" })),
      }),
      Effect.mapError((cause) =>
        isVoiceTtsSynthesisError(cause)
          ? cause
          : new VoiceTtsSynthesisError({ provider: "deepgram", cause }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceTtsSynthesisError({ provider: "deepgram", status: response.status });
    }
    const arrayBuffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "deepgram", cause })),
    );
    return {
      bytes: new Uint8Array(arrayBuffer),
      contentType: "audio/mpeg",
    } satisfies VoiceTtsSpeakResult;
  });

  const transcribeDeepgram: VoiceTtsService["Service"]["transcribeDeepgram"] = Effect.fn(
    "VoiceTtsService.transcribeDeepgram",
  )(function* (wavBytes: Uint8Array, language?: string) {
    if (wavBytes.byteLength === 0) {
      return yield* new VoiceTtsUnavailableError({ reason: "empty-text" });
    }
    const apiKey = yield* resolveDeepgramKey();
    if (!apiKey) {
      return yield* new VoiceTtsUnavailableError({ reason: "no-provider" });
    }
    const langParam = sanitizeLanguageParam(language);
    const url = `${DEEPGRAM_LISTEN_URL}?model=nova-3&smart_format=true&punctuate=true${langParam}`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("authorization", `Token ${apiKey}`),
      HttpClientRequest.bodyUint8Array(wavBytes, "audio/wav"),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({
        duration: "25 seconds",
        orElse: () => Effect.fail(new VoiceTtsSynthesisError({ provider: "deepgram" })),
      }),
      Effect.mapError((cause) =>
        isVoiceTtsSynthesisError(cause)
          ? cause
          : new VoiceTtsSynthesisError({ provider: "deepgram", cause }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceTtsSynthesisError({ provider: "deepgram", status: response.status });
    }
    const rawJson = yield* response.json.pipe(
      Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "deepgram", cause })),
    );
    const parsed = yield* decodeDeepgramListenResponse(rawJson).pipe(
      Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "deepgram", cause })),
    );
    const transcript = parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
    return {
      text: transcript,
      provider: "deepgram",
    } satisfies VoiceTranscribeResponse;
  });

  const callOpenAiTts = Effect.fn("VoiceTtsService.callOpenAiTts")(function* (input: {
    readonly apiKey: string;
    readonly model: "gpt-4o-mini-tts" | "tts-1";
    readonly text: string;
    readonly voice: string;
    readonly speed: number;
  }) {
    const payload =
      input.model === "gpt-4o-mini-tts"
        ? {
            model: input.model,
            input: input.text,
            voice: input.voice,
            speed: input.speed,
            response_format: "mp3",
            instructions: OPENAI_TTS_INSTRUCTIONS,
          }
        : {
            model: input.model,
            input: input.text,
            voice: input.voice,
            speed: input.speed,
            response_format: "mp3",
          };
    const request = HttpClientRequest.post(OPENAI_TTS_URL).pipe(
      HttpClientRequest.bearerToken(Redacted.make(input.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(payload),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new VoiceTtsSynthesisError({ provider: "openai" })),
      }),
      Effect.mapError((cause) =>
        isVoiceTtsSynthesisError(cause)
          ? cause
          : new VoiceTtsSynthesisError({ provider: "openai", cause }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceTtsSynthesisError({ provider: "openai", status: response.status });
    }
    const arrayBuffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "openai", cause })),
    );
    return {
      bytes: new Uint8Array(arrayBuffer),
      contentType: "audio/mpeg",
    } satisfies VoiceTtsSpeakResult;
  });

  const speakWithOpenAi = Effect.fn("VoiceTtsService.speakWithOpenAi")(function* (input: {
    readonly apiKey: string;
    readonly text: string;
    readonly voice: string | undefined;
    readonly speed: number;
  }) {
    const voice = sanitizeOpenAiVoice(input.voice);
    return yield* callOpenAiTts({
      apiKey: input.apiKey,
      model: "gpt-4o-mini-tts",
      text: input.text,
      voice,
      speed: input.speed,
    }).pipe(
      Effect.catchIf(
        (error) => error.status === 400 || error.status === 404,
        () =>
          callOpenAiTts({
            apiKey: input.apiKey,
            model: "tts-1",
            text: input.text,
            voice,
            speed: input.speed,
          }),
      ),
    );
  });

  const speakWithMacos = Effect.fn("VoiceTtsService.speakWithMacos")(function* (input: {
    readonly text: string;
    readonly voice: string | undefined;
    readonly speed: number;
  }) {
    const voice = sanitizeMacosVoice(input.voice);
    const rate = Math.min(300, Math.max(120, Math.round(180 * input.speed)));
    const tempDir = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "mattr-tts-" })
      .pipe(Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "macos", cause })));
    const inputPath = path.join(tempDir, "input.txt");
    const outputPath = path.join(tempDir, "speech.wav");
    yield* fileSystem
      .writeFileString(inputPath, input.text)
      .pipe(Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "macos", cause })));

    const runSay = (selectedVoice: string | null) =>
      processRunner
        .run({
          command: MACOS_SAY_PATH,
          args: [
            ...(selectedVoice ? ["-v", selectedVoice] : []),
            "-r",
            String(rate),
            "-f",
            inputPath,
            "-o",
            outputPath,
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
          ],
          timeout: "20 seconds",
        })
        .pipe(Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "macos", cause })));

    let result = yield* runSay(voice);
    if (result.code !== 0) {
      result = yield* runSay(null);
    }
    if (result.code !== 0) {
      return yield* new VoiceTtsSynthesisError({
        provider: "macos",
        cause: result.stderr || `say exited with code ${result.code}`,
      });
    }
    const bytes = yield* fileSystem
      .readFile(outputPath)
      .pipe(Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider: "macos", cause })));
    if (bytes.byteLength === 0) {
      return yield* new VoiceTtsSynthesisError({ provider: "macos" });
    }
    return { bytes, contentType: "audio/wav" } satisfies VoiceTtsSpeakResult;
  }, Effect.scoped);

  const speakWithOpenAiOrMacos = Effect.fn("VoiceTtsService.speakWithOpenAiOrMacos")(
    function* (input: {
      readonly openAiKey: string | null;
      readonly macosAvailable: boolean;
      readonly text: string;
      readonly voice: string | undefined;
      readonly speed: number;
    }): Effect.fn.Return<VoiceTtsSpeakResult, VoiceTtsUnavailableError | VoiceTtsSynthesisError> {
      if (input.openAiKey) {
        return yield* speakWithOpenAi({
          apiKey: input.openAiKey,
          text: input.text,
          voice: input.voice,
          speed: input.speed,
        }).pipe(
          Effect.catchTags({
            VoiceTtsSynthesisError: (error) =>
              input.macosAvailable
                ? Effect.logWarning("OpenAI TTS failed; falling back to macOS say.", {
                    status: error.status,
                  }).pipe(
                    Effect.andThen(
                      speakWithMacos({ text: input.text, voice: input.voice, speed: input.speed }),
                    ),
                  )
                : Effect.fail(error),
          }),
        );
      }
      if (input.macosAvailable) {
        return yield* speakWithMacos({ text: input.text, voice: input.voice, speed: input.speed });
      }
      return yield* new VoiceTtsUnavailableError({ reason: "no-provider" });
    },
  );

  const speak: VoiceTtsService["Service"]["speak"] = Effect.fn("VoiceTtsService.speak")(
    function* (req) {
      const text = sanitizeSpeechText(req.text);
      if (text.length === 0) {
        return yield* new VoiceTtsUnavailableError({ reason: "empty-text" });
      }
      const speed = clampTtsSpeed(req.speed);
      const requested = req.provider ?? "auto";
      if (requested === "off" || requested === "browser") {
        return yield* new VoiceTtsUnavailableError({ reason: "disabled" });
      }
      if (requested === "deepgram") {
        const apiKey = yield* resolveDeepgramKey();
        if (!apiKey) {
          return yield* new VoiceTtsUnavailableError({ reason: "no-provider" });
        }
        return yield* speakWithDeepgram({ apiKey, text, voice: req.voice });
      }
      if (requested === "openai") {
        const apiKey = yield* resolveOpenAiKey();
        if (!apiKey) {
          return yield* new VoiceTtsUnavailableError({ reason: "no-provider" });
        }
        return yield* speakWithOpenAi({ apiKey, text, voice: req.voice, speed });
      }
      if (requested === "macos") {
        if (!(yield* isMacosSayAvailable)) {
          return yield* new VoiceTtsUnavailableError({ reason: "no-provider" });
        }
        return yield* speakWithMacos({ text, voice: req.voice, speed });
      }

      const [deepgramKey, openAiKey, macosAvailable] = yield* Effect.all(
        [resolveDeepgramKey(), resolveOpenAiKey(), isMacosSayAvailable],
        { concurrency: "unbounded" },
      );
      if (deepgramKey) {
        return yield* speakWithDeepgram({ apiKey: deepgramKey, text, voice: req.voice }).pipe(
          Effect.catchTags({
            VoiceTtsSynthesisError: (error) =>
              openAiKey || macosAvailable
                ? Effect.logWarning("Deepgram Aura-2 TTS failed; falling back to next provider.", {
                    status: error.status,
                  }).pipe(
                    Effect.andThen(
                      speakWithOpenAiOrMacos({
                        openAiKey,
                        macosAvailable,
                        text,
                        voice: req.voice,
                        speed,
                      }),
                    ),
                  )
                : Effect.fail(error),
          }),
        );
      }
      return yield* speakWithOpenAiOrMacos({
        openAiKey,
        macosAvailable,
        text,
        voice: req.voice,
        speed,
      });
    },
  );

  return VoiceTtsService.of({
    getAvailableTtsInfo,
    speak,
    transcribeDeepgram,
    saveDeepgramApiKey,
  });
});

export const layer = Layer.effect(VoiceTtsService, make);
