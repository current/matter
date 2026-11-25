import { msg } from "gt-react";
import { useSyncExternalStore } from "react";
import { m } from "../i18n/messages";
import type {
  IslandVoiceAssistantState,
  IslandVoiceAssistantTurn,
  IslandVoicePanelMode,
} from "../../../../antimatter/island/types";
import type {
  VoiceAssistantClientAction,
  VoiceAssistantHistoryMessage,
  VoiceAssistantInteractionMode,
  VoiceAssistantToolResult,
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceBriefingKind,
  VoiceBriefingRequest,
  VoiceBriefingResponse,
  VoiceWorkspaceApprovalSummary,
  VoiceWorkspaceContext,
} from "../../../../antimatter/voice-assistant/types";
import { getIslandSettings } from "./islandSettingsStore";
import {
  createHandsFreeVadCapture,
  createVoiceTtsPlayer,
  type HandsFreeVadCapture,
  type VoiceTtsApiConfig,
  type VoiceTtsPlayer,
} from "./voiceModeAudio";

const MAX_RECENT_TURNS = 16;
const MAX_QUEUED_BRIEFINGS = 12;

export interface VoiceAssistantStoreState extends IslandVoiceAssistantState {
  readonly modalOpen: boolean;
  readonly inputLevel: number;
}

export interface VoiceAssistantHostBridge {
  readonly getWorkspaceContext: () => VoiceWorkspaceContext;
  readonly executeClientAction: (action: VoiceAssistantClientAction) => Promise<void> | void;
  readonly transcribePcm: (pcm16k: Float32Array, sampleRate: 16000) => Promise<string>;
  readonly getApiBaseUrlAndHeaders: () => Promise<VoiceTtsApiConfig> | VoiceTtsApiConfig;
  readonly getMicrophoneId?: () => Promise<string> | string;
  readonly fetchImpl?: typeof fetch;
  readonly createVadCapture?: typeof createHandsFreeVadCapture;
  readonly createTtsPlayer?: typeof createVoiceTtsPlayer;
}

export type FastPathIntent =
  | {
      readonly kind: "approval";
      readonly decision: "accept" | "acceptAlways" | "acceptForSession" | "decline";
      readonly approval: VoiceWorkspaceApprovalSummary;
      readonly action: Extract<VoiceAssistantClientAction, { readonly type: "respond-approval" }>;
      readonly spokenReply: string;
      readonly displayReply: string;
    }
  | {
      readonly kind: "pause-hands-free";
      readonly spokenReply: string;
      readonly displayReply: string;
    }
  | {
      readonly kind: "cancel-speech";
      readonly spokenReply: null;
      readonly displayReply: string;
    };

const BRIEFING_PRIORITY: Record<VoiceBriefingKind, number> = {
  approval: 4,
  question: 3,
  failed: 2,
  limited: 2,
  completed: 1,
};

const PAUSE_HANDS_FREE_PHRASES = new Set([
  "stop listening",
  "pause voice mode",
  "pause listening",
  "mute",
  "mute mic",
  "mute microphone",
  "turn off voice mode",
]);

const CANCEL_SPEECH_PHRASES = new Set([
  "cancel",
  "never mind",
  "nevermind",
  "stop talking",
  "stop speaking",
  "be quiet",
  "quiet",
]);

const ACCEPT_ONCE_PHRASES = new Set([
  "approve",
  "approve it",
  "approve once",
  "allow",
  "allow it",
  "allow once",
  "yes",
  "yes approve",
  "yes allow",
  "yeah",
  "yep",
  "go ahead",
  "proceed",
  "accept",
  "accept it",
]);

const ACCEPT_ALWAYS_PHRASES = new Set([
  "always allow",
  "always approve",
  "allow always",
  "approve always",
]);

const ACCEPT_SESSION_PHRASES = new Set([
  "allow for session",
  "allow this session",
  "allow for this session",
  "approve for session",
  "approve this session",
  "approve for this session",
]);

const DECLINE_PHRASES = new Set([
  "deny",
  "deny it",
  "reject",
  "reject it",
  "decline",
  "decline it",
  "no",
  "no deny",
  "nope",
  "don't allow",
  "dont allow",
  "do not allow",
  "block",
  "block it",
]);

function normalizeCommandPhrase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[.,!?;:"'()[\]\s]+|[.,!?;:"'()[\]\s]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(hey mattr|ok mattr|okay mattr|mattr)\s+/i, "")
    .replace(/\s+please$/i, "")
    .trim();
}

