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
  VoiceServerTtsPreferences,
  VoiceSpeakRequest,
  VoiceAssistantSettings,
  VoiceWorkspaceApprovalSummary,
  VoiceWorkspaceContext,
} from "../../../../antimatter/voice-assistant/types";
import { getIslandSettings } from "./islandSettingsStore";
import { playMattrAudioCue } from "../speech/mattrAudioCues";
import {
  createDeepgramFluxCapture,
  createHandsFreeVadCapture,
  createVoiceTtsPlayer,
  type HandsFreeVadCapture,
  type VoiceTtsApiConfig,
  type VoiceTtsPlayer,
} from "./voiceModeAudio";

const MAX_RECENT_TURNS = 16;
const MAX_QUEUED_BRIEFINGS = 12;

export interface VoiceAssistantThreadScope {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export interface VoiceAssistantStoreState extends IslandVoiceAssistantState {
  readonly sessionOpen: boolean;
  readonly inputLevel: number;
  /** Active thread when Voice Mode is launched from inside a thread; null means all workspace. */
  readonly scopedThread: VoiceAssistantThreadScope | null;
  /** Thread that opened the current Voice Mode session, so switching to All workspace is reversible. */
  readonly originThread: VoiceAssistantThreadScope | null;
}

export interface VoiceAssistantHostBridge {
  readonly getWorkspaceContext: () => VoiceWorkspaceContext;
  readonly executeClientAction: (action: VoiceAssistantClientAction) => Promise<void> | void;
  readonly transcribePcm: (pcm16k: Float32Array, sampleRate: 16000) => Promise<string>;
  readonly getApiBaseUrlAndHeaders: () => Promise<VoiceTtsApiConfig> | VoiceTtsApiConfig;
  readonly getMicrophoneId?: () => Promise<string> | string;
  readonly fetchImpl?: typeof fetch;
  readonly createVadCapture?: typeof createHandsFreeVadCapture;
  readonly createFluxCapture?: typeof createDeepgramFluxCapture;
  readonly createTtsPlayer?: typeof createVoiceTtsPlayer;
  readonly createChunkPlayer?: (options: VoiceChunkPlayerOptions) => VoiceChunkPlayer;
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
    sessionOpen: false,
    scopedThread: null,
    originThread: null,
  };
}

/**
 * Applies an explicit in-thread Voice Mode scope onto a workspace snapshot so the server always
 * sees the scoped thread as primary context (even when older than the recent-threads window).
 */
