import { msg } from "gt-react";
import { m } from "../i18n/messages";
import { PcmResampler } from "../speech/pcmResampler";
import type { VoiceSpeakRequest } from "../../../../antimatter/voice-assistant/types";

const TARGET_SAMPLE_RATE = 16_000;
const PRE_SPEECH_MS = 400;
const PRE_SPEECH_SAMPLES = Math.round((TARGET_SAMPLE_RATE * PRE_SPEECH_MS) / 1000);
const TRAILING_PAD_MS = 260;
const TRAILING_PAD_SAMPLES = Math.round((TARGET_SAMPLE_RATE * TRAILING_PAD_MS) / 1000);
const MIN_UTTERANCE_MS = 220;
const DEFAULT_SILENCE_TIMEOUT_MS = 1150;
const DEFAULT_MAX_UTTERANCE_MS = 30_000;
const ONSET_MS = 140;
const DUCKED_ONSET_MS = 185;
const SCRIPT_BUFFER_SIZE = 2048;
const FLUX_CHUNK_MS = 80;
const FLUX_CHUNK_SAMPLES = Math.round((TARGET_SAMPLE_RATE * FLUX_CHUNK_MS) / 1000);
const FLUX_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const FLUX_WS_PATH = "/api/mattr/voice-assistant/flux";
const FLUX_WS_TICKET_PATH = "/api/auth/websocket-ticket/media";

export type DeepgramFluxTurnEventKind =
  | "StartOfTurn"
  | "Update"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn";

export type DeepgramFluxServerMessage =
  | {
      readonly type: "Connected";
      readonly request_id?: string;
    }
  | {
      readonly type: "TurnInfo";
      readonly event: DeepgramFluxTurnEventKind;
      readonly transcript: string;
      readonly turn_index?: number;
      readonly end_of_turn_confidence?: number;
    }
  | {
      readonly type: "Error";
      readonly description?: string;
    };

export interface DeepgramFluxCaptureOptions {
  readonly getApiConfig: () => Promise<VoiceTtsApiConfig> | VoiceTtsApiConfig;
  readonly getMicrophoneId?: (() => string | Promise<string>) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly webSocketImpl?: typeof WebSocket | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly onLevel: (level: number) => void;
  readonly onSpeechStart: () => void;
  readonly onLiveTranscript: (transcript: string) => void;
  readonly onFinalTranscript: (transcript: string) => void;
  readonly onFallbackToVad: (reason: string) => void;
  readonly onError: (message: string) => void;
}

export interface HandsFreeVadCaptureOptions {
  readonly getMicrophoneId?: (() => string | Promise<string>) | undefined;
  readonly getSilenceTimeoutMs?: (() => number) | undefined;
  readonly silenceTimeoutMs?: number | undefined;
  readonly maxUtteranceMs?: number | undefined;
  readonly onLevel: (level: number) => void;
  readonly onSpeechStart: () => void;
  readonly onUtterance: (pcm16k: Float32Array, sampleRate: 16000) => void;
  readonly onError: (message: string) => void;
}

export interface HandsFreeVadCapture {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly setSpeakingDuck: (speaking: boolean) => void;
  readonly isActive: () => boolean;
}

export interface VoiceTtsApiConfig {
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly credentials?: RequestCredentials;
}

export interface VoiceTtsPlayerOptions {
  readonly getApiConfig: () => Promise<VoiceTtsApiConfig> | VoiceTtsApiConfig;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly onOutputLevel: (level: number) => void;
  readonly onSpeakingChange?: ((speaking: boolean) => void) | undefined;
}

export interface VoiceTtsPlayer {
  readonly speak: (request: VoiceSpeakRequest) => Promise<void>;
  readonly stop: () => void;
  readonly isSpeaking: () => boolean;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Encodes 16 kHz mono Float32 PCM into a standard 16-bit PCM WAV Blob. */
export function encodeWav16k(pcm: Float32Array): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataByteLength = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function resampleFallbackLinear(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE || input.length === 0) return input.slice();
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const src = i * ratio;
    const low = Math.floor(src);
    const high = Math.min(input.length - 1, low + 1);
    const frac = src - low;
    output[i] = (input[low] ?? 0) * (1 - frac) + (input[high] ?? 0) * frac;
  }
  return output;
}

