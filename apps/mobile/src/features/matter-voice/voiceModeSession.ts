import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";
import {
  DEFAULT_VOICE_ASSISTANT_SETTINGS,
  type VoiceAssistantClientAction,
  type VoiceAssistantSettings,
  type VoiceAssistantTurnRequest,
  type VoiceAssistantTurnResponse,
  type VoiceWorkspaceApprovalSummary,
  type VoiceWorkspaceContext,
} from "../../../../../matter/voice-assistant/types";
import type { ActiveStreamingListening, StreamingListenOptions } from "./fluxListening";
import { createInterruptionGuard, type InterruptionGuard } from "./interruptionGuard";
import type {
  ActiveListening,
  ActivePlayback,
  ListenOptions,
  VoiceRecording,
} from "./nativeVoiceAudio";
import type { SpokenAudio, VoiceAssistantApi } from "./voiceAssistantApi";
import { BARGE_IN_VAD, LISTENING_VAD, type VoiceActivityConfig } from "./voiceAudioLogic";
import { historyFromTurns, type VoiceTurnEntry } from "./voiceContextLogic";
import {
  createPlaybackQueue,
  decodeBase64Audio,
  type PlaybackQueue,
  type PreparedClip,
} from "./voiceTurnStream";

export type VoicePhase =
  | "starting"
  | "listening"
  | "hearing"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "muted"
  | "paused"
  | "error";

export interface VoiceModeSnapshot {
  readonly phase: VoicePhase;
  /** Keeps listening for the next question after each answer. */
  readonly handsFree: boolean;
  readonly muted: boolean;
  readonly turns: ReadonlyArray<VoiceTurnEntry>;
  readonly error: string | null;
  readonly pendingApprovals: ReadonlyArray<VoiceWorkspaceApprovalSummary>;
  /** Words heard so far in the current turn while streaming recognition runs. */
  readonly liveTranscript: string | null;
}

/** What the session needs from the microphone and speaker; faked in tests. */
export interface VoiceModeAudio {
  open(): Promise<void>;
  close(): Promise<void>;
  listen(options: ListenOptions): Promise<ActiveListening>;
  /** Streaming recognition for one turn; null (or absent) where it is not supported. */
  listenStreaming?(
    api: VoiceAssistantApi,
    options: StreamingListenOptions,
  ): Promise<ActiveStreamingListening | null>;
  watchForBargeIn(config: VoiceActivityConfig, onBargeIn: () => void): Promise<() => Promise<void>>;
  play(audio: SpokenAudio): Promise<ActivePlayback>;
  /** Loads a clip ahead of playing it, for gapless streamed replies. */
  prepare?(audio: SpokenAudio): Promise<PreparedClip>;
  /**
   * Whether the microphone hears the reply cancelled out (Apple voice processing). Only then can
   * streaming recognition keep listening while the assistant talks.
   */
  readonly echoCancelled?: boolean;
  transcribe(
    recording: VoiceRecording,
    api: VoiceAssistantApi,
    signal?: AbortSignal,
  ): Promise<string>;
  discardRecording(recording: VoiceRecording): void;
}

export interface VoiceModeDeps {
  readonly audio: VoiceModeAudio;
  /** Null while no connected environment can answer. */
  readonly getApi: () => VoiceAssistantApi | null;
  readonly readContext: () => VoiceWorkspaceContext;
  readonly watchWorkspace: (onChange: () => void) => () => void;
  readonly executeAction: (action: VoiceAssistantClientAction) => Promise<void>;
  /** Normalized 0..1 microphone level for the orb. */
  readonly setLevel: (level: number) => void;
  /** Optional Lilt-style audio cue hook on Voice Mode open, close, and thinking handoff. */
  readonly onAudioCue?: (
    cue: "voice-mode-open" | "voice-mode-close" | "voice-mode-thinking",
  ) => void;
  readonly settings?: VoiceAssistantSettings;
  readonly now?: () => number;
}

const MAX_CONSECUTIVE_ERRORS = 3;
const ERROR_RETRY_DELAY_MS = 2_000;
// Streaming that keeps failing (no ticket, relay without proof, upstream down) stops being tried.
const MAX_STREAMING_FAILURES = 2;
// How often a paused reply checks whether its possible interruption timed out.
const INTERRUPTION_TICK_MS = 100;

type CycleOutcome = "continue" | "pause";

class VoiceCancelled extends Schema.TaggedError<VoiceCancelled>()("VoiceCancelled", {}) {}
const isVoiceCancelled = Schema.is(VoiceCancelled);

