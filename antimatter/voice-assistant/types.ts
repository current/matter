export type VoiceAssistantInteractionMode = "smart" | "assistant" | "dictation" | "voice-mode";

export type VoiceTtsProvider =
  | "auto"
  | "elevenlabs"
  | "deepgram"
  | "openai"
  | "macos"
  | "browser"
  | "off";

export const ELEVENLABS_TTS_MODELS = [
  "eleven_v4_turbo",
  "eleven_flash_v2_5",
  "eleven_v3_conversational",
  "eleven_v4",
] as const;

export type ElevenLabsTtsModel = (typeof ELEVENLABS_TTS_MODELS)[number];

export const DEFAULT_ELEVENLABS_MODEL: ElevenLabsTtsModel = "eleven_v4_turbo";

/** Premade conversational voices verified on the account; River is the default. */
export const ELEVENLABS_PREMADE_VOICES = [
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger" },
  { id: "bIHbv24MWmeRgasZH58o", name: "Will" },
  { id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris" },
] as const;

export const DEFAULT_ELEVENLABS_VOICE = "SAz9YHcvj6GT2YYXdXww";

/** ElevenLabs API `voice_settings` parameters (camelCase in mattr, snake_case on the wire). */
export interface ElevenLabsVoiceSettings {
  readonly stability: number;
  readonly similarityBoost: number;
  readonly style: number;
  readonly speed: number;
  readonly useSpeakerBoost: boolean;
}

export interface ElevenLabsVoiceSettingsPatch {
  readonly stability?: number | undefined;
  readonly similarityBoost?: number | undefined;
  readonly style?: number | undefined;
  readonly speed?: number | undefined;
  readonly useSpeakerBoost?: boolean | undefined;
}

export const DEFAULT_ELEVENLABS_VOICE_SETTINGS: ElevenLabsVoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.15,
  speed: 1.0,
  useSpeakerBoost: true,
};

/** Server-side TTS defaults, used when a client (e.g. the iPhone app) sends no provider. */
export interface VoiceServerTtsPreferences {
  readonly ttsProvider: VoiceTtsProvider;
  readonly elevenlabsModel: ElevenLabsTtsModel;
  readonly elevenlabsVoice: string;
  readonly deepgramVoice: string;
  readonly customVoiceId?: string | undefined;
  readonly stability?: number | undefined;
  readonly similarityBoost?: number | undefined;
  readonly style?: number | undefined;
  readonly speed?: number | undefined;
  readonly useSpeakerBoost?: boolean | undefined;
}

export const DEFAULT_VOICE_SERVER_TTS_PREFERENCES: VoiceServerTtsPreferences = {
  ttsProvider: "auto",
  elevenlabsModel: DEFAULT_ELEVENLABS_MODEL,
  elevenlabsVoice: DEFAULT_ELEVENLABS_VOICE,
  deepgramVoice: "",
  customVoiceId: "",
  stability: DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
  similarityBoost: DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
  style: DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
  speed: DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
  useSpeakerBoost: DEFAULT_ELEVENLABS_VOICE_SETTINGS.useSpeakerBoost,
};