/**
 * Resolves high-confidence local voice commands (single pending approval,
 * pause/mute hands-free, cancel/stop speech) with zero LLM round-trip latency.
 */
export function tryFastPathIntent(
  utterance: string,
  context: Pick<VoiceWorkspaceContext, "pendingApprovals">,
): FastPathIntent | null {
  const normalized = normalizeCommandPhrase(utterance);
  if (!normalized) return null;

  if (PAUSE_HANDS_FREE_PHRASES.has(normalized)) {
    return {
      kind: "pause-hands-free",
      spokenReply: "Paused listening.",
      displayReply: "Paused voice mode.",
    };
  }

  if (CANCEL_SPEECH_PHRASES.has(normalized)) {
    return {
      kind: "cancel-speech",
      spokenReply: null,
      displayReply: "Cancelled.",
    };
  }

  if (context.pendingApprovals.length === 1) {
    const approval = context.pendingApprovals[0]!;
    let decision: "accept" | "acceptAlways" | "acceptForSession" | "decline" | null = null;
    let spokenReply = "";

    if (ACCEPT_SESSION_PHRASES.has(normalized)) {
      decision = "acceptForSession";
      spokenReply = "Approved for this session.";
    } else if (ACCEPT_ALWAYS_PHRASES.has(normalized)) {
      decision = "acceptAlways";
      spokenReply = "Always approved.";
    } else if (ACCEPT_ONCE_PHRASES.has(normalized)) {
      decision = "accept";
      spokenReply = "Approved.";
    } else if (DECLINE_PHRASES.has(normalized)) {
      decision = "decline";
      spokenReply = "Denied.";
    }

    if (decision !== null) {
      return {
        kind: "approval",
        decision,
        approval,
        action: {
          type: "respond-approval",
          environmentId: approval.environmentId,
          threadId: approval.threadId,
          requestId: approval.requestId,
          decision,
        },
        spokenReply,
        displayReply: `${spokenReply} (${approval.threadTitle})`,
      };
    }
  }

  return null;
}

function emptyWorkspaceContext(): VoiceWorkspaceContext {
  return {
    activeEnvironmentId: null,
    activeThreadId: null,
    activeRoute: null,
    mainWindowFocused: true,
    composerFocused: false,
    projects: [],
    threads: [],
    pendingApprovals: [],
    pendingQuestions: [],
  };
}

function createInitialState(): VoiceAssistantStoreState {
  return {
    mode: getIslandSettings().voiceAssistant.defaultMode,
    phase: "idle",
    handsFreeActive: false,
    muted: false,
    speaking: false,
    outputLevel: 0,
    inputLevel: 0,
    liveTranscript: "",
    statusLabel: null,
    lastReply: null,
    lastToolResults: [],
    recentTurns: [],
    activeBriefingLabel: null,
    pendingBriefingCount: 0,
    error: null,
    modalOpen: false,
  };
}

function nextTurnId(): string {
  turnSequence += 1;
  return `va-${Date.now()}-${turnSequence}`;
}