function concatFloat32(
  chunks: ReadonlyArray<Float32Array>,
  trimTrailingSamples: number,
): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const keepLength = Math.max(0, total - Math.max(0, trimTrailingSamples));
  const out = new Float32Array(keepLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= keepLength) break;
    const take = Math.min(chunk.length, keepLength - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    energy += sample * sample;
  }
  return Math.sqrt(energy / samples.length);
}

async function openHandsFreeMicrophone(microphoneId: string): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is not available in this browser.");
  }
  const baseAudio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  const primary: MediaStreamConstraints = {
    audio: microphoneId ? { ...baseAudio, deviceId: { exact: microphoneId } } : baseAudio,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(primary);
  } catch (error) {
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
    if (!microphoneId || (name !== "OverconstrainedError" && name !== "NotFoundError")) {
      throw error;
    }
    return navigator.mediaDevices.getUserMedia({ audio: baseAudio });
  }
}

/**
 * Continuous hands-free microphone capture with adaptive noise-floor VAD,
 * 400ms pre-speech ring buffer, speaker-ducked barge-in thresholding, and
 * silence-based utterance endpointing at 16 kHz mono Float32 PCM.
 */
export function createHandsFreeVadCapture(
  options: HandsFreeVadCaptureOptions,
): HandsFreeVadCapture {
  let active = false;
  let muted = false;
  let speakingDuck = false;
  let startToken = 0;

  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let sourceNode: MediaStreamAudioSourceNode | undefined;
  let processorNode: ScriptProcessorNode | undefined;
  let muteGainNode: GainNode | undefined;

  let resampler: PcmResampler | null = null;
  let noiseFloor = 0.008;
  let smoothedLevel = 0;
  let inSpeech = false;
  let onsetMs = 0;
  let silenceMs = 0;
  let speechDurationMs = 0;
  let preSpeechChunks: Float32Array[] = [];
  let preSpeechSamples = 0;
  let speechChunks: Float32Array[] = [];

  const resetSpeechBuffer = () => {
    inSpeech = false;
    onsetMs = 0;
    silenceMs = 0;
    speechDurationMs = 0;
    speechChunks = [];
  };

  const pushPreSpeech = (chunk: Float32Array) => {
    preSpeechChunks.push(chunk);
    preSpeechSamples += chunk.length;
    while (preSpeechSamples > PRE_SPEECH_SAMPLES && preSpeechChunks.length > 1) {
      const oldest = preSpeechChunks.shift();
      if (oldest) preSpeechSamples -= oldest.length;
    }
  };

  const cleanup = () => {
    active = false;
    resetSpeechBuffer();
    preSpeechChunks = [];
    preSpeechSamples = 0;
    smoothedLevel = 0;
    resampler = null;

    if (processorNode) {
      processorNode.onaudioprocess = null;
      try {
        processorNode.disconnect();
      } catch {}
      processorNode = undefined;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {}
      sourceNode = undefined;
    }
    if (muteGainNode) {
      try {
        muteGainNode.disconnect();
      } catch {}
      muteGainNode = undefined;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = undefined;
    }
    if (audioContext) {
      const ctx = audioContext;
      audioContext = undefined;
      void ctx.close().catch(() => undefined);
    }
    options.onLevel(0);
  };

  const processPcm16k = (pcm16k: Float32Array) => {
    if (!active || pcm16k.length === 0) return;

    const frameMs = (pcm16k.length / TARGET_SAMPLE_RATE) * 1000;
    const rms = computeRms(pcm16k);
    const targetLevel = muted ? 0 : Math.min(1, rms * 4.2);
    const timeConstant = targetLevel > smoothedLevel ? 0.075 : 0.2;
    const decay = Math.exp(-frameMs / 1000 / timeConstant);
    smoothedLevel = targetLevel + (smoothedLevel - targetLevel) * decay;
    options.onLevel(muted ? 0 : smoothedLevel);

    if (muted) {
      if (inSpeech) resetSpeechBuffer();
      preSpeechChunks = [];
      preSpeechSamples = 0;
      return;
    }

    const baseThreshold = Math.max(0.018, noiseFloor * 2.6 + 0.008);
    const onsetThreshold = speakingDuck ? Math.max(0.045, baseThreshold * 2.15) : baseThreshold;
    const continueThreshold = Math.max(0.012, noiseFloor * 1.8 + 0.005);

    if (!inSpeech) {
      pushPreSpeech(pcm16k);

      if (!speakingDuck) {
        if (rms < noiseFloor) {
          noiseFloor = Math.max(0.004, noiseFloor * 0.92 + rms * 0.08);
        } else if (rms < baseThreshold) {
          noiseFloor = Math.min(0.045, noiseFloor * 0.985 + rms * 0.015);
        }
      }

      if (rms >= onsetThreshold) {
        onsetMs += frameMs;
        const requiredOnsetMs = speakingDuck ? DUCKED_ONSET_MS : ONSET_MS;
        if (onsetMs >= requiredOnsetMs) {
          inSpeech = true;
          speechChunks = preSpeechChunks.slice();
          speechDurationMs = (preSpeechSamples / TARGET_SAMPLE_RATE) * 1000;
          preSpeechChunks = [];
          preSpeechSamples = 0;
          silenceMs = 0;
          options.onSpeechStart();
        }
      } else {
        onsetMs = Math.max(0, onsetMs - frameMs * 1.5);
      }
      return;
    }

    speechChunks.push(pcm16k);
    speechDurationMs += frameMs;

    if (rms >= continueThreshold) {
      silenceMs = 0;
    } else {
      silenceMs += frameMs;
    }

    const silenceTimeoutMs = Math.max(
      400,
      options.getSilenceTimeoutMs?.() ?? options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS,
    );
    const maxUtteranceMs = options.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS;

    if (silenceMs >= silenceTimeoutMs || speechDurationMs >= maxUtteranceMs) {
      const trailingSilenceSamples = Math.round((silenceMs / 1000) * TARGET_SAMPLE_RATE);
      const trimSamples = Math.max(0, trailingSilenceSamples - TRAILING_PAD_SAMPLES);
      const utterance = concatFloat32(speechChunks, trimSamples);
      const activeSpeechMs = speechDurationMs - silenceMs;
      resetSpeechBuffer();

      if (activeSpeechMs >= MIN_UTTERANCE_MS && utterance.length > 0) {
        options.onUtterance(utterance, TARGET_SAMPLE_RATE);
      }
    }
  };

  return {
    start: async () => {
      if (active) return;
      const token = ++startToken;
      try {
        const microphoneId = (await options.getMicrophoneId?.()) ?? "";
        if (token !== startToken) return;
        const mediaStream = await openHandsFreeMicrophone(microphoneId);
        if (token !== startToken) {
          for (const track of mediaStream.getTracks()) track.stop();
          return;
        }
        stream = mediaStream;
        const ctx = new AudioContext();
        audioContext = ctx;
        const inputRate = ctx.sampleRate;
        resampler = inputRate >= TARGET_SAMPLE_RATE ? new PcmResampler(inputRate) : null;

        const source = ctx.createMediaStreamSource(mediaStream);
        sourceNode = source;
        // ScriptProcessorNode keeps 42ms frame granularity without worklet CSP or duration caps.
        const processor = ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
        processorNode = processor;
        const zeroGain = ctx.createGain();
        zeroGain.gain.value = 0;
        muteGainNode = zeroGain;

        processor.onaudioprocess = (event) => {
          if (!active) return;
          const channel = event.inputBuffer.getChannelData(0);
          const output = event.outputBuffer.getChannelData(0);
          output.fill(0);
          const resampled = resampler
            ? resampler.push(channel)
            : resampleFallbackLinear(channel, inputRate);
          processPcm16k(resampled);
        };

        for (const track of mediaStream.getTracks()) {
          track.addEventListener(
            "ended",
            () => {
              if (!active) return;
              cleanup();
              options.onError(m(msg("The microphone disconnected.")));
            },
            { once: true },
          );
        }

        source.connect(processor);
        processor.connect(zeroGain);
        zeroGain.connect(ctx.destination);
        await ctx.resume();
        if (token !== startToken) {
          cleanup();
          return;
        }
        noiseFloor = 0.008;
        active = true;
      } catch (error) {
        cleanup();
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Could not access microphone for hands-free voice mode.";
        options.onError(message);
        throw error;
      }
    },
    stop: () => {
      startToken += 1;
      cleanup();
    },
    setMuted: (nextMuted: boolean) => {
      muted = nextMuted;
      if (muted) {
        resetSpeechBuffer();
        smoothedLevel = 0;
        options.onLevel(0);
      }
    },
    setSpeakingDuck: (speaking: boolean) => {
      speakingDuck = speaking;
    },
    isActive: () => active,
  };
}