export interface VoiceAssistantSettings {
  /** Default mode when opening voice in Island or Voice Mode. */
  readonly defaultMode: "smart" | "assistant" | "dictation";
  /** Speak assistant responses aloud automatically in assistant/voice mode. */
  readonly speakReplies: boolean;
  /** TTS engine preference. "auto" uses the server default, else ElevenLabs, Deepgram Aura-2, OpenAI, macOS say, then browser speechSynthesis. */
  readonly ttsProvider: VoiceTtsProvider;
  /** Voice name (e.g. "aura-2-thalia-en" for Deepgram; "coral" for OpenAI; "Samantha" for macOS; or empty for default). */
  readonly ttsVoice: string;
  /** ElevenLabs model id (allowlisted). */
  readonly elevenlabsModel: ElevenLabsTtsModel;
  /** ElevenLabs voice id (premade or custom). */
  readonly elevenlabsVoice: string;
  /** Optional custom ElevenLabs voice ID overriding the preset voice when set. */
  readonly elevenlabsCustomVoiceId: string;
  /** ElevenLabs voice stability (0.0–1.0). */
  readonly elevenlabsStability: number;
  /** ElevenLabs similarity boost (0.0–1.0). */
  readonly elevenlabsSimilarityBoost: number;
  /** ElevenLabs style / expressiveness (0.0–1.0). */
  readonly elevenlabsStyle: number;
  /** ElevenLabs speech speed (0.7–1.2). */
  readonly elevenlabsSpeed: number;
  /** ElevenLabs speaker boost toggle. */
  readonly elevenlabsUseSpeakerBoost: boolean;
  /** Speech playback rate (0.8 to 1.5). */
  readonly ttsSpeed: number;
  /** Automatically keep listening for follow-ups in Hands-Free Voice Mode. */
  readonly handsFreeAutoListen: boolean;
  /** Interrupt spoken output immediately when user starts speaking. */
  readonly bargeInEnabled: boolean;
  /** Silence duration in ms before ending a hands-free utterance. */
  readonly silenceTimeoutMs: number;
  /** Proactively speak updates when threads finish, error, or need approval/input. */
  readonly proactiveBriefings: boolean;
  readonly announceApprovals: boolean;
  readonly announceQuestions: boolean;
  readonly announceCompletions: boolean;
  readonly announceFailures: boolean;
  /** Play Lilt-style audio cues for dictation start/stop and Voice Mode open/close. */
  readonly soundCuesEnabled: boolean;
  /** Play a single subtle muted pulse on transition to thinking in Voice Mode. */
  readonly thinkingCueEnabled: boolean;
}

export const DEFAULT_VOICE_ASSISTANT_SETTINGS: VoiceAssistantSettings = {
  defaultMode: "smart",
  speakReplies: true,
  ttsProvider: "auto",
  ttsVoice: "",
  elevenlabsModel: DEFAULT_ELEVENLABS_MODEL,
  elevenlabsVoice: DEFAULT_ELEVENLABS_VOICE,
  elevenlabsCustomVoiceId: "",
  elevenlabsStability: DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
  elevenlabsSimilarityBoost: DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
  elevenlabsStyle: DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
  elevenlabsSpeed: DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
  elevenlabsUseSpeakerBoost: DEFAULT_ELEVENLABS_VOICE_SETTINGS.useSpeakerBoost,
  ttsSpeed: 1.08,
  handsFreeAutoListen: true,
  bargeInEnabled: true,
  silenceTimeoutMs: 1150,
  proactiveBriefings: true,
  announceApprovals: true,
  announceQuestions: true,
  announceCompletions: true,
  announceFailures: true,
  soundCuesEnabled: true,
  thinkingCueEnabled: true,
};

export interface VoiceWorkspaceProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly archived?: boolean;
}

export interface VoiceWorkspaceThreadSummary {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly status: "running" | "approval" | "input" | "done" | "failed" | "limited" | "idle";
  readonly updatedAt: string;
  readonly latestUserMessage: string | null;
  readonly latestAssistantMessage: string | null;
  readonly isActive?: boolean;
  readonly parentThreadId?: string | null;
  readonly parentThreadTitle?: string | null;
  readonly relationshipToParent?: "subagent" | null;
  readonly activeChildCount?: number;
  readonly childTitles?: ReadonlyArray<string>;
  readonly providerInstanceId?: string | null;
  readonly model?: string | null;
  readonly branch?: string | null;
}

export interface VoiceWorkspaceApprovalSummary {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly requestId: string;
  readonly requestKind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly reason: string | null;
}

export interface VoiceWorkspaceQuestionOption {
  readonly label: string;
  readonly description?: string | undefined;
}

export interface VoiceWorkspaceQuestionSummary {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly requestId: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly isMultiSelect?: boolean | undefined;
    readonly options: ReadonlyArray<string>;
    readonly optionDetails?: ReadonlyArray<VoiceWorkspaceQuestionOption> | undefined;
  }>;
}

export interface VoiceWorkspaceContext {
  readonly activeEnvironmentId: string | null;
  readonly activeThreadId: string | null;
  readonly activeRoute: string | null;
  readonly mainWindowFocused: boolean;
  readonly composerFocused: boolean;
  readonly projects: ReadonlyArray<VoiceWorkspaceProjectSummary>;
  readonly threads: ReadonlyArray<VoiceWorkspaceThreadSummary>;
  readonly pendingApprovals: ReadonlyArray<VoiceWorkspaceApprovalSummary>;
  readonly pendingQuestions: ReadonlyArray<VoiceWorkspaceQuestionSummary>;
}

