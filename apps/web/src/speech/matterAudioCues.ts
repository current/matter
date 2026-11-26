import {
  MATTR_AUDIO_CUE_SAMPLE_RATE,
  renderMattrAudioCuePcm,
  type MattrAudioCueId,
} from "../../../../antimatter/voice-assistant/audioCuesSynth";
import { getIslandSettings } from "../island/islandSettingsStore";

export type { MattrAudioCueId };

type AudioContextConstructor = typeof AudioContext;

let sharedContext: AudioContext | null = null;
const bufferCache = new Map<MattrAudioCueId, AudioBuffer>();
let testObserver: ((cue: MattrAudioCueId) => void) | null = null;

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof globalThis === "undefined") return null;
  const host = globalThis as typeof globalThis & {
    readonly webkitAudioContext?: AudioContextConstructor;
  };
  return host.AudioContext ?? host.webkitAudioContext ?? null;
}

function getOrCreateAudioContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== "closed") {
    return sharedContext;
  }
  const Ctor = resolveAudioContextConstructor();
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
    bufferCache.clear();
    return sharedContext;
  } catch {
    return null;
  }
}

function getOrCreateCueBuffer(ctx: AudioContext, cue: MattrAudioCueId): AudioBuffer | null {
  const cached = bufferCache.get(cue);
  if (cached) return cached;
  try {
    const sampleRate =
      typeof ctx.sampleRate === "number" && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0
        ? ctx.sampleRate
        : MATTR_AUDIO_CUE_SAMPLE_RATE;
    const pcm = renderMattrAudioCuePcm(cue, sampleRate);
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    if (typeof buffer.copyToChannel === "function") {
      buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    } else {
      buffer.getChannelData(0).set(pcm);
    }
    bufferCache.set(cue, buffer);
    return buffer;
  } catch {
    return null;
  }
}

export function isMattrAudioCueEnabled(cue: MattrAudioCueId): boolean {
  const voice = getIslandSettings().voiceAssistant;
  if (!voice.soundCuesEnabled) return false;
  if (cue === "voice-mode-thinking" && !voice.thinkingCueEnabled) return false;
  return true;
}

/**
 * Plays a Lilt-family audio cue via Web Audio API.
 * Never throws or blocks mic capture / TTS when audio hardware or AudioContext is unavailable.
 */
export function playMattrAudioCue(
  cue: MattrAudioCueId,
  options?: { readonly force?: boolean },
): boolean {
  if (!options?.force && !isMattrAudioCueEnabled(cue)) {
    return false;
  }

  testObserver?.(cue);

  const ctx = getOrCreateAudioContext();
  if (!ctx) return false;

  const buffer = getOrCreateCueBuffer(ctx, cue);
  if (!buffer) return false;

  const startSource = () => {
    try {
      if (ctx.state === "closed") return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // Audio hardware may be unavailable or restricted in background/headless contexts.
    }
  };

  try {
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      void ctx
        .resume()
        .then(startSource)
        .catch(() => undefined);
    } else {
      startSource();
    }
    return true;
  } catch {
    return false;
  }
}

export function setMattrAudioCueObserverForTests(
  observer: ((cue: MattrAudioCueId) => void) | null,
): void {
  testObserver = observer;
}

export function resetMattrAudioCuesForTests(): void {
  testObserver = null;
  bufferCache.clear();
  if (sharedContext) {
    try {
      void sharedContext.close?.().catch(() => undefined);
    } catch {}
    sharedContext = null;
  }
}
