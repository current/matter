import {
  DEFAULT_VOICE_ASSISTANT_SETTINGS,
  type VoiceAssistantSettings,
  type VoiceAssistantToolResult,
} from "../voice-assistant/types.ts";

export const ISLAND_SNAPSHOT_CHANNEL = "desktop:island-snapshot";
export const ISLAND_ACTION_CHANNEL = "desktop:island-action";
export const ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL = "desktop:island-set-mouse-passthrough";
export const ISLAND_FOCUS_WINDOW_CHANNEL = "desktop:island-focus-window";
export const ISLAND_EXPAND_REQUEST_CHANNEL = "desktop:island-expand-request";
export const ISLAND_CONTEXT_MENU_CHANNEL = "desktop:island-context-menu";

export interface IslandWindowCommand {
  readonly type: "toggle-voice-panel" | "open-voice-panel" | "close-panel";
  readonly startVoice?: boolean;
}

export type IslandShortcutMode = "control" | "option" | "command-shift-space" | "off";

export type IslandVoicePanelMode = "smart" | "assistant" | "dictation" | "voice-mode";

export interface IslandSettings {
  readonly enabled: boolean;
  readonly shortcut: IslandShortcutMode;
  readonly showNotifications: boolean;
  readonly showMessages: boolean;
  readonly voiceAssistant: VoiceAssistantSettings;
}

export const DEFAULT_ISLAND_SETTINGS: IslandSettings = {
  enabled: true,
  shortcut: "control",
  showNotifications: true,
  showMessages: true,
  voiceAssistant: DEFAULT_VOICE_ASSISTANT_SETTINGS,
};

export interface IslandApprovalOption {
  readonly decision: "accept" | "acceptAlways" | "acceptForSession" | "decline" | "cancel";
  readonly label: string;
  readonly warning?: string | undefined;
}

export interface IslandPendingApproval {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly requestId: string;
  readonly requestKind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly reason: string | null;
  readonly canRespond: boolean;
  readonly options: ReadonlyArray<IslandApprovalOption>;
}

export interface IslandUserInputOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string | undefined;
}

export interface IslandUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly allowCustomAnswer: boolean;
  readonly options: ReadonlyArray<IslandUserInputOption>;
}

export interface IslandPendingUserInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly requestId: string;
  readonly dismissible: boolean;
  readonly canRespond: boolean;
  readonly questions: ReadonlyArray<IslandUserInputQuestion>;
}

export interface IslandDoneNotification {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly completedAt: number;
}

export interface IslandThreadSummary {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly status: "running" | "approval" | "input" | "done" | "failed" | "limited" | "idle";
  readonly updatedAt: string;
  readonly latestUserMessage: string | null;
  readonly latestAssistantMessage: string | null;
  readonly toolCallCount: number;
  readonly isStreaming: boolean;
}

export interface IslandVoiceState {
  readonly phase: "idle" | "preparing" | "recording" | "transcribing" | "post-processing" | "error";
  readonly level: number;
  readonly previewCommitted: string;
  readonly previewTentative: string;
  readonly draftText: string;
  readonly error: string | null;
  readonly available: boolean;
}

export interface IslandVoiceAssistantTurn {
  readonly id: string;
  readonly role: "user" | "assistant" | "briefing";
  readonly text: string;
  readonly toolResults?: ReadonlyArray<VoiceAssistantToolResult> | undefined;
  readonly timestamp: number;
}

export interface IslandVoiceAssistantState {
  readonly mode: IslandVoicePanelMode;
  readonly phase:
    | "idle"
    | "listening"
    | "transcribing"
    | "thinking"
    | "acting"
    | "speaking"
    | "error";
  readonly handsFreeActive: boolean;
  readonly muted: boolean;
  readonly speaking: boolean;
  readonly outputLevel: number;
  readonly liveTranscript: string;
  readonly statusLabel: string | null;
  readonly lastReply: string | null;
  readonly lastToolResults: ReadonlyArray<VoiceAssistantToolResult>;
  readonly recentTurns: ReadonlyArray<IslandVoiceAssistantTurn>;
  readonly activeBriefingLabel: string | null;
  readonly pendingBriefingCount: number;
  readonly error: string | null;
}

export interface IslandSnapshot {
  readonly theme: "dark" | "light";
  readonly mainWindowFocused: boolean;
  readonly settings: IslandSettings;
  readonly doneNotifications: ReadonlyArray<IslandDoneNotification>;
  readonly pendingApprovals: ReadonlyArray<IslandPendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<IslandPendingUserInput>;
  readonly recentThreads: ReadonlyArray<IslandThreadSummary>;
  readonly selectedThreadKey: string | null;
  readonly voice: IslandVoiceState;
  readonly assistant: IslandVoiceAssistantState;
}

export type IslandAction =
  | { readonly type: "open-thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly type: "select-thread"; readonly threadKey: string }
  | {
      readonly type: "send-reply";
      readonly environmentId: string;
      readonly threadId: string;
      readonly text: string;
    }
  | {
      readonly type: "respond-approval";
      readonly environmentId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: "accept" | "acceptAlways" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      readonly type: "respond-user-input";
      readonly environmentId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly answers: Record<string, string | ReadonlyArray<string>>;
    }
  | {
      readonly type: "dismiss-user-input";
      readonly environmentId: string;
      readonly threadId: string;
      readonly requestId: string;
    }
  | { readonly type: "dismiss-done"; readonly key?: string }
  | { readonly type: "voice-toggle" }
  | { readonly type: "voice-start" }
  | { readonly type: "voice-stop" }
  | { readonly type: "voice-cancel" }
  | { readonly type: "update-draft"; readonly text: string }
  | { readonly type: "assistant-set-mode"; readonly mode: IslandVoicePanelMode }
  | { readonly type: "assistant-submit-text"; readonly text: string }
  | { readonly type: "assistant-toggle-hands-free" }
  | { readonly type: "assistant-toggle-mute" }
  | { readonly type: "assistant-barge-in" }
  | { readonly type: "assistant-open-voice-mode-modal" }
  | { readonly type: "assistant-clear-history" }
  | { readonly type: "open-voice-settings" }
  | { readonly type: "open-island-settings" }
  | { readonly type: "close-panel" };

export interface DesktopIslandBridge {
  readonly syncSnapshot: (snapshot: IslandSnapshot) => Promise<void>;
  readonly updateSettings: (settings: IslandSettings) => Promise<void>;
  readonly openPanel: (options?: { readonly startVoice?: boolean }) => Promise<void>;
  readonly closePanel: () => Promise<void>;
  readonly onAction: (listener: (action: IslandAction) => void) => () => void;
}
