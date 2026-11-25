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

import {
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_VOICE,
  DEFAULT_VOICE_SERVER_TTS_PREFERENCES,
  ELEVENLABS_PREMADE_VOICES,
  ELEVENLABS_TTS_MODELS,
  type ElevenLabsTtsModel,
  type VoiceAvailableTtsInfo,
  type VoiceCredentialsStatus,
  type VoiceServerTtsPreferences,
  type VoiceSpeakRequest,
  type VoiceTranscribeResponse,
  type VoiceTtsProvider,
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
const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_VOICE_SETTINGS = { stability: 0.45, similarity_boost: 0.78 } as const;
const ELEVENLABS_VOICE_IDS = ELEVENLABS_PREMADE_VOICES.map((voice) => voice.id);
const VOICE_SECRETS_FILENAME = "mattr-voice-secrets.json";
const VOICE_CONFIG_FILENAME = "mattr-voice-config.json";

type ServerTtsProvider = "elevenlabs" | "deepgram" | "openai" | "macos";
const AUTO_TTS_ORDER: ReadonlyArray<ServerTtsProvider> = [
  "elevenlabs",
  "deepgram",
  "openai",
  "macos",
];
const isServerTtsProvider = (value: VoiceTtsProvider): value is ServerTtsProvider =>
  (AUTO_TTS_ORDER as ReadonlyArray<string>).includes(value);

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
    provider: Schema.Literals(["elevenlabs", "deepgram", "openai", "macos"]),
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

const readEnvElevenLabsKey = Config.String("ELEVENLABS_API_KEY").pipe(
  Config.withDefault(""),
  Effect.map((value) => value.trim()),
  Effect.orElseSucceed(() => ""),
);

const VoiceSecretsFileSchema = Schema.Struct({
  deepgramApiKey: Schema.optional(Schema.String),
  elevenlabsApiKey: Schema.optional(Schema.String),
});

const VoiceSecretsJsonSchema = Schema.fromJsonString(VoiceSecretsFileSchema);
const decodeVoiceSecretsJson = Schema.decodeUnknownEffect(VoiceSecretsJsonSchema);
const encodeVoiceSecretsJson = Schema.encodeEffect(VoiceSecretsJsonSchema);

interface VoiceSecretsFile {
  readonly deepgramApiKey?: string;
  readonly elevenlabsApiKey?: string;
}

/** `undefined` leaves a key unchanged; an empty string clears it. */
export interface VoiceCredentialsPatch {
  readonly deepgramApiKey?: string | undefined;
  readonly elevenlabsApiKey?: string | undefined;
}

const VoiceConfigJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    ttsProvider: Schema.optional(Schema.String),
    elevenlabsModel: Schema.optional(Schema.String),
    elevenlabsVoice: Schema.optional(Schema.String),
    deepgramVoice: Schema.optional(Schema.String),
  }),
);
const decodeVoiceConfigJson = Schema.decodeUnknownEffect(VoiceConfigJsonSchema);
const encodeVoiceConfigJson = Schema.encodeEffect(VoiceConfigJsonSchema);

const VALID_PREFERENCE_PROVIDERS: ReadonlyArray<VoiceTtsProvider> = [
  "auto",
  "elevenlabs",
  "deepgram",
  "openai",
  "macos",
  "browser",
  "off",
];

export interface VoiceTtsSpeakResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** The provider that synthesized it, set by `speak`. */
  readonly provider?: ServerTtsProvider;
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
    readonly saveCredentials: (
      patch: VoiceCredentialsPatch,
    ) => Effect.Effect<VoiceCredentialsStatus>;
    readonly getCredentialsStatus: Effect.Effect<VoiceCredentialsStatus>;
    readonly getTtsPreferences: Effect.Effect<VoiceServerTtsPreferences>;
    readonly saveTtsPreferences: (
      patch: Partial<Record<keyof VoiceServerTtsPreferences, string | undefined>>,
    ) => Effect.Effect<VoiceServerTtsPreferences>;
    readonly resolveDeepgramApiKey: () => Effect.Effect<string | null>;
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

function matchDeepgramVoice(voice: string | undefined): string | null {
  const candidate = voice?.trim().toLowerCase();
  return candidate && (DEEPGRAM_TTS_VOICES as ReadonlyArray<string>).includes(candidate)
    ? candidate
    : null;
}

function sanitizeDeepgramVoice(voice: string | undefined, fallback?: string): string {
  return matchDeepgramVoice(voice) ?? matchDeepgramVoice(fallback) ?? DEEPGRAM_TTS_VOICES[0];
}