/** A server from before `/turn-stream` (duck-typed so tests need not load the HTTP client). */
function isRouteMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly routeMissing?: unknown }).routeMissing === true
  );
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return m(msg("Something went wrong."));
}

/**
 * The hands-free loop: listen → transcribe → ask the assistant → speak → listen again. Plain
 * TypeScript behind a subscribe/snapshot pair so the screen stays a thin view and the loop is
 * testable without a device.
 */
export class VoiceModeSession {
  private snapshot: VoiceModeSnapshot = {
    phase: "starting",
    handsFree: true,
    muted: false,
    turns: [],
    error: null,
    pendingApprovals: [],
    liveTranscript: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly settings: VoiceAssistantSettings;
  private generation = 0;
  private started = false;
  private loopRunning = false;
  /** Whether the loop may begin another listening cycle. */
  private armed = false;
  private pendingText: string | null = null;
  private listening: { finish(): void; cancel(): void } | null = null;
  private streamingFailures = 0;
  private streamingDisabled = false;
  private manualFinish = false;
  private reply: PlaybackQueue | null = null;
  /** Set while a reply plays with streaming recognition open, so words can interrupt it. */
  private replyGuard: InterruptionGuard | null = null;
  /** Streaming recognition opened during a reply, adopted by the next listening cycle. */
  private carriedListening: ActiveStreamingListening | null = null;
  private turnStreamUnsupported = false;
  private replyWatch: Promise<() => Promise<void>> | null = null;
  private turnAbort: AbortController | null = null;
  private stopWorkspaceWatch: (() => void) | null = null;
  private entrySequence = 0;
  private consecutiveErrors = 0;

  constructor(private readonly deps: VoiceModeDeps) {
    this.settings = deps.settings ?? DEFAULT_VOICE_ASSISTANT_SETTINGS;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private update(patch: Partial<VoiceModeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setPhase(phase: VoicePhase, error: string | null = null) {
    const previousPhase = this.snapshot.phase;
    this.update({ phase, error });
    if (phase !== "listening" && phase !== "hearing") this.deps.setLevel(0);
    if (phase === "thinking" && previousPhase !== "thinking") {
      this.deps.onAudioCue?.("voice-mode-thinking");
    }
  }

  private current(generation: number) {
    return generation === this.generation && this.started;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    this.setPhase("starting");
    this.deps.onAudioCue?.("voice-mode-open");
    this.stopWorkspaceWatch = this.deps.watchWorkspace(() => this.refreshPending());
    this.refreshPending();
    this.armed = true;
    this.requestLoop();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.armed = false;
    this.pendingText = null;
    this.stopWorkspaceWatch?.();
    this.stopWorkspaceWatch = null;
    this.interruptAll();
    this.deps.onAudioCue?.("voice-mode-close");
    await this.deps.audio.close();
  }

  private refreshPending() {
    const pending = this.deps.readContext().pendingApprovals;
    const previous = this.snapshot.pendingApprovals;
    if (
      pending.length === previous.length &&
      pending.every((approval, index) => approval.requestId === previous[index]?.requestId)
    ) {
      return;
    }
    this.update({ pendingApprovals: pending });
  }

  /** Cancels whatever is recording, playing or in flight, without ending the session. */
  private interruptAll() {
    this.turnAbort?.abort();
    this.turnAbort = null;
    const listening = this.listening;
    this.listening = null;
    listening?.cancel();
    this.dropCarriedListening();
    this.reply?.stop();
    this.reply = null;
    this.replyGuard = null;
  }

  private dropCarriedListening() {
    const carried = this.carriedListening;
    this.carriedListening = null;
    carried?.cancel();
  }

  private requestLoop() {
    if (this.loopRunning || !this.started) return;
    this.loopRunning = true;
    const generation = this.generation;
    void this.loop(generation).finally(() => {
      this.loopRunning = false;
      // A tap that arrived while the loop was winding down still deserves its cycle.
      if (this.armed && this.started && !this.snapshot.muted && generation !== this.generation) {
        this.requestLoop();
      }
    });
  }

  private async loop(generation: number) {
    while (this.current(generation) && this.armed && !this.snapshot.muted) {
      let outcome: CycleOutcome;
      try {
        outcome = await this.cycle(generation);
        this.consecutiveErrors = 0;
      } catch (error) {
        if (!this.current(generation)) return;
        if (isVoiceCancelled(error)) continue;
        this.consecutiveErrors += 1;
        this.setPhase("error", messageOf(error));
        if (!this.snapshot.handsFree || this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.armed = false;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, ERROR_RETRY_DELAY_MS));
        continue;
      }
      if (outcome === "pause" || !this.snapshot.handsFree || !this.settings.handsFreeAutoListen) {
        this.armed = false;
      }
    }
    // Nobody will adopt recognition that a reply left open.
    this.dropCarriedListening();
    if (this.current(generation) && !this.snapshot.muted && this.snapshot.phase !== "error") {
      this.setPhase("paused");
    }
  }

  private async cycle(generation: number): Promise<CycleOutcome> {
    // Every cycle reopens, so a tap after a refused permission or lost session retries it.
    // The audio serializes open and close, so a stop() during this await still wins.
    await this.deps.audio.open();
    if (!this.current(generation)) throw new VoiceCancelled();
    const api = this.deps.getApi();
    if (!api) throw new Error(m(msg("Connect to an environment to use voice mode.")));

    let text = this.pendingText;
    this.pendingText = null;
    if (text === null) {
      const heard = await this.listenForUtterance(generation, api);
      if (heard === "pause") return "pause";
      if (heard === null) return "continue";
      text = heard;
    }
    const abort = new AbortController();
    this.turnAbort = abort;
    try {
      await this.runTurn(generation, api, text, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) throw new VoiceCancelled();
      throw error;
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
    return "continue";
  }

  /** The words heard so far, or what a typed message or tap turned the cancellation into. */
  private cancelledListening(): string {
    const typed = this.pendingText;
    this.pendingText = null;
    if (typed !== null) return typed;
    throw new VoiceCancelled();
  }

  private onSpeechStart(generation: number) {
    if (this.current(generation) && this.snapshot.phase === "listening") {
      this.setPhase("hearing");
    }
  }

  /** Streaming recognition callbacks: over a reply they feed the guard, otherwise the screen. */
  private onStreamSpeechStart(generation: number) {
    if (!this.current(generation)) return;
    const guard = this.replyGuard;
    if (guard) {
      this.applyInterruption(guard.speechStart(Date.now()));
      return;
    }
    this.onSpeechStart(generation);
  }

  private onStreamTranscript(generation: number, text: string) {
    if (!this.current(generation)) return;
    const guard = this.replyGuard;
    if (guard) {
      this.applyInterruption(guard.transcript(text, Date.now()));
      if (this.replyGuard !== null) return;
    }
    this.onSpeechStart(generation);
    this.update({ liveTranscript: text });
  }

  private streamingOptions(generation: number): StreamingListenOptions {
    return {
      onLevel: (level) => {
        if (this.replyGuard === null) this.deps.setLevel(level);
      },
      onSpeechStart: () => this.onStreamSpeechStart(generation),
      onTranscript: (text) => this.onStreamTranscript(generation, text),
    };
  }

  private applyInterruption(decision: ReturnType<InterruptionGuard["tick"]>) {
    const reply = this.reply;
    if (!reply) return;
    if (decision === "pause") reply.pause();
    else if (decision === "resume") reply.resume();
    else if (decision === "interrupt") this.interruptSpeech();
  }

  /**
   * Deepgram Flux streaming: the turn ends on meaning rather than a fixed silence and the words
   * show while the user talks. Undefined hands the cycle to local endpointing.
   */
  private async listenStreamed(
    generation: number,
    api: VoiceAssistantApi,
  ): Promise<string | "pause" | null | undefined> {
    if (!this.deps.audio.listenStreaming) return undefined;
    this.setPhase("listening");
    this.manualFinish = false;
    // Recognition left open by the reply already holds the user's opening words.
    let listening: ActiveStreamingListening | null = this.carriedListening;
    this.carriedListening = null;
    if (listening !== null && this.snapshot.liveTranscript !== null) this.setPhase("hearing");
    try {
      listening ??= await this.deps.audio.listenStreaming(api, this.streamingOptions(generation));
    } catch {
      if (!this.current(generation)) throw new VoiceCancelled();
      this.noteStreamingFailure(false);
      return undefined;
    }
    if (listening === null) {
      this.streamingDisabled = true;
      return undefined;
    }
    if (!this.current(generation)) {
      listening.cancel();
      throw new VoiceCancelled();
    }
    this.listening = listening;
    const result = await listening.result;
    if (this.listening === listening) this.listening = null;
    if (this.snapshot.liveTranscript !== null) this.update({ liveTranscript: null });
    if (!this.current(generation)) throw new VoiceCancelled();
    switch (result.kind) {
      case "cancelled":
        return this.cancelledListening();
      case "unavailable":
        this.noteStreamingFailure(result.permanent);
        return undefined;
      case "no-speech":
        this.streamingFailures = 0;
        return null;
      case "utterance":
        this.streamingFailures = 0;
        if (result.text.length > 0) return result.text;
        return this.manualFinish && !result.heardSpeech ? "pause" : null;
    }
  }

  private noteStreamingFailure(permanent: boolean) {
    this.streamingFailures += 1;
    if (permanent || this.streamingFailures >= MAX_STREAMING_FAILURES) {
      this.streamingDisabled = true;
    }
  }

  /** The user's words, null to listen again, or "pause" when they tapped to stop. */
  private async listenForUtterance(
    generation: number,
    api: VoiceAssistantApi,
  ): Promise<string | "pause" | null> {
    if (!this.streamingDisabled && this.deps.audio.listenStreaming) {
      const streamed = await this.listenStreamed(generation, api);
      if (streamed !== undefined) return streamed;
    }
    this.setPhase("listening");
    this.manualFinish = false;
    const listening = await this.deps.audio.listen({
      // Mobile tunes its own end-of-speech wait unless the caller passed settings.
      vad:
        this.deps.settings === undefined
          ? LISTENING_VAD
          : { ...LISTENING_VAD, silenceMs: this.settings.silenceTimeoutMs },
      onLevel: (level) => this.deps.setLevel(level),
      onSpeechStart: () => this.onSpeechStart(generation),
    });
    if (!this.current(generation)) {
      listening.cancel();
      throw new VoiceCancelled();
    }
    this.listening = listening;
    const result = await listening.result;
    if (this.listening === listening) this.listening = null;
    if (!this.current(generation)) throw new VoiceCancelled();
    // Muting, a typed message or a tap on "thinking" cancelled the recording.
    if (result.kind === "cancelled") return this.cancelledListening();
    if (result.kind === "no-speech") return null;
    if (!result.heardSpeech && this.manualFinish) {
      this.deps.audio.discardRecording(result.recording);
      return "pause";
    }
    this.setPhase("transcribing");
    const abort = new AbortController();
    this.turnAbort = abort;
    try {
      const text = await this.deps.audio.transcribe(result.recording, api, abort.signal);
      if (!this.current(generation) || abort.signal.aborted) throw new VoiceCancelled();
      return text.length === 0 ? null : text;
    } catch (error) {
      if (abort.signal.aborted) throw new VoiceCancelled();
      throw error;
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
  }

  private async runTurn(
    generation: number,
    api: VoiceAssistantApi,
    utterance: string,
    signal: AbortSignal,
  ) {
    const history = historyFromTurns(this.snapshot.turns);
    this.appendTurn({ role: "user", text: utterance, toolBadges: [] });
    this.setPhase("thinking");
    const request: VoiceAssistantTurnRequest = {
      utterance,
      mode: "voice-mode",
      history,
      context: this.deps.readContext(),
    };
    if (!this.turnStreamUnsupported) {
      try {
        await this.runStreamedTurn(generation, api, request, signal);
        return;
      } catch (error) {
        if (!isRouteMissing(error)) throw error;
        this.turnStreamUnsupported = true;
      }
    }

    const response = await api.turn(request, signal);
    if (!this.current(generation) || signal.aborted) throw new VoiceCancelled();
    const badges = await this.applyActions(response.clientActions, response.toolResults);
    this.finishAssistantTurn(response.displayReply || response.spokenReply, badges);

    if (this.settings.speakReplies && response.spokenReply.trim().length > 0) {
      await this.speak(generation, api, response.spokenReply, signal);
    }
  }

  private badge(label: string, ok: boolean) {
    return { id: `badge-${++this.entrySequence}`, label, ok };
  }

  private async applyActions(
    actions: ReadonlyArray<VoiceAssistantClientAction>,
    toolResults: ReadonlyArray<{ readonly summary: string; readonly ok: boolean }>,
  ) {
    const badges = toolResults.map((result) => this.badge(result.summary, result.ok));
    for (const action of actions) {
      try {
        await this.deps.executeAction(action);
      } catch (error) {
        badges.push(this.badge(messageOf(error), false));
      }
    }
    return badges;
  }

  private finishAssistantTurn(text: string, toolBadges: VoiceTurnEntry["toolBadges"]) {
    this.appendTurn({ role: "assistant", text, toolBadges });
    this.refreshPending();
  }

  private speakOptions() {
    return {
      provider: this.settings.ttsProvider,
      ...(this.settings.ttsVoice ? { voice: this.settings.ttsVoice } : {}),
      speed: this.settings.ttsSpeed,
    };
  }

  /**
   * `/turn-stream`: sentence audio plays the moment it arrives while later sentences are still
   * being written, and client actions apply as soon as the tool round reports them.
   */
  private async runStreamedTurn(
    generation: number,
    api: VoiceAssistantApi,
    request: VoiceAssistantTurnRequest,
    signal: AbortSignal,
  ) {
    const turn: {
      reply: PlaybackQueue | null;
      spoken: string;
      badges: VoiceTurnEntry["toolBadges"] | null;
      actionsApplied: Promise<void>;
    } = { reply: null, spoken: "", badges: null, actionsApplied: Promise.resolve() };
    const onEvent: Parameters<VoiceAssistantApi["turnStream"]>[1] = (event) => {
      if (!this.current(generation) || signal.aborted) return;
      switch (event.type) {
        case "tool_result":
          turn.actionsApplied = this.applyActions(event.actions, event.toolCalls).then((badges) => {
            turn.badges = badges;
          });
          return;
        case "text_delta":
          turn.spoken += event.text;
          return;
        case "audio_chunk":
          turn.reply ??= this.startReply(generation, api);
          turn.reply.enqueue({
            bytes: decodeBase64Audio(event.audioBase64),
            contentType: event.contentType,
          });
          return;
      }
    };
    let response: VoiceAssistantTurnResponse;
    try {
      response = await api.turnStream(
        { ...request, speak: this.settings.speakReplies ? this.speakOptions() : null },
        onEvent,
        signal,
      );
    } catch (error) {
      // An interrupted reply still belongs in the history, as far as it got.
      if (signal.aborted && turn.spoken.trim().length > 0 && this.current(generation)) {
        await turn.actionsApplied;
        this.finishAssistantTurn(turn.spoken.trim(), turn.badges ?? []);
      }
      if (turn.reply !== null) {
        turn.reply.stop();
        await this.awaitReply(generation, turn.reply).catch(() => {});
      }
      throw error;
    }
    if (!this.current(generation) || signal.aborted) throw new VoiceCancelled();
    await turn.actionsApplied;
    const badges =
      turn.badges ?? (await this.applyActions(response.clientActions, response.toolResults));
    this.finishAssistantTurn(response.displayReply || response.spokenReply, badges);
    if (turn.reply === null) return;
    turn.reply.end();
    await this.awaitReply(generation, turn.reply);
  }

  /** `/speak` for servers without `/turn-stream`. */
  private async speak(
    generation: number,
    api: VoiceAssistantApi,
    text: string,
    signal: AbortSignal,
  ) {
    this.setPhase("speaking");
    let audio: SpokenAudio;
    try {
      audio = await api.speak({ text, ...this.speakOptions() }, signal);
    } catch {
      // Aborted turns propagate; a server with no TTS leaves the reply on screen.
      if (signal.aborted || !this.current(generation)) throw new VoiceCancelled();
      return;
    }
    if (!this.current(generation) || signal.aborted) throw new VoiceCancelled();
    const queue = this.startReply(generation, api);
    queue.enqueue(audio);
    queue.end();
    await this.awaitReply(generation, queue);
  }

  /** Starts gapless playback and the interruption watch for one reply. */
  private startReply(generation: number, api: VoiceAssistantApi): PlaybackQueue {
    const audio = this.deps.audio;
    const queue = createPlaybackQueue(
      audio.prepare
        ? (clip) => audio.prepare!(clip)
        : async (clip) => ({ start: () => audio.play(clip), discard: () => {} }),
    );
    this.reply = queue;
    this.setPhase("speaking");
    if (this.settings.bargeInEnabled) {
      this.replyWatch = this.watchReply(generation, api, queue);
    }
    return queue;
  }

  private async awaitReply(generation: number, queue: PlaybackQueue) {
    try {
      await queue.done;
    } finally {
      if (this.reply === queue) this.reply = null;
      this.replyGuard = null;
      const watch = this.replyWatch;
      this.replyWatch = null;
      if (watch) await watch.then((stop) => stop()).catch(() => {});
    }
    if (!this.current(generation)) throw new VoiceCancelled();
  }

  /**
   * With echo-cancelled streaming recognition, the reply stays interruptible by words only, and
   * the same recognition carries into the next turn so the user's first words are kept. Without
   * it, local endpointing needs sustained speech.
   */
  private async watchReply(
    generation: number,
    api: VoiceAssistantApi,
    queue: PlaybackQueue,
  ): Promise<() => Promise<void>> {
    const audio = this.deps.audio;
    if (audio.listenStreaming && audio.echoCancelled && !this.streamingDisabled) {
      let listening: ActiveStreamingListening | null = null;
      const guard = createInterruptionGuard("transcript");
      this.replyGuard = guard;
      try {
        listening = await audio.listenStreaming(api, this.streamingOptions(generation));
      } catch {}
      if (listening !== null && this.current(generation) && this.reply === queue) {
        const active = listening;
        let finishedTurn: boolean | null = null;
        const ticker = setInterval(() => {
          if (this.replyGuard === guard) this.applyInterruption(guard.tick(Date.now()));
        }, INTERRUPTION_TICK_MS);
        void active.result.then((result) => {
          finishedTurn = result.kind === "utterance" && result.text.length > 0;
          // A whole turn spoken over the reply is the user talking, not noise.
          if (finishedTurn && this.reply === queue) {
            this.update({ liveTranscript: result.kind === "utterance" ? result.text : null });
            this.interruptSpeech();
          }
        });
        return async () => {
          clearInterval(ticker);
          if (this.replyGuard === guard) this.replyGuard = null;
          // Still listening, or holding the words that interrupted: the next turn takes it over.
          if (this.current(generation) && finishedTurn !== false) {
            this.dropCarriedListening();
            this.carriedListening = active;
          } else {
            active.cancel();
          }
        };
      }
      if (this.replyGuard === guard) this.replyGuard = null;
      listening?.cancel();
      if (this.reply !== queue) return async () => {};
    }
    try {
      return await audio.watchForBargeIn(BARGE_IN_VAD, () => this.interruptSpeech());
    } catch {
      // Tap to interrupt still works without the microphone watcher.
      return async () => {};
    }
  }

  /** Confirmed barge-in or a tap: drop the rest of the reply and stop paying for it. */
  private interruptSpeech() {
    this.replyGuard = null;
    this.reply?.stop();
    this.turnAbort?.abort();
  }

  private appendTurn(turn: Omit<VoiceTurnEntry, "id">) {
    this.update({
      turns: [...this.snapshot.turns, { ...turn, id: `turn-${++this.entrySequence}` }],
    });
  }

  /** The orb: interrupts speech, sends or stops a recording, cancels a turn, or starts listening. */
  tapOrb() {
    if (!this.started) return;
    switch (this.snapshot.phase) {
      case "speaking":
        // The loop's next cycle starts listening as soon as playback settles.
        this.interruptSpeech();
        return;
      case "hearing":
        this.listening?.finish();
        return;
      case "listening":
        this.manualFinish = true;
        this.listening?.finish();
        return;
      case "transcribing":
      case "thinking":
        this.turnAbort?.abort();
        return;
      case "muted":
        return;
      case "starting":
        return;
      case "paused":
      case "error":
        this.consecutiveErrors = 0;
        this.armed = true;
        this.requestLoop();
        return;
    }
  }

  setMuted(muted: boolean) {
    if (!this.started || this.snapshot.muted === muted) return;
    this.update({ muted });
    if (muted) {
      this.armed = false;
      this.interruptAll();
      this.setPhase("muted");
    } else {
      this.armed = true;
      this.setPhase("paused");
      this.requestLoop();
    }
  }

  setHandsFree(handsFree: boolean) {
    this.update({ handsFree });
  }

  /** Text fallback when speaking is not an option. */
  sendText(text: string) {
    const trimmed = text.trim();
    if (!this.started || trimmed.length === 0 || this.snapshot.muted) return;
    this.pendingText = trimmed;
    this.interruptAll();
    this.armed = true;
    this.requestLoop();
  }

  /** Never rejects: a failed answer shows as the session error and the card stays up. */
  async respondToApproval(
    approval: VoiceWorkspaceApprovalSummary,
    decision: "accept" | "decline",
  ): Promise<void> {
    try {
      await this.deps.executeAction({
        type: "respond-approval",
        environmentId: approval.environmentId,
        threadId: approval.threadId,
        requestId: approval.requestId,
        decision,
      });
    } catch (error) {
      if (this.started) this.update({ error: messageOf(error) });
    }
    if (this.started) this.refreshPending();
  }
}