export function applyThreadScopeToWorkspaceContext(
  context: VoiceWorkspaceContext,
  scopedThread: VoiceAssistantThreadScope | null,
): VoiceWorkspaceContext {
  if (!scopedThread) return context;
  const matchesScope = (thread: VoiceWorkspaceContext["threads"][number]) =>
    thread.environmentId === scopedThread.environmentId &&
    thread.threadId === scopedThread.threadId;
  const hasScopedThread = context.threads.some(matchesScope);
  const threads = hasScopedThread
    ? context.threads.map((thread) => ({ ...thread, isActive: matchesScope(thread) }))
    : [
        {
          environmentId: scopedThread.environmentId,
          threadId: scopedThread.threadId,
          title: scopedThread.title,
          projectId: null,
          projectTitle: null,
          status: "idle" as const,
          updatedAt: new Date().toISOString(),
          latestUserMessage: null,
          latestAssistantMessage: null,
          isActive: true,
        },
        ...context.threads.map((thread) => ({ ...thread, isActive: false })),
      ];
  return {
    ...context,
    activeEnvironmentId: scopedThread.environmentId,
    activeThreadId: scopedThread.threadId,
    threads,
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
let activeReply: VoiceChunkPlayer | null = null;
let replyHoldTimer: ReturnType<typeof setTimeout> | null = null;
let turnStreamUnsupported = false;

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

/** Provider-specific speak fields: ElevenLabs uses its own voice id, model, and voice settings. */
export function buildVoiceSpeakOptions(
  settings: VoiceAssistantSettings,
): Omit<VoiceSpeakRequest, "text"> {
  const elevenlabsVoiceSettings = {
    stability: settings.elevenlabsStability,
    similarityBoost: settings.elevenlabsSimilarityBoost,
    style: settings.elevenlabsStyle,
    speed: settings.elevenlabsSpeed,
    useSpeakerBoost: settings.elevenlabsUseSpeakerBoost,
  };
  if (settings.ttsProvider === "elevenlabs") {
    return {
      provider: "elevenlabs",
      voice: settings.elevenlabsCustomVoiceId || settings.elevenlabsVoice,
      model: settings.elevenlabsModel,
      speed: settings.ttsSpeed,
      elevenlabsVoiceSettings,
    };
  }
  return {
    provider: settings.ttsProvider,
    ...(settings.ttsVoice ? { voice: settings.ttsVoice } : {}),
    ...(settings.ttsProvider === "auto"
      ? { model: settings.elevenlabsModel, elevenlabsVoiceSettings }
      : {}),
    speed: settings.ttsSpeed,
  };
}

/**
 * Server defaults for clients that send no provider (the iPhone app). The Deepgram voice is
 * only sent when ttsVoice is a Deepgram voice, so an OpenAI or macOS pick doesn't clear it.
 */
export function buildServerTtsPreferences(
  settings: VoiceAssistantSettings,
): Partial<VoiceServerTtsPreferences> {
  const deepgramVoice =
    settings.ttsProvider === "auto" || settings.ttsProvider === "deepgram"
      ? settings.ttsVoice.startsWith("aura-2-") || settings.ttsVoice === ""
        ? { deepgramVoice: settings.ttsVoice }
        : {}
      : {};
  return {
    ttsProvider: settings.ttsProvider,
    elevenlabsModel: settings.elevenlabsModel,
    elevenlabsVoice: settings.elevenlabsVoice,
    customVoiceId: settings.elevenlabsCustomVoiceId,
    stability: settings.elevenlabsStability,
    similarityBoost: settings.elevenlabsSimilarityBoost,
    style: settings.elevenlabsStyle,
    speed: settings.elevenlabsSpeed,
    useSpeakerBoost: settings.elevenlabsUseSpeakerBoost,
    ...deepgramVoice,
  };
}

export async function syncVoiceTtsPreferencesToServer(
  apiConfig: VoiceTtsApiConfig,
  settings: VoiceAssistantSettings = getIslandSettings().voiceAssistant,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceServerTtsPreferences | null> {
  try {
    const base = apiConfig.baseUrl.replace(/\/+$/, "");
    const response = await fetchImpl(`${base}/api/mattr/voice-assistant/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiConfig.headers },
      credentials: apiConfig.credentials ?? "include",
      body: JSON.stringify(buildServerTtsPreferences(settings)),
    });
    if (!response.ok) return null;
    return (await response.json()) as VoiceServerTtsPreferences;
  } catch {
    return null;
  }
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
    await player.speak({ text: trimmed, ...buildVoiceSpeakOptions(voiceSettings) });
  } finally {
    vadCapture?.setSpeakingDuck(false);
    if (state.speaking || state.outputLevel !== 0) {
      emit({ speaking: false, outputLevel: 0 });
    }
  }
}

/** One line of the server's `/turn-stream` NDJSON, mirrored from `apps/server/src/voiceAssistant`. */
type VoiceTurnStreamEvent =
  | {
      readonly type: "tool_result";
      readonly toolCalls: ReadonlyArray<VoiceAssistantToolResult>;
      readonly actions: ReadonlyArray<VoiceAssistantClientAction>;
    }
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "audio_chunk";
      readonly seq: number;
      readonly text: string;
      readonly contentType: string;
      readonly audioBase64: string;
    }
  | {
      readonly type: "done";
      readonly reply: string;
      readonly displayReply: string;
      readonly route: VoiceAssistantTurnResponse["route"];
      readonly expectFollowUp: boolean;
      readonly actions: ReadonlyArray<VoiceAssistantClientAction>;
      readonly toolCalls: ReadonlyArray<VoiceAssistantToolResult>;
    }
  | { readonly type: "error"; readonly message: string };

const TURN_STREAM_EVENT_TYPES = new Set([
  "tool_result",
  "text_delta",
  "audio_chunk",
  "done",
  "error",
]);

function parseTurnStreamLine(line: string): VoiceTurnStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      TURN_STREAM_EVENT_TYPES.has((parsed as { readonly type?: unknown }).type as string)
    ) {
      return parsed as VoiceTurnStreamEvent;
    }
  } catch {}
  return null;
}

function decodeBase64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Plays streamed reply sentences back to back; `done` settles once `end()`ed audio drains. */
export interface VoiceChunkPlayer {
  readonly done: Promise<"finished" | "stopped">;
  enqueue(bytes: Uint8Array, contentType: string): void;
  end(): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface VoiceChunkPlayerOptions {
  readonly onOutputLevel: (level: number) => void;
}

/** Decodes each sentence as it arrives and schedules it right after the previous one. */
function createWebAudioChunkPlayer(options: VoiceChunkPlayerOptions): VoiceChunkPlayer {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.connect(ctx.destination);
  const timeData = new Uint8Array(analyser.fftSize);
  const sources = new Set<AudioBufferSourceNode>();
  let chain: Promise<void> = Promise.resolve();
  let nextStart = 0;
  let drained = false;
  let settled = false;
  let meter: ReturnType<typeof setInterval> | null = null;
  const { promise: done, resolve } = Promise.withResolvers<"finished" | "stopped">();

  const settle = (outcome: "finished" | "stopped") => {
    if (settled) return;
    settled = true;
    if (meter !== null) clearInterval(meter);
    meter = null;
    options.onOutputLevel(0);
    void ctx.close().catch(() => undefined);
    resolve(outcome);
  };
  const maybeFinish = () => {
    if (drained && sources.size === 0) settle("finished");
  };
  const startMeter = () => {
    if (meter !== null) return;
    let smoothed = 0;
    meter = setInterval(() => {
      analyser.getByteTimeDomainData(timeData);
      let energy = 0;
      for (const sample of timeData) energy += ((sample - 128) / 128) ** 2;
      smoothed = smoothed * 0.6 + Math.min(1, Math.sqrt(energy / timeData.length) * 3.8) * 0.4;
      options.onOutputLevel(smoothed);
    }, 50);
  };

  return {
    done,
    enqueue(bytes) {
      if (settled || drained) return;
      const decoding = ctx.decodeAudioData(bytes.slice().buffer).catch(() => null);
      chain = chain.then(async () => {
        const buffer = await decoding;
        if (!buffer || settled) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(analyser);
        const when = Math.max(ctx.currentTime + 0.02, nextStart);
        source.start(when);
        nextStart = when + buffer.duration;
        sources.add(source);
        startMeter();
        source.onended = () => {
          sources.delete(source);
          maybeFinish();
        };
      });
    },
    end() {
      chain = chain.then(() => {
        drained = true;
        maybeFinish();
      });
    },
    pause() {
      if (!settled) void ctx.suspend().catch(() => undefined);
    },
    resume() {
      if (!settled) void ctx.resume().catch(() => undefined);
    },
    stop() {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop(0);
        } catch {}
      }
      sources.clear();
      settle("stopped");
    },
  };
}

const COMMAND_WORDS = new Set([
  "stop",
  "wait",
  "hold",
  "cancel",
  "pause",
  "hey",
  "quiet",
  "enough",
  "shush",
]);

/** Barge-in needs real speech: two words, or one command word like "stop" or "wait". */
export function confirmsSpokenInterruption(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length > 0);
  return words.length >= 2 || words.some((word) => COMMAND_WORDS.has(word));
}

const SUSTAINED_SPEECH_MS = 420;
const MAX_SPEECH_GAP_MS = 140;

/**
 * True when the clip holds at least 420 ms of voiced energy (gaps up to 140 ms allowed), so a
 * car door, cough or keyboard clack picked up while the reply plays never counts as a turn.
 */
export function hasSustainedSpeech(pcm: Float32Array, sampleRate = 16_000): boolean {
  const frameSize = Math.round(sampleRate * 0.02);
  const levels: number[] = [];
  for (let start = 0; start + frameSize <= pcm.length; start += frameSize) {
    let energy = 0;
    for (let index = start; index < start + frameSize; index += 1) {
      energy += (pcm[index] ?? 0) ** 2;
    }
    levels.push(Math.sqrt(energy / frameSize));
  }
  if (levels.length === 0) return false;
  const floor = [...levels].toSorted((a, b) => a - b)[Math.floor(levels.length * 0.1)] ?? 0;
  const threshold = Math.max(0.025, floor * 2.6 + 0.008);
  let runMs = 0;
  let gapMs = 0;
  for (const level of levels) {
    if (level >= threshold) {
      runMs += 20 + gapMs;
      gapMs = 0;
      if (runMs >= SUSTAINED_SPEECH_MS) return true;
    } else if (runMs > 0) {
      gapMs += 20;
      if (gapMs > MAX_SPEECH_GAP_MS) {
        runMs = 0;
        gapMs = 0;
      }
    }
  }
  return false;
}

const FALSE_INTERRUPTION_MS = 900;
const VAD_HOLD_SAFETY_MS = 6_000;

function holdReply(timeoutMs: number): void {
  if (replyHoldTimer !== null) clearTimeout(replyHoldTimer);
  activeReply?.pause();
  emit({ outputLevel: 0 });
  replyHoldTimer = setTimeout(releaseReplyHold, timeoutMs);
}

/** A false interruption: the reply picks up where it paused. */
function releaseReplyHold(): void {
  if (replyHoldTimer === null) return;
  clearTimeout(replyHoldTimer);
  replyHoldTimer = null;
  activeReply?.resume();
}

function stopActiveReply(): void {
  if (replyHoldTimer !== null) clearTimeout(replyHoldTimer);
  replyHoldTimer = null;
  const reply = activeReply;
  activeReply = null;
  reply?.stop();
}

function replyGuardActive(): boolean {
  return (
    (state.speaking || replyHoldTimer !== null) && getIslandSettings().voiceAssistant.bargeInEnabled
  );
}

function streamSpeakOptions(
  mode: VoiceAssistantInteractionMode,
  speakOverride: boolean | undefined,
): Omit<VoiceSpeakRequest, "text"> | null {
  const settings = getIslandSettings().voiceAssistant;
  if (settings.ttsProvider === "off" || settings.ttsProvider === "browser") return null;
  if (speakOverride === false) return null;
  if (
    speakOverride === undefined &&
    mode !== "voice-mode" &&
    mode !== "assistant" &&
    !settings.speakReplies
  ) {
    return null;
  }
  return buildVoiceSpeakOptions(settings);
}

interface TurnRequestResult {
  readonly response: VoiceAssistantTurnResponse;
  /** Client actions already ran as they streamed in. */
  readonly actionsApplied: boolean;
  /** Set when the server streamed reply audio; resolves when it finished or was cut off. */
  readonly reply: VoiceChunkPlayer | null;
}

async function postTurn(
  url: string,
  apiConfig: VoiceTtsApiConfig,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await getFetchImpl()(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiConfig.headers },
      credentials: apiConfig.credentials ?? "include",
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // fetch rejects with a bare "Failed to fetch" TypeError when the server is unreachable.
    if (signal.aborted || !(error instanceof TypeError)) throw error;
    throw new Error(
      m(msg("Couldn't reach the voice assistant. Check the connection and try again.")),
      {
        cause: error,
      },
    );
  }
}

async function failedTurn(response: Response): Promise<never> {
  const errorText = await response.text().catch(() => "");
  throw new Error(errorText || `Voice assistant request failed (${response.status}).`);
}

/**
 * Runs a turn over `/turn-stream`, playing sentences as they are synthesized. Older servers
 * (404/405) are remembered and get the plain `/turn` request instead.
 */
async function requestTurn(input: {
  readonly apiConfig: VoiceTtsApiConfig;
  readonly payload: VoiceAssistantTurnRequest;
  readonly speak: Omit<VoiceSpeakRequest, "text"> | null;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}): Promise<TurnRequestResult> {
  const base = input.apiConfig.baseUrl.replace(/\/+$/, "");
  if (!turnStreamUnsupported) {
    const response = await postTurn(
      `${base}/api/mattr/voice-assistant/turn-stream`,
      input.apiConfig,
      { ...input.payload, speak: input.speak },
      input.signal,
    );
    if (response.status === 404 || response.status === 405) {
      turnStreamUnsupported = true;
    } else {
      if (!response.ok) return failedTurn(response);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("ndjson") || !response.body) {
        return {
          response: (await response.json()) as VoiceAssistantTurnResponse,
          actionsApplied: false,
          reply: null,
        };
      }
      return readTurnStream(response.body, input);
    }
  }
  const response = await postTurn(
    `${base}/api/mattr/voice-assistant/turn`,
    input.apiConfig,
    input.payload,
    input.signal,
  );
  if (!response.ok) return failedTurn(response);
  return {
    response: (await response.json()) as VoiceAssistantTurnResponse,
    actionsApplied: false,
    reply: null,
  };
}

async function readTurnStream(
  body: ReadableStream<Uint8Array>,
  input: { readonly signal: AbortSignal; readonly isCurrent: () => boolean },
): Promise<TurnRequestResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => undefined);
  input.signal.addEventListener("abort", cancel, { once: true });
  let reply: VoiceChunkPlayer | null = null;
  let actionsApplied = false;
  let done: Extract<VoiceTurnStreamEvent, { readonly type: "done" }> | null = null;
  const pendingEvents: VoiceTurnStreamEvent[] = [];

  const handle = async (event: VoiceTurnStreamEvent) => {
    if (!input.isCurrent()) return;
    switch (event.type) {
      case "tool_result":
        // Actions run the moment they are known, so a barge-in never drops an approval.
        if (event.actions.length > 0) {
          actionsApplied = true;
          emit({ phase: "acting", statusLabel: m(msg("Running actions...")) });
          for (const action of event.actions) {
            if (!input.isCurrent()) return;
            await hostBridge?.executeClientAction(action);
          }
        }
        return;
      case "audio_chunk": {
        if (!reply) {
          const factory = hostBridge?.createChunkPlayer ?? createWebAudioChunkPlayer;
          reply = factory({
            onOutputLevel: (level) => {
              if (state.outputLevel !== level && replyHoldTimer === null) {
                emit({ outputLevel: level });
              }
            },
          });
          activeReply = reply;
          vadCapture?.setSpeakingDuck(true);
          emit({ phase: "speaking", speaking: true, statusLabel: null });
        }
        reply.enqueue(decodeBase64Bytes(event.audioBase64), event.contentType);
        return;
      }
      case "done":
        done = event;
        return;
      case "error":
        throw new Error(event.message);
      case "text_delta":
        return;
    }
  };

  try {
    let buffer = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      buffer += finished ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = finished ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const event = parseTurnStreamLine(line);
        if (event) pendingEvents.push(event);
      }
      while (pendingEvents.length > 0) await handle(pendingEvents.shift()!);
      if (finished) break;
    }
  } catch (error) {
    (reply as VoiceChunkPlayer | null)?.stop();
    throw error;
  } finally {
    input.signal.removeEventListener("abort", cancel);
  }
  const finalPlayer = reply as VoiceChunkPlayer | null;
  finalPlayer?.end();
  const finished = done as Extract<VoiceTurnStreamEvent, { readonly type: "done" }> | null;
  if (!finished) {
    finalPlayer?.stop();
    if (!input.isCurrent()) throw new Error("Voice turn was interrupted.");
    throw new Error("Voice assistant stream ended early.");
  }
  return {
    response: {
      route: finished.route,
      spokenReply: finished.reply,
      displayReply: finished.displayReply,
      expectFollowUp: finished.expectFollowUp,
      toolResults: finished.toolCalls,
      clientActions: finished.actions,
    },
    actionsApplied,
    reply: finalPlayer,
  };
}

async function awaitReply(reply: VoiceChunkPlayer): Promise<void> {
  try {
    await reply.done;
  } finally {
    if (activeReply === reply) {
      activeReply = null;
      if (replyHoldTimer !== null) clearTimeout(replyHoldTimer);
      replyHoldTimer = null;
      vadCapture?.setSpeakingDuck(false);
      if (state.speaking || state.outputLevel !== 0) emit({ speaking: false, outputLevel: 0 });
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

/** Re-renders only when the selected slice changes; the full state emits at audio-level rate. */
export function useVoiceAssistantSelector<T>(select: (state: VoiceAssistantStoreState) => T): T {
  return useSyncExternalStore(
    subscribeVoiceAssistantState,
    () => select(state),
    () => select(state),
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

function routedThreadScope(): VoiceAssistantThreadScope | null {
  const context = hostBridge?.getWorkspaceContext();
  if (!context?.activeEnvironmentId || !context.activeThreadId) return null;
  const thread = context.threads.find(
    (candidate) =>
      candidate.environmentId === context.activeEnvironmentId &&
      candidate.threadId === context.activeThreadId,
  );
  return {
    environmentId: context.activeEnvironmentId,
    threadId: context.activeThreadId,
    title: thread?.title || m(msg("Untitled thread")),
  };
}

/**
 * Opens Voice Mode in the chat on screen (scoped to the routed thread, else all workspace) and
 * starts listening; closing ends the hands-free session too.
 */
export function setVoiceModeOpen(
  open: boolean,
  options?: { readonly autoStartHandsFree?: boolean },
): void {
  if (open) {
    if (state.sessionOpen) return;
    const scope = routedThreadScope();
    if (scope !== null) {
      openThreadVoiceMode(scope, options);
      return;
    }
    emit({ sessionOpen: true, mode: "voice-mode", scopedThread: null, originThread: null });
    playMattrAudioCue("voice-mode-open");
    if (options?.autoStartHandsFree !== false && hostBridge !== null && !state.handsFreeActive) {
      void startHandsFree();
    }
    return;
  }
  if (!state.sessionOpen) return;
  stopHandsFree({ silent: true });
  emit({ sessionOpen: false });
  playMattrAudioCue("voice-mode-close");
}

/**
 * Opens Voice Mode pre-scoped to a specific thread (triggered from inside a thread's composer).
 * Starts hands-free immediately when a host bridge is connected unless opted out.
 */
export function openThreadVoiceMode(
  scope: VoiceAssistantThreadScope,
  options?: { readonly autoStartHandsFree?: boolean },
): void {
  const wasOpen = state.sessionOpen;
  const switchingScope =
    state.scopedThread?.environmentId !== scope.environmentId ||
    state.scopedThread?.threadId !== scope.threadId;
  emit({
    sessionOpen: true,
    mode: "voice-mode",
    scopedThread: scope,
    originThread: scope,
    ...(switchingScope
      ? {
          recentTurns: [],
          lastReply: null,
          lastToolResults: [],
          liveTranscript: "",
          error: null,
        }
      : {}),
  });
  if (!wasOpen) {
    playMattrAudioCue("voice-mode-open");
  }
  if (options?.autoStartHandsFree !== false && hostBridge !== null && !state.handsFreeActive) {
    void startHandsFree();
  }
}

/** Switches the active Voice Mode session between a thread scope and All workspace (`null`). */
export function setVoiceAssistantScopedThread(scope: VoiceAssistantThreadScope | null): void {
  if (
    state.scopedThread?.environmentId === scope?.environmentId &&
    state.scopedThread?.threadId === scope?.threadId &&
    state.scopedThread?.title === scope?.title
  ) {
    return;
  }
  emit({
    scopedThread: scope,
    ...(scope !== null ? { originThread: scope } : {}),
  });
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
  stopActiveReply();
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

async function startVadCapture(): Promise<void> {
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
      // Energy alone only pauses the reply; the utterance decides whether it was a turn.
      if (replyGuardActive()) holdReply(VAD_HOLD_SAFETY_MS);
      if (state.phase === "idle" || state.phase === "listening") {
        emit({ phase: "listening", statusLabel: m(msg("Listening...")) });
      }
    },
    onUtterance: (pcm16k, sampleRate) => {
      userSpeaking = false;
      if (!state.handsFreeActive || state.muted) return;
      if (replyGuardActive()) {
        void handleUtteranceDuringReply(pcm16k, sampleRate);
        return;
      }
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

async function startHandsFree(): Promise<void> {
  if (state.handsFreeActive && vadCapture?.isActive()) return;

  const playOpenCue = !state.sessionOpen;
  vadCapture?.stop();
  emit({
    handsFreeActive: true,
    muted: false,
    mode: "voice-mode",
    phase: "listening",
    liveTranscript: "",
    statusLabel: m(msg("Listening...")),
    error: null,
  });
  if (playOpenCue) {
    playMattrAudioCue("voice-mode-open");
  }

  const shouldTryFlux =
    hostBridge?.createFluxCapture !== undefined || hostBridge?.createVadCapture === undefined;

  if (!shouldTryFlux) {
    await startVadCapture();
    return;
  }

  const fluxFactory = hostBridge?.createFluxCapture ?? createDeepgramFluxCapture;
  const capture = fluxFactory({
    getApiConfig,
    ...(hostBridge?.getMicrophoneId ? { getMicrophoneId: hostBridge.getMicrophoneId } : {}),
    fetchImpl: getFetchImpl(),
    onLevel: (level) => {
      if (state.inputLevel === level) return;
      emit({ inputLevel: level });
    },
    onSpeechStart: () => {
      userSpeaking = true;
      // StartOfTurn pauses the reply; only real words (see onLiveTranscript) cancel it.
      if (replyGuardActive()) holdReply(FALSE_INTERRUPTION_MS);
      if (state.phase === "idle" || state.phase === "listening") {
        emit({ phase: "listening", statusLabel: m(msg("Listening...")) });
      }
    },
    onLiveTranscript: (transcript) => {
      if (!state.handsFreeActive || state.muted) return;
      if (replyGuardActive()) {
        if (!confirmsSpokenInterruption(transcript)) {
          if (transcript.trim()) holdReply(FALSE_INTERRUPTION_MS);
          return;
        }
        // Confirmed: cut the reply but keep this Flux turn, so its first words still count.
        bargeInVoiceAssistant();
      }
      emit({
        liveTranscript: transcript,
        ...(state.phase === "idle" || state.phase === "listening"
          ? { phase: "listening", statusLabel: transcript ? null : m(msg("Listening...")) }
          : {}),
      });
    },
    onFinalTranscript: (transcript) => {
      userSpeaking = false;
      if (!state.handsFreeActive || state.muted) return;
      const trimmed = transcript.trim();
      if (replyGuardActive()) {
        if (!confirmsSpokenInterruption(trimmed)) {
          releaseReplyHold();
          return;
        }
        bargeInVoiceAssistant();
      }
      if (!trimmed) {
        emit({ phase: "listening", statusLabel: null });
        void drainBriefingQueue();
        return;
      }
      void submitVoiceAssistantUtterance(trimmed, { modeOverride: "voice-mode" });
    },
    onFallbackToVad: () => {
      if (vadCapture !== capture || !state.handsFreeActive) return;
      userSpeaking = false;
      vadCapture = null;
      void startVadCapture();
    },
    onError: (message) => {
      userSpeaking = false;
      if (vadCapture === capture) {
        vadCapture = null;
      }
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

function stopHandsFree(options?: { readonly silent?: boolean }): void {
  const playCloseCue = !options?.silent && state.handsFreeActive && !state.sessionOpen;
  userSpeaking = false;
  if (vadCapture) {
    vadCapture.stop();
    vadCapture = null;
  }
  ttsPlayer?.stop();
  stopActiveReply();
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
  if (playCloseCue) {
    playMattrAudioCue("voice-mode-close");
  }
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

/** Local-VAD fallback: a clip heard over the reply is a turn only if it holds real speech. */
async function handleUtteranceDuringReply(pcm16k: Float32Array, sampleRate: 16000): Promise<void> {
  if (!hostBridge || !hasSustainedSpeech(pcm16k, sampleRate)) {
    releaseReplyHold();
    return;
  }
  let transcript = "";
  try {
    transcript = (await hostBridge.transcribePcm(pcm16k, sampleRate)).trim();
  } catch {}
  if (!state.handsFreeActive) return;
  if (!/[\p{L}\p{N}]/u.test(transcript)) {
    releaseReplyHold();
    return;
  }
  bargeInVoiceAssistant();
  await submitVoiceAssistantUtterance(transcript, { modeOverride: "voice-mode" });
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
  stopActiveReply();
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  const turnId = ++activeTurnCounter;
  activeTurnRunning = true;
  activeBriefingRunning = false;

  const rawContext = hostBridge ? hostBridge.getWorkspaceContext() : emptyWorkspaceContext();
  const context = applyThreadScopeToWorkspaceContext(rawContext, state.scopedThread);
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
  const enteredThinking = state.phase !== "thinking";
  emit({
    phase: "thinking",
    liveTranscript: utterance,
    statusLabel: m(msg("Thinking...")),
    error: null,
  });
  if (enteredThinking && effectiveMode !== "dictation") {
    playMattrAudioCue("voice-mode-thinking");
  }

  const controller = new AbortController();
  activeAbortController = controller;

  try {
    const apiConfig = await getApiConfig();
    const payload: VoiceAssistantTurnRequest = {
      utterance,
      mode: effectiveMode,
      history,
      context,
    };
    const isCurrent = () => turnId === activeTurnCounter && !controller.signal.aborted;
    const {
      response: turnResult,
      actionsApplied,
      reply,
    } = await requestTurn({
      apiConfig,
      payload,
      speak: streamSpeakOptions(effectiveMode, options?.speakOverride),
      signal: controller.signal,
      isCurrent,
    });
    if (!isCurrent()) return null;

    if (!actionsApplied && turnResult.clientActions.length > 0) {
      emit({ phase: "acting", statusLabel: m(msg("Running actions...")) });
      for (const action of turnResult.clientActions) {
        if (!isCurrent()) return null;
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

    if (reply) {
      await awaitReply(reply);
    } else if (
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
  stopHandsFree({ silent: true });
  briefingQueue = [];
  briefingSequence = 0;
  turnSequence = 0;
  activeTurnCounter = 0;
  activeTurnRunning = false;
  activeBriefingRunning = false;
  userSpeaking = false;
  turnStreamUnsupported = false;
  hostBridge = null;
  if (ttsPlayer) {
    ttsPlayer.stop();
    ttsPlayer = null;
  }
  state = createInitialState();
  for (const listener of listeners) listener();
}
