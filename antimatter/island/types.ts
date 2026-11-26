import {
  DEFAULT_VOICE_ASSISTANT_SETTINGS,
  type VoiceAssistantSettings,
  type VoiceAssistantToolResult,
} from "../voice-assistant/types.ts";

export const ISLAND_SNAPSHOT_CHANNEL = "desktop:island-snapshot";
export const ISLAND_ACTION_CHANNEL = "desktop:island-action";
export const ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL = "desktop:island-set-mouse-passthrough";
export const ISLAND_FOCUS_WINDOW_CHANNEL = "desktop:island-focus-window";
export const ISLAND_RELEASE_FOCUS_CHANNEL = "desktop:island-release-focus";
export const ISLAND_EXPAND_REQUEST_CHANNEL = "desktop:island-expand-request";
export const ISLAND_CONTEXT_MENU_CHANNEL = "desktop:island-context-menu";
export const ISLAND_DISPLAY_METRICS_CHANNEL = "desktop:island-display-metrics";
export const ISLAND_ANIMATION_IDLE_CHANNEL = "desktop:island-animation-idle";

export interface IslandDisplayMetrics {
  readonly hasNotch: boolean;
  readonly notchWidth: number;
  readonly notchHeight: number;
  readonly windowWidth: number;
}

/** Main process → island renderer. */
export type IslandWindowCommand =
  | { readonly type: "open"; readonly reason: "click" | "shortcut" | "settings" }
  | { readonly type: "close-panel" }
  | { readonly type: "dictation-hold"; readonly phase: ComposerDictationHoldPhase }
  /** A drag from any app is near (or left) the notch; the window accepts drops meanwhile. */
  | { readonly type: "drag"; readonly phase: "near" | "away" | "end" };

export type IslandShortcutMode = "control" | "option" | "command-shift-space" | "off";

export type IslandVoicePanelMode = "smart" | "assistant" | "dictation" | "voice-mode";

export interface IslandSettings {
  readonly enabled: boolean;
  readonly shortcut: IslandShortcutMode;
  /** Status wings and the needs-you auto-peek; off leaves only the shortcut and click. */
  readonly showNotifications: boolean;
  readonly voiceAssistant: VoiceAssistantSettings;
}

export const DEFAULT_ISLAND_SETTINGS: IslandSettings = {
  enabled: true,
  shortcut: "control",
  showNotifications: true,
  voiceAssistant: DEFAULT_VOICE_ASSISTANT_SETTINGS,
};

export interface IslandApprovalOption {
  readonly decision: IslandApprovalDecision;
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
  /** Local clock (Date.now) when the run ended. */
  readonly completedAt: number;
  readonly outcome: "completed" | "failed" | "limited";
}

export type IslandActivityKind = "command" | "edit" | "read" | "search" | "web" | "tool" | "agent";

export interface IslandActivity {
  readonly kind: IslandActivityKind;
  readonly label: string;
  readonly running: boolean;
}

export interface IslandPlanProgress {
  readonly completed: number;
  readonly total: number;
  readonly currentStep: string | null;
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
  readonly providerInstanceId: string;
  /** Driver kind (`claudeAgent`, `codex`, …) picks the wing glyph; null when unknown. */
  readonly providerKind: string | null;
  readonly providerName: string | null;
  readonly model: string | null;
  readonly branch: string | null;
  /** ISO start of the active run, or of the latest run once it has finished. */
  readonly runStartedAt: string | null;
  readonly runCompletedAt: string | null;
  readonly currentActivity: IslandActivity | null;
  /** Newest first, excluding `currentActivity`. */
  readonly recentActivities: ReadonlyArray<IslandActivity>;
  readonly plan: IslandPlanProgress | null;
}

export interface IslandVoiceState {
  readonly phase: "idle" | "preparing" | "recording" | "transcribing" | "post-processing" | "error";
  readonly level: number;
  readonly previewCommitted: string;
  readonly previewTentative: string;
  readonly draftText: string;
  /** Bumps when dictation (not typing) rewrites `draftText`. */
  readonly draftRevision: number;
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

export interface IslandPendingPlan {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly planId: string;
  readonly title: string | null;
  /** First to-dos, already stripped of markdown. */
  readonly steps: ReadonlyArray<string>;
  readonly stepCount: number;
  readonly canApprove: boolean;
}

export interface IslandSnapshot {
  readonly theme: "dark" | "light";
  readonly mainWindowFocused: boolean;
  readonly settings: IslandSettings;
  readonly doneNotifications: ReadonlyArray<IslandDoneNotification>;
  readonly pendingApprovals: ReadonlyArray<IslandPendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<IslandPendingUserInput>;
  readonly pendingPlans: ReadonlyArray<IslandPendingPlan>;
  readonly recentThreads: ReadonlyArray<IslandThreadSummary>;
  /** The thread the composer sends to by default (routed thread, else the newest). */
  readonly selectedThreadKey: string | null;
  /** Whether "New thread" has a project to start in. */
  readonly canStartThread: boolean;
  readonly canCreateTask: boolean;
  readonly voice: IslandVoiceState;
  readonly assistant: IslandVoiceAssistantState;
}

export type IslandCaptureTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "new-thread" }
  | { readonly kind: "task" };

export interface IslandDroppedFile {
  readonly name: string;
  /** Absolute path on this Mac, from the preload's `webUtils.getPathForFile`. */
  readonly path: string;
}

export type IslandApprovalDecision =
  | "accept"
  | "acceptAlways"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type IslandAction =
  | { readonly type: "open-thread"; readonly environmentId: string; readonly threadId: string }
  | {
      readonly type: "submit-capture";
      readonly target: IslandCaptureTarget;
      readonly text: string;
      readonly interactionMode: "default" | "plan" | "goal";
      readonly files: ReadonlyArray<IslandDroppedFile>;
      readonly urls: ReadonlyArray<string>;
    }
  | {
      readonly type: "respond-approval";
      readonly environmentId: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: IslandApprovalDecision;
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
  | {
      readonly type: "approve-plan";
      readonly environmentId: string;
      readonly threadId: string;
      readonly planId: string;
    }
  | { readonly type: "dismiss-done"; readonly key?: string }
  | { readonly type: "voice-start" }
  | { readonly type: "voice-stop" }
  | { readonly type: "voice-cancel" }
  | { readonly type: "update-draft"; readonly text: string }
  | { readonly type: "assistant-open-voice-mode-modal" }
  | { readonly type: "open-voice-settings" }
  | { readonly type: "open-island-settings" }
  | { readonly type: "close-panel" }
  | {
      readonly type: "composer-dictation-hold";
      readonly phase: ComposerDictationHoldPhase;
    };

export type ComposerDictationHoldPhase = "start" | "end" | "cancel";

export interface DesktopIslandBridge {
  readonly syncSnapshot: (snapshot: IslandSnapshot) => Promise<void>;
  readonly updateSettings: (settings: IslandSettings) => Promise<void>;
  readonly openPanel: (options?: { readonly startVoice?: boolean }) => Promise<void>;
  readonly closePanel: () => Promise<void>;
  readonly onAction: (listener: (action: IslandAction) => void) => () => void;
}