const VALID_FLUX_TURN_EVENTS: ReadonlySet<string> = new Set<DeepgramFluxTurnEventKind>([
  "StartOfTurn",
  "Update",
  "EagerEndOfTurn",
  "TurnResumed",
  "EndOfTurn",
]);

function isFluxTurnEventKind(value: unknown): value is DeepgramFluxTurnEventKind {
  return typeof value === "string" && VALID_FLUX_TURN_EVENTS.has(value);
}

/** Parses a Deepgram Flux v2 JSON message forwarded by the mattr Flux WS proxy. */
export function parseDeepgramFluxServerMessage(raw: string): DeepgramFluxServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (obj.type === "Connected") {
    return {
      type: "Connected",
      ...(typeof obj.request_id === "string" ? { request_id: obj.request_id } : {}),
    };
  }

  if (obj.type === "TurnInfo" && isFluxTurnEventKind(obj.event)) {
    return {
      type: "TurnInfo",
      event: obj.event,
      transcript: typeof obj.transcript === "string" ? obj.transcript : "",
      ...(typeof obj.turn_index === "number" && Number.isFinite(obj.turn_index)
        ? { turn_index: obj.turn_index }
        : {}),
      ...(typeof obj.end_of_turn_confidence === "number" &&
      Number.isFinite(obj.end_of_turn_confidence)
        ? { end_of_turn_confidence: obj.end_of_turn_confidence }
        : {}),
    };
  }

  if (obj.type === "Error" || obj.type === "FatalError") {
    const description =
      typeof obj.description === "string"
        ? obj.description
        : typeof obj.message === "string"
          ? obj.message
          : undefined;
    return {
      type: "Error",
      ...(description !== undefined ? { description } : {}),
    };
  }

  return null;
}