function fallbackBriefingResponse(req: VoiceBriefingRequest): VoiceBriefingResponse {
  const scope = req.projectTitle ? ` in ${req.projectTitle}` : "";
  switch (req.kind) {
    case "approval": {
      const detailSuffix = req.detail ? ` to run ${req.detail}` : "";
      return {
        spokenText: m(
          msg("{threadTitle}{scope} needs approval{detailSuffix}. Say approve or deny.", {
            threadTitle: req.threadTitle,
            scope,
            detailSuffix,
          }),
        ),
        shortLabel: m(msg("Approval: {threadTitle}", { threadTitle: req.threadTitle })),
        expectFollowUp: true,
      };
    }
    case "question": {
      const prompt = req.questionPrompts?.[0];
      const promptSuffix = prompt ? ` ${prompt}` : "";
      return {
        spokenText: m(
          msg("{threadTitle}{scope} has a question.{promptSuffix}", {
            threadTitle: req.threadTitle,
            scope,
            promptSuffix,
          }),
        ),
        shortLabel: m(msg("Question: {threadTitle}", { threadTitle: req.threadTitle })),
        expectFollowUp: true,
      };
    }
    case "failed": {
      const detailSuffix = req.detail ? ` ${req.detail}` : "";
      return {
        spokenText: m(
          msg("{threadTitle}{scope} failed.{detailSuffix}", {
            threadTitle: req.threadTitle,
            scope,
            detailSuffix,
          }),
        ),
        shortLabel: m(msg("Failed: {threadTitle}", { threadTitle: req.threadTitle })),
        expectFollowUp: false,
      };
    }
    case "limited":
      return {
        spokenText: m(
          msg("{threadTitle}{scope} hit a usage limit.", {
            threadTitle: req.threadTitle,
            scope,
          }),
        ),
        shortLabel: m(msg("Limit: {threadTitle}", { threadTitle: req.threadTitle })),
        expectFollowUp: false,
      };
    case "completed": {
      const total = req.count ?? 1;
      const extraCount = total - 1;
      return {
        spokenText:
          extraCount > 0
            ? m(
                msg("{threadTitle} and {extraCount} more{scope} finished.", {
                  threadTitle: req.threadTitle,
                  extraCount: String(extraCount),
                  scope,
                }),
              )
            : m(
                msg("{threadTitle}{scope} finished.", {
                  threadTitle: req.threadTitle,
                  scope,
                }),
              ),
        shortLabel:
          extraCount > 0
            ? m(msg("{count} threads finished", { count: String(total) }))
            : m(msg("Finished: {threadTitle}", { threadTitle: req.threadTitle })),
        expectFollowUp: false,
      };
    }
  }
}

interface QueuedBriefing {
  readonly request: VoiceBriefingRequest;
  readonly priority: number;
  readonly sequence: number;
}

let state: VoiceAssistantStoreState = createInitialState();
const listeners = new Set<() => void>();
let hostBridge: VoiceAssistantHostBridge | null = null;
let vadCapture: HandsFreeVadCapture | null = null;
let ttsPlayer: VoiceTtsPlayer | null = null;
let activeAbortController: AbortController | null = null;
let activeTurnCounter = 0;
let activeTurnRunning = false;
let activeBriefingRunning = false;
let userSpeaking = false;
let turnSequence = 0;
let briefingSequence = 0;
let briefingQueue: QueuedBriefing[] = [];

function emit(patch: Partial<VoiceAssistantStoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function appendTurn(turn: Omit<IslandVoiceAssistantTurn, "id" | "timestamp">): void {
  const entry: IslandVoiceAssistantTurn = {
    id: nextTurnId(),
    timestamp: Date.now(),
    ...turn,
  };
  const nextTurns = [...state.recentTurns, entry].slice(-MAX_RECENT_TURNS);
  emit({ recentTurns: nextTurns });
}

function getApiConfig(): Promise<VoiceTtsApiConfig> | VoiceTtsApiConfig {
  if (hostBridge) return hostBridge.getApiBaseUrlAndHeaders();
  return { baseUrl: "", headers: {}, credentials: "include" };
}

function getFetchImpl(): typeof fetch {
  return hostBridge?.fetchImpl ?? fetch;
}

function ensureTtsPlayer(): VoiceTtsPlayer {
  if (ttsPlayer) return ttsPlayer;
  const factory = hostBridge?.createTtsPlayer ?? createVoiceTtsPlayer;
  ttsPlayer = factory({
    getApiConfig,
    fetchImpl: getFetchImpl(),
    onOutputLevel: (level) => {
      if (state.outputLevel === level) return;
      emit({ outputLevel: level });
    },
    onSpeakingChange: (speaking) => {
      vadCapture?.setSpeakingDuck(speaking);
      if (state.speaking !== speaking) {
        emit({ speaking });
      }
    },
  });
  return ttsPlayer;
}

function idlePhaseForMode(): IslandVoiceAssistantState["phase"] {
  return state.handsFreeActive ? "listening" : "idle";
}

function buildHistoryForRequest(): ReadonlyArray<VoiceAssistantHistoryMessage> {
  return state.recentTurns.slice(-MAX_RECENT_TURNS).map((turn) => ({
    role: turn.role === "user" ? "user" : "assistant",
    text: turn.text,
    ...(turn.toolResults && turn.toolResults.length > 0
      ? { toolSummary: turn.toolResults.map((r) => `${r.tool}: ${r.summary}`).join("; ") }
      : {}),
  }));
}

function shouldSpeakReply(
  spokenReply: string,
  route: VoiceAssistantTurnResponse["route"],
  effectiveMode: VoiceAssistantInteractionMode,
  speakOverride?: boolean,
): boolean {
  if (!spokenReply.trim()) return false;
  const voiceSettings = getIslandSettings().voiceAssistant;
  if (voiceSettings.ttsProvider === "off") return false;
  if (speakOverride !== undefined) return speakOverride;
  if (route === "dictation") return false;
  return (
    effectiveMode === "voice-mode" || effectiveMode === "assistant" || voiceSettings.speakReplies
  );
}

async function speakText(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const voiceSettings = getIslandSettings().voiceAssistant;
  if (voiceSettings.ttsProvider === "off") return;

  const player = ensureTtsPlayer();
  emit({ phase: "speaking", speaking: true });
  vadCapture?.setSpeakingDuck(true);
  try {
    await player.speak({
      text: trimmed,
      provider: voiceSettings.ttsProvider,
      ...(voiceSettings.ttsVoice ? { voice: voiceSettings.ttsVoice } : {}),
      speed: voiceSettings.ttsSpeed,
    });
  } finally {
    vadCapture?.setSpeakingDuck(false);
    if (state.speaking || state.outputLevel !== 0) {
      emit({ speaking: false, outputLevel: 0 });
    }
  }
}

function canRunBriefingNow(): boolean {
  return (
    briefingQueue.length > 0 &&
    !activeTurnRunning &&
    !activeBriefingRunning &&
    !userSpeaking &&
    state.phase !== "transcribing" &&
    !state.speaking
  );
}

function sortBriefingQueue(): void {
  briefingQueue.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.sequence - b.sequence;
  });
}

