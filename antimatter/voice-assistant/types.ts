export type VoiceAssistantInteractionMode = "smart" | "assistant" | "dictation" | "voice-mode";

export type VoiceTtsProvider = "auto" | "openai" | "macos" | "browser" | "off";

export interface VoiceAssistantSettings {
  /** Default mode when opening voice in Island or Voice Mode. */
  readonly defaultMode: "smart" | "assistant" | "dictation";
  /** Speak assistant responses aloud automatically in assistant/voice mode. */
  readonly speakReplies: boolean;
  /** TTS engine preference. "auto" prefers OpenAI if key is configured, else macOS say, else browser speechSynthesis. */
  readonly ttsProvider: VoiceTtsProvider;
  /** Voice name (e.g. "coral", "nova", "alloy" for OpenAI; "Samantha" for macOS; or empty for default). */
  readonly ttsVoice: string;
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
}

export const DEFAULT_VOICE_ASSISTANT_SETTINGS: VoiceAssistantSettings = {
  defaultMode: "smart",
  speakReplies: true,
  ttsProvider: "auto",
  ttsVoice: "",
  ttsSpeed: 1.08,
  handsFreeAutoListen: true,
  bargeInEnabled: true,
  silenceTimeoutMs: 1150,
  proactiveBriefings: true,
  announceApprovals: true,
  announceQuestions: true,
  announceCompletions: true,
  announceFailures: true,
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

export interface VoiceWorkspaceQuestionSummary {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly requestId: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<string>;
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
  readonly speed?: number | undefined;
}

export interface VoiceAvailableTtsInfo {
  readonly openaiAvailable: boolean;
  readonly macosAvailable: boolean;
  readonly defaultProvider: Exclude<VoiceTtsProvider, "auto" | "off">;
  readonly openaiVoices: ReadonlyArray<string>;
  readonly macosVoices: ReadonlyArray<string>;
}