/** Converts 16 kHz mono Float32 PCM samples into little-endian 16-bit signed linear PCM bytes. */
export function float32ToInt16Le(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return new Uint8Array(buffer);
}

function readAuthorizationHeader(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

async function resolveFluxWebSocketUrl(
  apiConfig: VoiceTtsApiConfig,
  fetchFn: typeof fetch,
): Promise<string> {
  const rawBase = apiConfig.baseUrl.trim().replace(/\/+$/, "");
  const fallbackOrigin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost";
  const httpBase = rawBase.length > 0 ? rawBase : fallbackOrigin;
  const wsUrl = new URL(FLUX_WS_PATH, `${httpBase}/`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  const authHeader = readAuthorizationHeader(apiConfig.headers);
  if (authHeader) {
    try {
      const ticketRes = await fetchFn(`${httpBase}${FLUX_WS_TICKET_PATH}`, {
        method: "POST",
        headers: { ...apiConfig.headers },
        credentials: apiConfig.credentials ?? "include",
      });
      if (ticketRes.ok) {
        const json = (await ticketRes.json()) as { readonly ticket?: unknown };
        if (typeof json.ticket === "string" && json.ticket.trim().length > 0) {
          wsUrl.searchParams.set("wsTicket", json.ticket.trim());
        }
      }
    } catch {
      // Proceed with cookie/origin auth; server rejection falls back to VAD seamlessly.
    }
  }

  return wsUrl.toString();
}

/**
 * Real-time Deepgram Flux streaming STT capture over `/api/mattr/voice-assistant/flux`.
 * Streams 80ms 16 kHz mono Int16 PCM chunks while maintaining local smoothed RMS metering,
 * instant StartOfTurn barge-in, live streaming transcripts, and seamless VAD fallback.
 */
export function createDeepgramFluxCapture(
  options: DeepgramFluxCaptureOptions,
): HandsFreeVadCapture {
  let active = false;
  let muted = false;
  let speakingDuck = false;
  let intentionalStop = false;
  let fellBack = false;
  let startToken = 0;

  let ws: WebSocket | undefined;
  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let sourceNode: MediaStreamAudioSourceNode | undefined;
  let processorNode: ScriptProcessorNode | undefined;
  let muteGainNode: GainNode | undefined;

  let resampler: PcmResampler | null = null;
  let smoothedLevel = 0;
  let latestTranscript = "";
  let pendingPcm = new Float32Array(FLUX_CHUNK_SAMPLES * 4);
  let pendingLength = 0;

  const cleanupResources = (sendCloseStream: boolean) => {
    active = false;
    smoothedLevel = 0;
    latestTranscript = "";
    pendingLength = 0;
    resampler = null;

    if (processorNode) {
      processorNode.onaudioprocess = null;
      try {
        processorNode.disconnect();
      } catch {}
      processorNode = undefined;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {}
      sourceNode = undefined;
    }
    if (muteGainNode) {
      try {
        muteGainNode.disconnect();
      } catch {}
      muteGainNode = undefined;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = undefined;
    }
    if (audioContext) {
      const ctx = audioContext;
      audioContext = undefined;
      void ctx.close().catch(() => undefined);
    }
    if (ws) {
      const socket = ws;
      ws = undefined;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (sendCloseStream && socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: "CloseStream" }));
        } catch {}
      }
      if (socket.readyState === 0 || socket.readyState === 1) {
        try {
          socket.close(1000);
        } catch {}
      }
    }
    options.onLevel(0);
  };

  const triggerFallback = (reason: string) => {
    if (intentionalStop || fellBack) return;
    fellBack = true;
    startToken += 1;
    cleanupResources(false);
    options.onFallbackToVad(reason);
  };

  const appendAndSendPcm = (pcm16k: Float32Array) => {
    if (!active || pcm16k.length === 0) return;

    const frameMs = (pcm16k.length / TARGET_SAMPLE_RATE) * 1000;
    const rms = computeRms(pcm16k);
    const targetLevel = muted ? 0 : Math.min(1, rms * 4.2);
    const timeConstant = targetLevel > smoothedLevel ? 0.075 : 0.2;
    const decay = Math.exp(-frameMs / 1000 / timeConstant);
    smoothedLevel = targetLevel + (smoothedLevel - targetLevel) * decay;
    options.onLevel(muted ? 0 : smoothedLevel);

    if (muted || !ws || ws.readyState !== 1) {
      pendingLength = 0;
      return;
    }

    const needed = pendingLength + pcm16k.length;
    if (needed > pendingPcm.length) {
      const grown = new Float32Array(Math.max(needed, pendingPcm.length * 2));
      grown.set(pendingPcm.subarray(0, pendingLength), 0);
      pendingPcm = grown;
    }
    pendingPcm.set(pcm16k, pendingLength);
    pendingLength = needed;

    let offset = 0;
    while (pendingLength - offset >= FLUX_CHUNK_SAMPLES) {
      const slice = pendingPcm.subarray(offset, offset + FLUX_CHUNK_SAMPLES);
      try {
        ws.send(float32ToInt16Le(slice));
      } catch {
        triggerFallback("flux_send_failed");
        return;
      }
      offset += FLUX_CHUNK_SAMPLES;
    }

    if (offset > 0) {
      const remaining = pendingLength - offset;
      if (remaining > 0) {
        pendingPcm.copyWithin(0, offset, pendingLength);
      }
      pendingLength = remaining;
    }
  };

  const handleFluxMessage = (raw: string) => {
    if (intentionalStop || fellBack) return;
    const message = parseDeepgramFluxServerMessage(raw);
    if (!message) return;

    if (message.type === "Error") {
      triggerFallback(message.description ?? "deepgram_flux_error");
      return;
    }
    if (message.type !== "TurnInfo" || muted) return;

    const trimmed = message.transcript.trim();
    switch (message.event) {
      case "StartOfTurn":
        latestTranscript = trimmed;
        options.onSpeechStart();
        if (trimmed.length > 0) {
          options.onLiveTranscript(trimmed);
        }
        return;
      case "Update":
      case "EagerEndOfTurn":
        latestTranscript = trimmed;
        options.onLiveTranscript(trimmed);
        return;
      case "TurnResumed":
        if (trimmed.length > 0) {
          latestTranscript = trimmed;
          options.onLiveTranscript(trimmed);
        }
        return;
      case "EndOfTurn": {
        const finalText = trimmed.length > 0 ? trimmed : latestTranscript;
        latestTranscript = "";
        if (finalText.length > 0) {
          options.onFinalTranscript(finalText);
        }
        return;
      }
    }
  };

  return {
    start: async () => {
      if (active) return;
      const WebSocketCtor =
        options.webSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
      if (!WebSocketCtor) {
        options.onFallbackToVad("websocket_unavailable");
        return;
      }

      const token = ++startToken;
      intentionalStop = false;
      fellBack = false;

      let wsUrl: string;
      try {
        const apiConfig = await options.getApiConfig();
        if (token !== startToken || intentionalStop || fellBack) return;
        wsUrl = await resolveFluxWebSocketUrl(apiConfig, options.fetchImpl ?? fetch);
      } catch {
        triggerFallback("flux_config_failed");
        return;
      }
      if (token !== startToken || intentionalStop || fellBack) return;

      const opened = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean, fallbackReason?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!ok && fallbackReason) {
            triggerFallback(fallbackReason);
          }
          resolve(ok);
        };

        const timer = setTimeout(() => {
          finish(false, "flux_connect_timeout");
        }, options.connectTimeoutMs ?? FLUX_DEFAULT_CONNECT_TIMEOUT_MS);

        let socket: WebSocket;
        try {
          socket = new WebSocketCtor(wsUrl);
        } catch {
          finish(false, "flux_websocket_construct_failed");
          return;
        }
        socket.binaryType = "arraybuffer";
        ws = socket;

        socket.onopen = () => {
          if (token !== startToken || intentionalStop || fellBack) {
            finish(false);
            return;
          }
          finish(true);
        };
        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            handleFluxMessage(event.data);
          }
        };
        socket.onerror = () => {
          if (!settled) {
            finish(false, "flux_websocket_error");
          } else {
            triggerFallback("flux_websocket_error");
          }
        };
        socket.onclose = (event) => {
          const reason =
            event.code === 4401
              ? "deepgram_not_configured"
              : event.reason || `flux_closed_${event.code}`;
          if (!settled) {
            finish(false, reason);
          } else {
            triggerFallback(reason);
          }
        };
      });

      if (!opened || token !== startToken || intentionalStop || fellBack) return;

      try {
        const microphoneId = (await options.getMicrophoneId?.()) ?? "";
        if (token !== startToken || intentionalStop || fellBack) return;
        const mediaStream = await openHandsFreeMicrophone(microphoneId);
        if (token !== startToken || intentionalStop || fellBack) {
          for (const track of mediaStream.getTracks()) track.stop();
          return;
        }
        stream = mediaStream;
        const ctx = new AudioContext();
        audioContext = ctx;
        const inputRate = ctx.sampleRate;
        resampler = inputRate >= TARGET_SAMPLE_RATE ? new PcmResampler(inputRate) : null;

        const source = ctx.createMediaStreamSource(mediaStream);
        sourceNode = source;
        const processor = ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
        processorNode = processor;
        const zeroGain = ctx.createGain();
        zeroGain.gain.value = 0;
        muteGainNode = zeroGain;

        processor.onaudioprocess = (event) => {
          if (!active) return;
          const channel = event.inputBuffer.getChannelData(0);
          const output = event.outputBuffer.getChannelData(0);
          output.fill(0);
          const resampled = resampler
            ? resampler.push(channel)
            : resampleFallbackLinear(channel, inputRate);
          appendAndSendPcm(resampled);
        };

        for (const track of mediaStream.getTracks()) {
          track.addEventListener(
            "ended",
            () => {
              if (!active) return;
              intentionalStop = true;
              cleanupResources(true);
              options.onError(m(msg("The microphone disconnected.")));
            },
            { once: true },
          );
        }

        source.connect(processor);
        processor.connect(zeroGain);
        zeroGain.connect(ctx.destination);
        await ctx.resume();
        if (token !== startToken || intentionalStop || fellBack) {
          cleanupResources(false);
          return;
        }
        active = true;
      } catch (error) {
        if (fellBack || intentionalStop) return;
        intentionalStop = true;
        cleanupResources(true);
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Could not access microphone for hands-free voice mode.";
        options.onError(message);
        throw error;
      }
    },
    stop: () => {
      intentionalStop = true;
      startToken += 1;
      cleanupResources(true);
    },
    setMuted: (nextMuted: boolean) => {
      muted = nextMuted;
      if (muted) {
        pendingLength = 0;
        latestTranscript = "";
        smoothedLevel = 0;
        options.onLevel(0);
      }
    },
    setSpeakingDuck: (speaking: boolean) => {
      speakingDuck = speaking;
      void speakingDuck;
    },
    isActive: () => active,
  };
}