async function drainBriefingQueue(): Promise<void> {
  if (!canRunBriefingNow()) return;

  const nextItem = briefingQueue.shift();
  if (!nextItem) return;

  activeBriefingRunning = true;
  const controller = new AbortController();
  activeAbortController = controller;

  emit({
    pendingBriefingCount: briefingQueue.length,
    activeBriefingLabel: `${nextItem.request.kind}: ${nextItem.request.threadTitle}`,
  });

  try {
    let briefingResponse: VoiceBriefingResponse;
    try {
      const apiConfig = await getApiConfig();
      const base = apiConfig.baseUrl.replace(/\/+$/, "");
      const response = await getFetchImpl()(`${base}/api/mattr/voice-assistant/briefing`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiConfig.headers,
        },
        credentials: apiConfig.credentials ?? "include",
        body: JSON.stringify(nextItem.request),
        signal: controller.signal,
      });
      if (response.ok) {
        briefingResponse = (await response.json()) as VoiceBriefingResponse;
      } else {
        briefingResponse = fallbackBriefingResponse(nextItem.request);
      }
    } catch {
      if (controller.signal.aborted) return;
      briefingResponse = fallbackBriefingResponse(nextItem.request);
    }

    if (controller.signal.aborted || userSpeaking || activeTurnRunning) return;

    appendTurn({
      role: "briefing",
      text: briefingResponse.spokenText,
    });
    emit({
      activeBriefingLabel: briefingResponse.shortLabel,
      lastReply: briefingResponse.spokenText,
      error: null,
    });

    await speakText(briefingResponse.spokenText);

    if (controller.signal.aborted) return;

    emit({
      activeBriefingLabel: null,
      phase: idlePhaseForMode(),
      statusLabel:
        briefingResponse.expectFollowUp && state.handsFreeActive
          ? m(msg("Listening for reply..."))
          : null,
    });
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    activeBriefingRunning = false;
    if (canRunBriefingNow()) {
      void drainBriefingQueue();
    }
  }
}

export function getVoiceAssistantState(): VoiceAssistantStoreState {
  return state;
}

export function toIslandVoiceAssistantState(
  current: VoiceAssistantStoreState = state,
): IslandVoiceAssistantState {
  return {
    mode: current.mode,
    phase: current.phase,
    handsFreeActive: current.handsFreeActive,
    muted: current.muted,
    speaking: current.speaking,
    outputLevel: current.outputLevel,
    liveTranscript: current.liveTranscript,
    statusLabel: current.statusLabel,
    lastReply: current.lastReply,
    lastToolResults: current.lastToolResults,
    recentTurns: current.recentTurns,
    activeBriefingLabel: current.activeBriefingLabel,
    pendingBriefingCount: current.pendingBriefingCount,
    error: current.error,
  };
}