// ElevenLabs voice ids are opaque alphanumeric ids (20 chars today); custom voices are allowed.
function matchElevenLabsVoice(voice: string | undefined): string | null {
  const candidate = voice?.trim();
  return candidate && /^[A-Za-z0-9]{16,40}$/.test(candidate) ? candidate : null;
}

function sanitizeElevenLabsVoice(voice: string | undefined, fallback?: string): string {
  return matchElevenLabsVoice(voice) ?? matchElevenLabsVoice(fallback) ?? DEFAULT_ELEVENLABS_VOICE;
}

function matchElevenLabsModel(model: string | undefined): ElevenLabsTtsModel | null {
  const candidate = model?.trim().toLowerCase();
  return ELEVENLABS_TTS_MODELS.find((allowed) => allowed === candidate) ?? null;
}

function sanitizeElevenLabsModel(model: string | undefined, fallback?: string): ElevenLabsTtsModel {
  return matchElevenLabsModel(model) ?? matchElevenLabsModel(fallback) ?? DEFAULT_ELEVENLABS_MODEL;
}

function normalizeTtsPreferences(
  raw: Partial<Record<keyof VoiceServerTtsPreferences, string | undefined>>,
  base: VoiceServerTtsPreferences = DEFAULT_VOICE_SERVER_TTS_PREFERENCES,
): VoiceServerTtsPreferences {
  const provider = VALID_PREFERENCE_PROVIDERS.find((value) => value === raw.ttsProvider?.trim());
  return {
    ttsProvider: provider ?? base.ttsProvider,
    elevenlabsModel: sanitizeElevenLabsModel(raw.elevenlabsModel, base.elevenlabsModel),
    elevenlabsVoice: sanitizeElevenLabsVoice(raw.elevenlabsVoice, base.elevenlabsVoice),
    deepgramVoice:
      raw.deepgramVoice === undefined
        ? base.deepgramVoice
        : (matchDeepgramVoice(raw.deepgramVoice) ?? ""),
  };
}

function sanitizeLanguageParam(language: string | undefined): string {
  const candidate = language?.trim();
  if (!candidate || candidate.toLowerCase() === "auto") return "";
  if (!/^[A-Za-z0-9-]{2,16}$/.test(candidate)) return "";
  return `&language=${encodeURIComponent(candidate)}`;
}