function clampSpeed(speed: number | undefined): number {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.08;
  return Math.min(1.5, Math.max(0.8, speed));
}

function selectBrowserVoice(requestedVoice: string | undefined): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const trimmed = requestedVoice?.trim().toLowerCase();
  if (trimmed) {
    const exact = voices.find((v) => v.name.toLowerCase() === trimmed);
    if (exact) return exact;
    const partial = voices.find((v) => v.name.toLowerCase().includes(trimmed));
    if (partial) return partial;
  }

  const preferredNames = [
    "samantha",
    "ava",
    "zoe",
    "allison",
    "daniel",
    "karen",
    "google us english",
    "natural",
    "enhanced",
    "premium",
  ];
  for (const name of preferredNames) {
    const match = voices.find(
      (v) => v.lang.toLowerCase().startsWith("en") && v.name.toLowerCase().includes(name),
    );
    if (match) return match;
  }

  return (
    voices.find((v) => v.lang.toLowerCase() === "en-us") ??
    voices.find((v) => v.lang.toLowerCase().startsWith("en")) ??
    voices[0] ??
    null
  );
}

/**
 * Interruptible TTS player that fetches server-synthesized audio first, plays it
 * through a Web Audio AnalyserNode for real-time 30fps output metering, and
 * falls back cleanly to browser SpeechSynthesis with simulated level envelopes.
 */
