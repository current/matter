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