function compactSecrets(secrets: {
  readonly deepgramApiKey?: string | undefined;
  readonly elevenlabsApiKey?: string | undefined;
}): VoiceSecretsFile {
  const deepgramApiKey = secrets.deepgramApiKey?.trim();
  const elevenlabsApiKey = secrets.elevenlabsApiKey?.trim();
  return {
    ...(deepgramApiKey ? { deepgramApiKey } : {}),
    ...(elevenlabsApiKey ? { elevenlabsApiKey } : {}),
  };
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
  const configPath = path.join(serverConfig.stateDir, VOICE_CONFIG_FILENAME);

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
    return compactSecrets({
      deepgramApiKey: decoded?.deepgramApiKey,
      elevenlabsApiKey: decoded?.elevenlabsApiKey,
    });
  });

  const writeOwnerOnlyFile = Effect.fn("VoiceTtsService.writeOwnerOnlyFile")(function* (
    filePath: string,
    contents: string,
  ) {
    yield* fileSystem
      .makeDirectory(serverConfig.stateDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fileSystem
      .writeFileString(filePath, `${contents}\n`, { mode: 0o600 })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fileSystem.chmod(filePath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
  });

  const resolveElevenLabsKey = Effect.fn("VoiceTtsService.resolveElevenLabsKey")(function* () {
    const stored = yield* readStoredVoiceSecrets();
    if (stored.elevenlabsApiKey) return stored.elevenlabsApiKey;
    const envKey = yield* readEnvElevenLabsKey;
    return envKey.length > 0 ? envKey : null;
  });

  const getTtsPreferences: VoiceTtsService["Service"]["getTtsPreferences"] = Effect.gen(
    function* () {
      const raw = yield* fileSystem
        .readFileString(configPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!raw) return DEFAULT_VOICE_SERVER_TTS_PREFERENCES;
      const decoded = yield* decodeVoiceConfigJson(raw).pipe(Effect.orElseSucceed(() => null));
      return decoded ? normalizeTtsPreferences(decoded) : DEFAULT_VOICE_SERVER_TTS_PREFERENCES;
    },
  );

  const saveTtsPreferences: VoiceTtsService["Service"]["saveTtsPreferences"] = Effect.fn(
    "VoiceTtsService.saveTtsPreferences",
  )(function* (patch) {
    const next = normalizeTtsPreferences(patch, yield* getTtsPreferences);
    const encoded = yield* encodeVoiceConfigJson(next).pipe(Effect.orElseSucceed(() => "{}"));
    yield* writeOwnerOnlyFile(configPath, encoded);
    return next;
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

  const hasElevenLabsConfigured = Effect.fn("VoiceTtsService.hasElevenLabsConfigured")(
    function* () {
      return (yield* resolveElevenLabsKey()) !== null;
    },
  );

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

  const getCredentialsStatus: VoiceTtsService["Service"]["getCredentialsStatus"] = Effect.gen(
    function* () {
      const [deepgramConfigured, elevenlabsConfigured, openaiConfigured] = yield* Effect.all(
        [hasDeepgramConfigured(), hasElevenLabsConfigured(), hasOpenAiConfigured()],
        { concurrency: "unbounded" },
      );
      return {
        deepgramAvailable: deepgramConfigured,
        deepgramConfigured,
        elevenlabsConfigured,
        openaiConfigured,
      } satisfies VoiceCredentialsStatus;
    },
  );

  const saveCredentials: VoiceTtsService["Service"]["saveCredentials"] = Effect.fn(
    "VoiceTtsService.saveCredentials",
  )(function* (patch) {
    const stored = yield* readStoredVoiceSecrets();
    const next = compactSecrets({
      deepgramApiKey: patch.deepgramApiKey ?? stored.deepgramApiKey,
      elevenlabsApiKey: patch.elevenlabsApiKey ?? stored.elevenlabsApiKey,
    });
    const encoded = yield* encodeVoiceSecretsJson(next).pipe(Effect.orElseSucceed(() => "{}"));
    yield* writeOwnerOnlyFile(secretsPath, encoded);
    return yield* getCredentialsStatus;
  });

  const saveDeepgramApiKey: VoiceTtsService["Service"]["saveDeepgramApiKey"] = (apiKey) =>
    saveCredentials({ deepgramApiKey: apiKey });

  /** Preferred provider first (when the server default names one), then the auto order. */
  const autoProviderOrder = (preferences: VoiceServerTtsPreferences) => {
    const preferred = isServerTtsProvider(preferences.ttsProvider) ? [preferences.ttsProvider] : [];
    return [...preferred, ...AUTO_TTS_ORDER.filter((provider) => !preferred.includes(provider))];
  };

  const getAvailableTtsInfo: VoiceTtsService["Service"]["getAvailableTtsInfo"] = Effect.gen(
    function* () {
      const [
        elevenlabsAvailable,
        deepgramAvailable,
        openaiAvailable,
        macosAvailable,
        macosVoices,
        preferences,
      ] = yield* Effect.all(
        [
          hasElevenLabsConfigured(),
          hasDeepgramConfigured(),
          hasOpenAiConfigured(),
          isMacosSayAvailable,
          loadMacosVoices,
          getTtsPreferences,
        ],
        { concurrency: "unbounded" },
      );
      const available: Record<ServerTtsProvider, boolean> = {
        elevenlabs: elevenlabsAvailable,
        deepgram: deepgramAvailable,
        openai: openaiAvailable,
        macos: macosAvailable,
      };
      const defaultProvider: VoiceAvailableTtsInfo["defaultProvider"] =
        preferences.ttsProvider === "browser" || preferences.ttsProvider === "off"
          ? "browser"
          : (autoProviderOrder(preferences).find((provider) => available[provider]) ?? "browser");
      return {
        elevenlabsAvailable,
        deepgramAvailable,
        openaiAvailable,
        macosAvailable,
        defaultProvider,
        elevenlabsModels: ELEVENLABS_TTS_MODELS,
        elevenlabsVoices: ELEVENLABS_VOICE_IDS,
        deepgramVoices: DEEPGRAM_TTS_VOICES,
        openaiVoices: OPENAI_TTS_VOICES,
        macosVoices: macosAvailable ? macosVoices : [],
        preferences,
      } satisfies VoiceAvailableTtsInfo;
    },
  );

  const executeAudioRequest = Effect.fn("VoiceTtsService.executeAudioRequest")(function* (
    provider: "elevenlabs" | "deepgram",
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new VoiceTtsSynthesisError({ provider })),
      }),
      Effect.mapError((cause) =>
        isVoiceTtsSynthesisError(cause) ? cause : new VoiceTtsSynthesisError({ provider, cause }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceTtsSynthesisError({ provider, status: response.status });
    }
    const arrayBuffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => new VoiceTtsSynthesisError({ provider, cause })),
    );
    return {
      bytes: new Uint8Array(arrayBuffer),
      contentType: "audio/mpeg",
    } satisfies VoiceTtsSpeakResult;
  });

  const speakWithElevenLabs = Effect.fn("VoiceTtsService.speakWithElevenLabs")(function* (input: {
    readonly apiKey: string;
    readonly text: string;
    readonly voice: string;
    readonly model: ElevenLabsTtsModel;
  }) {
    const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(input.voice)}?output_format=mp3_44100_128`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("xi-api-key", input.apiKey),
      HttpClientRequest.setHeader("accept", "audio/mpeg"),
      HttpClientRequest.bodyJsonUnsafe({
        text: input.text,
        model_id: input.model,
        voice_settings: ELEVENLABS_VOICE_SETTINGS,
      }),
    );
    return yield* executeAudioRequest("elevenlabs", request);
  });

  const speakWithDeepgram = Effect.fn("VoiceTtsService.speakWithDeepgram")(function* (input: {
    readonly apiKey: string;
    readonly text: string;
    readonly voice: string;
  }) {
    const url = `${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(input.voice)}&encoding=mp3`;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("authorization", `Token ${input.apiKey}`),
      HttpClientRequest.bodyJsonUnsafe({ text: input.text }),
    );
    return yield* executeAudioRequest("deepgram", request);
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
      const preferences = yield* getTtsPreferences;
      if (
        requested === "auto" &&
        (preferences.ttsProvider === "off" || preferences.ttsProvider === "browser")
      ) {
        return yield* new VoiceTtsUnavailableError({ reason: "disabled" });
      }

      // Each provider only accepts a voice in its own format, so one request voice is safe to
      // pass down the whole auto chain; anything else falls back to the server's saved voice.
      const speakWith = Effect.fn("VoiceTtsService.speakWith")(function* (
        provider: ServerTtsProvider,
      ): Effect.fn.Return<VoiceTtsSpeakResult | null, VoiceTtsSynthesisError> {
        switch (provider) {
          case "elevenlabs": {
            const apiKey = yield* resolveElevenLabsKey();
            if (!apiKey) return null;
            return yield* speakWithElevenLabs({
              apiKey,
              text,
              voice: sanitizeElevenLabsVoice(req.voice, preferences.elevenlabsVoice),
              model: sanitizeElevenLabsModel(req.model, preferences.elevenlabsModel),
            });
          }
          case "deepgram": {
            const apiKey = yield* resolveDeepgramKey();
            if (!apiKey) return null;
            return yield* speakWithDeepgram({
              apiKey,
              text,
              voice: sanitizeDeepgramVoice(req.voice, preferences.deepgramVoice),
            });
          }
          case "openai": {
            const apiKey = yield* resolveOpenAiKey();
            if (!apiKey) return null;
            return yield* speakWithOpenAi({ apiKey, text, voice: req.voice, speed });
          }
          case "macos": {
            if (!(yield* isMacosSayAvailable)) return null;
            return yield* speakWithMacos({ text, voice: req.voice, speed });
          }
        }
      });

      if (requested !== "auto") {
        const result = yield* speakWith(requested);
        if (!result) return yield* new VoiceTtsUnavailableError({ reason: "no-provider" });
        return { ...result, provider: requested };
      }

      let lastError: VoiceTtsSynthesisError | null = null;
      for (const provider of autoProviderOrder(preferences)) {
        const attempt = yield* speakWith(provider).pipe(
          Effect.map((result) => ({ result, error: null })),
          Effect.catchTags({
            VoiceTtsSynthesisError: (error) =>
              Effect.logWarning("Server TTS failed; falling back to next provider.", {
                provider,
                status: error.status,
              }).pipe(Effect.as({ result: null, error })),
          }),
        );
        if (attempt.result) return { ...attempt.result, provider };
        if (attempt.error) lastError = attempt.error;
      }
      if (lastError) return yield* lastError;
      return yield* new VoiceTtsUnavailableError({ reason: "no-provider" });
    },
  );

  return VoiceTtsService.of({
    getAvailableTtsInfo,
    speak,
    transcribeDeepgram,
    saveDeepgramApiKey,
    saveCredentials,
    getCredentialsStatus,
    getTtsPreferences,
    saveTtsPreferences,
    resolveDeepgramApiKey: resolveDeepgramKey,
  });
});

export const layer = Layer.effect(VoiceTtsService, make);