export function createVoiceTtsPlayer(options: VoiceTtsPlayerOptions): VoiceTtsPlayer {
  let speaking = false;
  let playbackToken = 0;
  let abortController: AbortController | null = null;
  let audioContext: AudioContext | null = null;
  let activeSource: AudioBufferSourceNode | null = null;
  let activeAnalyser: AnalyserNode | null = null;
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  let resolvePending: (() => void) | null = null;

  const setSpeakingState = (next: boolean) => {
    if (speaking === next) return;
    speaking = next;
    options.onSpeakingChange?.(next);
  };

  const stopMeter = () => {
    if (meterTimer !== null) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
    options.onOutputLevel(0);
  };

  const stopPlaybackResources = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (activeSource) {
      activeSource.onended = null;
      try {
        activeSource.stop(0);
      } catch {}
      try {
        activeSource.disconnect();
      } catch {}
      activeSource = null;
    }
    if (activeAnalyser) {
      try {
        activeAnalyser.disconnect();
      } catch {}
      activeAnalyser = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    stopMeter();
    setSpeakingState(false);
    if (resolvePending) {
      const resolve = resolvePending;
      resolvePending = null;
      resolve();
    }
  };

  const ensureAudioContext = async (): Promise<AudioContext> => {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  };

  const playAudioBuffer = async (arrayBuffer: ArrayBuffer, token: number): Promise<boolean> => {
    if (typeof AudioContext === "undefined") return false;
    const ctx = await ensureAudioContext();
    if (token !== playbackToken) return true;

    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (token !== playbackToken) return true;

    const source = ctx.createBufferSource();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.buffer = decoded;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    activeSource = source;
    activeAnalyser = analyser;

    const timeData = new Uint8Array(analyser.fftSize);
    let smoothed = 0;

    setSpeakingState(true);
    meterTimer = setInterval(() => {
      if (token !== playbackToken || !activeAnalyser) return;
      activeAnalyser.getByteTimeDomainData(timeData);
      let energy = 0;
      for (let i = 0; i < timeData.length; i += 1) {
        const normalized = ((timeData[i] ?? 128) - 128) / 128;
        energy += normalized * normalized;
      }
      const rms = Math.sqrt(energy / timeData.length);
      const target = Math.min(1, rms * 3.8);
      smoothed = smoothed * 0.45 + target * 0.55;
      options.onOutputLevel(smoothed);
    }, 33);

    await new Promise<void>((resolve) => {
      resolvePending = resolve;
      source.onended = () => {
        if (resolvePending === resolve) resolvePending = null;
        if (token === playbackToken) {
          activeSource = null;
          if (activeAnalyser) {
            try {
              activeAnalyser.disconnect();
            } catch {}
            activeAnalyser = null;
          }
          stopMeter();
          setSpeakingState(false);
        }
        resolve();
      };
      source.start(0);
    });

    return true;
  };

  const speakWithBrowserSynthesis = async (
    request: VoiceSpeakRequest,
    token: number,
  ): Promise<void> => {
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window) ||
      typeof SpeechSynthesisUtterance === "undefined"
    ) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(request.text);
    const voice = selectBrowserVoice(request.voice);
    if (voice) utterance.voice = voice;
    utterance.rate = clampSpeed(request.speed);

    let phase = 0;
    let pulse = 0.35;
    utterance.onboundary = () => {
      pulse = 0.72;
    };

    setSpeakingState(true);
    meterTimer = setInterval(() => {
      if (token !== playbackToken) return;
      phase += 0.36;
      pulse = Math.max(0.22, pulse * 0.88);
      const envelope = pulse + Math.sin(phase) * 0.16 + Math.sin(phase * 1.9 + 0.7) * 0.1;
      options.onOutputLevel(Math.max(0.08, Math.min(0.95, envelope)));
    }, 33);

    await new Promise<void>((resolve) => {
      const finish = () => {
        if (resolvePending === finish) resolvePending = null;
        if (token === playbackToken) {
          stopMeter();
          setSpeakingState(false);
        }
        resolve();
      };
      resolvePending = finish;
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  };

  return {
    speak: async (request: VoiceSpeakRequest) => {
      stopPlaybackResources();
      const text = request.text.trim();
      if (!text || request.provider === "off") return;

      const token = ++playbackToken;
      const normalizedRequest: VoiceSpeakRequest = {
        ...request,
        text,
        speed: clampSpeed(request.speed),
      };

      if (normalizedRequest.provider !== "browser") {
        const controller = new AbortController();
        abortController = controller;
        try {
          const apiConfig = await options.getApiConfig();
          if (token !== playbackToken) return;
          const fetchFn = options.fetchImpl ?? fetch;
          const base = apiConfig.baseUrl.replace(/\/+$/, "");
          const response = await fetchFn(`${base}/api/mattr/voice-assistant/speak`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...apiConfig.headers,
            },
            credentials: apiConfig.credentials ?? "include",
            body: JSON.stringify(normalizedRequest),
            signal: controller.signal,
          });
          if (token !== playbackToken) return;
          if (response.ok) {
            const bytes = await response.arrayBuffer();
            if (token !== playbackToken) return;
            if (bytes.byteLength > 0) {
              const played = await playAudioBuffer(bytes, token);
              if (played) return;
            }
          }
        } catch {
          if (controller.signal.aborted || token !== playbackToken) return;
          // Fall through seamlessly to browser speech synthesis.
        } finally {
          if (abortController === controller) abortController = null;
        }
      }

      if (token !== playbackToken) return;
      await speakWithBrowserSynthesis(normalizedRequest, token);
    },
    stop: () => {
      playbackToken += 1;
      stopPlaybackResources();
    },
    isSpeaking: () => speaking,
  };
}