function subscribeVoiceAssistantState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoiceAssistantState(): VoiceAssistantStoreState {
  return useSyncExternalStore(
    subscribeVoiceAssistantState,
    getVoiceAssistantState,
    getVoiceAssistantState,
  );
}

export function registerHostBridge(bridge: VoiceAssistantHostBridge): () => void {
  hostBridge = bridge;
  if (ttsPlayer) {
    ttsPlayer.stop();
    ttsPlayer = null;
  }
  return () => {
    if (hostBridge === bridge) {
      hostBridge = null;
      if (ttsPlayer) {
        ttsPlayer.stop();
        ttsPlayer = null;
      }
    }
  };
}

export function setVoiceAssistantMode(mode: IslandVoicePanelMode): void {
  if (state.mode === mode) return;
  emit({ mode });
}

export function setVoiceAssistantModalOpen(open: boolean): void {
  if (state.modalOpen === open) return;
  emit({ modalOpen: open });
}

export function clearVoiceAssistantHistory(): void {
  emit({
    recentTurns: [],
    lastReply: null,
    lastToolResults: [],
    liveTranscript: "",
    error: null,
  });
}

export function bargeInVoiceAssistant(): void {
  ttsPlayer?.stop();
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  activeTurnCounter += 1;
  activeTurnRunning = false;
  activeBriefingRunning = false;
  vadCapture?.setSpeakingDuck(false);
  emit({
    speaking: false,
    outputLevel: 0,
    activeBriefingLabel: null,
    statusLabel: null,
    phase: idlePhaseForMode(),
  });
}

export function toggleVoiceAssistantMute(): void {
  const nextMuted = !state.muted;
  vadCapture?.setMuted(nextMuted);
  if (nextMuted) userSpeaking = false;
  emit({
    muted: nextMuted,
    ...(nextMuted ? { inputLevel: 0 } : {}),
  });
}

async function startHandsFree(): Promise<void> {
  if (state.handsFreeActive && vadCapture?.isActive()) return;

  const factory = hostBridge?.createVadCapture ?? createHandsFreeVadCapture;
  vadCapture?.stop();

  const capture = factory({
    ...(hostBridge?.getMicrophoneId ? { getMicrophoneId: hostBridge.getMicrophoneId } : {}),
    getSilenceTimeoutMs: () => getIslandSettings().voiceAssistant.silenceTimeoutMs,
    onLevel: (level) => {
      if (state.inputLevel === level) return;
      emit({ inputLevel: level });
    },
    onSpeechStart: () => {
      userSpeaking = true;
      if (state.speaking && getIslandSettings().voiceAssistant.bargeInEnabled) {
        bargeInVoiceAssistant();
      }
      if (state.phase === "idle" || state.phase === "listening") {
        emit({ phase: "listening", statusLabel: m(msg("Listening...")) });
      }
    },
    onUtterance: (pcm16k, sampleRate) => {
      userSpeaking = false;
      if (!state.handsFreeActive || state.muted) return;
      void handleCapturedUtterance(pcm16k, sampleRate);
    },
    onError: (message) => {
      userSpeaking = false;
      vadCapture = null;
      emit({
        handsFreeActive: false,
        inputLevel: 0,
        phase: "error",
        statusLabel: null,
        error: message,
      });
    },
  });

  vadCapture = capture;
  emit({
    handsFreeActive: true,
    muted: false,
    mode: "voice-mode",
    phase: "listening",
    statusLabel: m(msg("Listening...")),
    error: null,
  });

  try {
    await capture.start();
    if (vadCapture !== capture) {
      capture.stop();
    }
  } catch (error) {
    if (vadCapture === capture) {
      vadCapture = null;
      emit({
        handsFreeActive: false,
        inputLevel: 0,
        phase: "error",
        statusLabel: null,
        error:
          error instanceof Error && error.message
            ? error.message
            : m(msg("Could not start hands-free voice mode.")),
      });
    }
  }
}

function stopHandsFree(): void {
  userSpeaking = false;
  if (vadCapture) {
    vadCapture.stop();
    vadCapture = null;
  }
  ttsPlayer?.stop();
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  activeTurnCounter += 1;
  activeTurnRunning = false;
  activeBriefingRunning = false;

  const nextMode =
    state.mode === "voice-mode" ? getIslandSettings().voiceAssistant.defaultMode : state.mode;

  emit({
    handsFreeActive: false,
    muted: false,
    speaking: false,
    outputLevel: 0,
    inputLevel: 0,
    mode: nextMode,
    phase: "idle",
    statusLabel: null,
    activeBriefingLabel: null,
  });
}