export interface VoiceAssistantHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolSummary?: string | undefined;
}

export interface VoiceAssistantToolResult {
  readonly tool: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly environmentId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly projectId?: string | undefined;
}

export type VoiceAssistantClientAction =
  | { readonly type: "navigate-thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly type: "navigate-route"; readonly to: string }
  | { readonly type: "focus-window" }
  | { readonly type: "insert-dictation"; readonly text: string; readonly autoSend?: boolean }
  | {
      readonly type: "respond-approval";
      readonly environmentId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: "accept" | "acceptAlways" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      readonly type: "respond-question";
      readonly environmentId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly answers: Record<string, string | ReadonlyArray<string>>;
    }
  | {
      readonly type: "dismiss-question";
      readonly environmentId: string;
      readonly threadId: string;
      readonly requestId: string;
    };

export interface VoiceAssistantTurnRequest {
  readonly utterance: string;
  readonly mode: VoiceAssistantInteractionMode;
  readonly history: ReadonlyArray<VoiceAssistantHistoryMessage>;
  readonly context: VoiceWorkspaceContext;
}

export interface VoiceAssistantTurnResponse {
  /** Which route was taken for this utterance. */
  readonly route: "dictation" | "direct-reply" | "approval" | "question" | "assistant";
  /** Concise, natural spoken reply designed for TTS (no markdown or raw code dumps). */
  readonly spokenReply: string;
  /** Optional slightly richer short display text for the UI card. */
  readonly displayReply: string;
  /** Whether the assistant expects the user to reply next (auto-reopen mic in Voice Mode). */
  readonly expectFollowUp: boolean;
  /** Server-side tool executions already completed during this turn. */
  readonly toolResults: ReadonlyArray<VoiceAssistantToolResult>;
  /** Client-side UI or authenticated approval actions for the renderer to apply. */
  readonly clientActions: ReadonlyArray<VoiceAssistantClientAction>;
}

export type VoiceBriefingKind = "approval" | "question" | "completed" | "failed" | "limited";

export interface VoiceBriefingRequest {
  readonly kind: VoiceBriefingKind;
  readonly threadTitle: string;
  readonly projectTitle: string | null;
  readonly detail: string | null;
  readonly latestAssistantMessage: string | null;
  readonly questionPrompts?: ReadonlyArray<string> | undefined;
  readonly count?: number | undefined;
  readonly extraTitles?: ReadonlyArray<string> | undefined;
}

export interface VoiceBriefingResponse {
  readonly spokenText: string;
  readonly shortLabel: string;
  readonly expectFollowUp: boolean;
}

export interface VoiceSpeakRequest {
  readonly text: string;
  readonly provider?: VoiceTtsProvider | undefined;
  readonly voice?: string | undefined;
  /** ElevenLabs model override; ignored by other providers. */
  readonly model?: string | undefined;
  readonly speed?: number | undefined;
  /** Optional ElevenLabs voice_settings overrides; ignored by other providers. */
  readonly elevenlabsVoiceSettings?: ElevenLabsVoiceSettingsPatch | undefined;
}

export interface VoiceAvailableTtsInfo {
  readonly elevenlabsAvailable: boolean;
  readonly deepgramAvailable: boolean;
  readonly openaiAvailable: boolean;
  readonly macosAvailable: boolean;
  readonly defaultProvider: Exclude<VoiceTtsProvider, "auto" | "off">;
  readonly elevenlabsModels: ReadonlyArray<string>;
  readonly elevenlabsVoices: ReadonlyArray<string>;
  readonly deepgramVoices: ReadonlyArray<string>;
  readonly openaiVoices: ReadonlyArray<string>;
  readonly macosVoices: ReadonlyArray<string>;
  readonly preferences: VoiceServerTtsPreferences;
}

export interface VoiceTranscribeResponse {
  readonly text: string;
  readonly provider: "deepgram";
}

/** Never carries raw keys, only whether each provider is configured. */
export interface VoiceCredentialsStatus {
  /** Kept for older clients; same as deepgramConfigured. */
  readonly deepgramAvailable: boolean;
  readonly deepgramConfigured: boolean;
  readonly elevenlabsConfigured: boolean;
  readonly openaiConfigured: boolean;
}