export function toggleVoiceAssistantHandsFree(): void {
  if (state.handsFreeActive) {
    stopHandsFree();
  } else {
    void startHandsFree();
  }
}

async function handleCapturedUtterance(pcm16k: Float32Array, sampleRate: 16000): Promise<void> {
  if (!hostBridge) {
    emit({
      phase: "error",
      statusLabel: null,
      error: m(msg("Voice transcription bridge is not connected.")),
    });
    return;
  }

  emit({ phase: "transcribing", statusLabel: m(msg("Transcribing...")), error: null });
  try {
    const transcript = (await hostBridge.transcribePcm(pcm16k, sampleRate)).trim();
    if (!state.handsFreeActive) return;
    if (!transcript) {
      emit({ phase: "listening", statusLabel: null });
      void drainBriefingQueue();
      return;
    }
    await submitVoiceAssistantUtterance(transcript, { modeOverride: "voice-mode" });
  } catch (error) {
    if (!state.handsFreeActive) return;
    emit({
      phase: "error",
      statusLabel: null,
      error:
        error instanceof Error && error.message
          ? error.message
          : m(msg("Could not transcribe audio.")),
    });
  }
}

export async function submitVoiceAssistantUtterance(
  text: string,
  options?: {
    readonly modeOverride?: VoiceAssistantInteractionMode;
    readonly speakOverride?: boolean;
  },
): Promise<VoiceAssistantTurnResponse | null> {
  const utterance = text.trim();
  if (!utterance) return null;

  ttsPlayer?.stop();
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  const turnId = ++activeTurnCounter;
  activeTurnRunning = true;
  activeBriefingRunning = false;

  const context = hostBridge ? hostBridge.getWorkspaceContext() : emptyWorkspaceContext();
  const effectiveMode: VoiceAssistantInteractionMode =
    options?.modeOverride ?? (state.handsFreeActive ? "voice-mode" : state.mode);

  const fastPath =
    effectiveMode === "dictation" && !state.handsFreeActive
      ? null
      : tryFastPathIntent(utterance, context);

  if (fastPath) {
    if (fastPath.kind === "pause-hands-free") {
      activeTurnRunning = false;
      stopHandsFree();
      emit({ lastReply: fastPath.displayReply, liveTranscript: utterance });
      return {
        route: "direct-reply",
        spokenReply: fastPath.spokenReply,
        displayReply: fastPath.displayReply,
        expectFollowUp: false,
        toolResults: [],
        clientActions: [],
      };
    }

    if (fastPath.kind === "cancel-speech") {
      activeTurnRunning = false;
      bargeInVoiceAssistant();
      emit({ lastReply: fastPath.displayReply, liveTranscript: utterance });
      return {
        route: "direct-reply",
        spokenReply: "",
        displayReply: fastPath.displayReply,
        expectFollowUp: false,
        toolResults: [],
        clientActions: [],
      };
    }

    appendTurn({ role: "user", text: utterance });
    emit({
      phase: "acting",
      liveTranscript: utterance,
      statusLabel: m(msg("Applying approval...")),
      error: null,
    });

    try {
      await hostBridge?.executeClientAction(fastPath.action);
      if (turnId !== activeTurnCounter) return null;

      const toolResult: VoiceAssistantToolResult = {
        tool: "respond_approval",
        ok: true,
        summary: fastPath.displayReply,
        environmentId: fastPath.approval.environmentId,
        threadId: fastPath.approval.threadId,
      };
      const syntheticResponse: VoiceAssistantTurnResponse = {
        route: "approval",
        spokenReply: fastPath.spokenReply,
        displayReply: fastPath.displayReply,
        expectFollowUp: false,
        toolResults: [toolResult],
        clientActions: [fastPath.action],
      };

      appendTurn({
        role: "assistant",
        text: fastPath.displayReply,
        toolResults: [toolResult],
      });
      emit({
        lastReply: fastPath.displayReply,
        lastToolResults: [toolResult],
        statusLabel: null,
      });

      if (
        shouldSpeakReply(fastPath.spokenReply, "approval", effectiveMode, options?.speakOverride)
      ) {
        await speakText(fastPath.spokenReply);
      }
      if (turnId !== activeTurnCounter) return syntheticResponse;

      emit({ phase: idlePhaseForMode(), statusLabel: null });
      return syntheticResponse;
    } catch (error) {
      if (turnId !== activeTurnCounter) return null;
      const message =
        error instanceof Error && error.message ? error.message : "Failed to apply approval.";
      emit({ phase: "error", statusLabel: null, error: message });
      return null;
    } finally {
      if (turnId === activeTurnCounter) {
        activeTurnRunning = false;
        void drainBriefingQueue();
      }
    }
  }

  const history = buildHistoryForRequest();
  appendTurn({ role: "user", text: utterance });
  emit({
    phase: "thinking",
    liveTranscript: utterance,
    statusLabel: m(msg("Thinking...")),
    error: null,
  });

  const controller = new AbortController();
  activeAbortController = controller;

  try {
    const apiConfig = await getApiConfig();
    const base = apiConfig.baseUrl.replace(/\/+$/, "");
    const payload: VoiceAssistantTurnRequest = {
      utterance,
      mode: effectiveMode,
      history,
      context,
    };
    const response = await getFetchImpl()(`${base}/api/mattr/voice-assistant/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...apiConfig.headers,
      },
      credentials: apiConfig.credentials ?? "include",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(errorText || `Voice assistant request failed (${response.status}).`);
    }

    const turnResult = (await response.json()) as VoiceAssistantTurnResponse;
    if (turnId !== activeTurnCounter || controller.signal.aborted) return null;

    if (turnResult.clientActions.length > 0) {
      emit({ phase: "acting", statusLabel: m(msg("Running actions...")) });
      for (const action of turnResult.clientActions) {
        if (turnId !== activeTurnCounter || controller.signal.aborted) return null;
        await hostBridge?.executeClientAction(action);
      }
    }

    if (turnId !== activeTurnCounter || controller.signal.aborted) return null;

    const replyText = turnResult.displayReply || turnResult.spokenReply;
    if (replyText || turnResult.toolResults.length > 0) {
      appendTurn({
        role: "assistant",
        text: replyText,
        ...(turnResult.toolResults.length > 0 ? { toolResults: turnResult.toolResults } : {}),
      });
    }

    emit({
      lastReply: replyText || state.lastReply,
      lastToolResults: turnResult.toolResults,
      statusLabel: null,
      error: null,
    });

    if (
      shouldSpeakReply(
        turnResult.spokenReply,
        turnResult.route,
        effectiveMode,
        options?.speakOverride,
      )
    ) {
      await speakText(turnResult.spokenReply);
    }

    if (turnId !== activeTurnCounter || controller.signal.aborted) return turnResult;

    emit({
      phase: idlePhaseForMode(),
      statusLabel:
        turnResult.expectFollowUp && state.handsFreeActive
          ? m(msg("Listening for follow-up..."))
          : null,
    });
    return turnResult;
  } catch (error) {
    if (controller.signal.aborted || turnId !== activeTurnCounter) return null;
    const message =
      error instanceof Error && error.message ? error.message : "Voice assistant request failed.";
    emit({ phase: "error", statusLabel: null, error: message });
    return null;
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    if (turnId === activeTurnCounter) {
      activeTurnRunning = false;
      void drainBriefingQueue();
    }
  }
}

export function submitQuickBriefing(req: VoiceBriefingRequest): void {
  const entry: QueuedBriefing = {
    request: req,
    priority: BRIEFING_PRIORITY[req.kind] ?? 1,
    sequence: ++briefingSequence,
  };
  briefingQueue.push(entry);
  sortBriefingQueue();
  if (briefingQueue.length > MAX_QUEUED_BRIEFINGS) {
    briefingQueue = briefingQueue.slice(0, MAX_QUEUED_BRIEFINGS);
  }
  emit({ pendingBriefingCount: briefingQueue.length });
  if (canRunBriefingNow()) {
    void drainBriefingQueue();
  }
}

/** Resets module-level store state cleanly between unit tests. */
export function resetVoiceAssistantStoreForTests(): void {
  stopHandsFree();
  briefingQueue = [];
  briefingSequence = 0;
  turnSequence = 0;
  activeTurnCounter = 0;
  activeTurnRunning = false;
  activeBriefingRunning = false;
  userSpeaking = false;
  hostBridge = null;
  if (ttsPlayer) {
    ttsPlayer.stop();
    ttsPlayer = null;
  }
  state = createInitialState();
  for (const listener of listeners) listener();
}
