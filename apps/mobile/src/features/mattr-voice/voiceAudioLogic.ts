export const WAV_HEADER_BYTES = 44;
export const VOICE_PCM_SAMPLE_RATE = 16_000;

/** Wraps signed 16-bit little-endian mono PCM in a canonical 44-byte RIFF/WAV header. */
export function buildWavFile(
  pcm: Uint8Array,
  sampleRate: number = VOICE_PCM_SAMPLE_RATE,
  channels = 1,
): Uint8Array {
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      wav[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}

export interface VoiceActivityConfig {
  /** Level (dBFS) that counts as speech, before the adaptive noise floor raises it. */
  readonly onsetDb: number;
  /** Level (dBFS) under which the speaker counts as silent while speaking. */
  readonly offsetDb: number;
  /** The measured noise floor never rises above this, so speech at the first reading still counts. */
  readonly maxNoiseFloorDb: number;
  /** How far above the measured noise floor speech must rise. */
  readonly onsetMarginDb: number;
  readonly offsetMarginDb: number;
  /** Sustained time above the onset level before speech starts (rejects clicks). */
  readonly onsetMs: number;
  /** Silence that ends an utterance. */
  readonly silenceMs: number;
  /** Utterances shorter than this are not ended by silence yet. */
  readonly minSpeechMs: number;
  readonly maxUtteranceMs: number;
  /** Gives up when nobody speaks for this long; null waits forever. */
  readonly noSpeechTimeoutMs: number | null;
  /** Learns the floor without detecting speech for this long after the first reading. */
  readonly warmupMs: number;
  /** Onset never needs more than this, so a loud floor cannot make speech undetectable. */
  readonly maxOnsetDb: number;
  /** Share of the gap the floor closes per quieter reading; 1 drops to it at once. */
  readonly floorFall: number;
}

export const LISTENING_VAD: VoiceActivityConfig = {
  onsetDb: -34,
  offsetDb: -42,
  maxNoiseFloorDb: -38,
  onsetMarginDb: 10,
  offsetMarginDb: 6,
  onsetMs: 120,
  silenceMs: 1150,
  minSpeechMs: 300,
  maxUtteranceMs: 90_000,
  noSpeechTimeoutMs: null,
  warmupMs: 0,
  maxOnsetDb: 0,
  floorFall: 1,
};

/**
 * Without echo cancellation the reply itself reaches the microphone, so interrupting needs a
 * louder, longer onset measured against the playback level learned during the warmup.
 */
export const BARGE_IN_VAD: VoiceActivityConfig = {
  ...LISTENING_VAD,
  onsetDb: -20,
  maxNoiseFloorDb: -12,
  onsetMarginDb: 12,
  onsetMs: 280,
  noSpeechTimeoutMs: null,
  warmupMs: 700,
  maxOnsetDb: -6,
  // Pauses between sentences must not drop the floor, or the next sentence reads as speech.
  floorFall: 0.02,
};

export type VoiceActivityEvent =
  | "none"
  | "speech-start"
  | "end-of-speech"
  | "max-duration"
  | "no-speech-timeout";

/** Endpointing over metering samples; time is passed in so it is deterministic to test. */
export function createVoiceActivityDetector(config: VoiceActivityConfig) {
  let startedAt: number | null = null;
  let aboveSince: number | null = null;
  let speechStartedAt: number | null = null;
  let lastVoiceAt = 0;
  let noiseFloor: number | null = null;

  const push = (decibels: number | undefined, now: number): VoiceActivityEvent => {
    const level = decibels === undefined || !Number.isFinite(decibels) ? -160 : decibels;
    startedAt ??= now;
    if (speechStartedAt === null) {
      // The floor falls at `floorFall` and creeps up, so steady engine noise raises the
      // threshold without a speaker's first word becoming the floor. During warmup it moves
      // fast to the level already present, such as the reply playing back.
      const warming = now - startedAt < config.warmupMs;
      const rate = level < (noiseFloor ?? level) ? config.floorFall : 0.04;
      noiseFloor = Math.min(
        config.maxNoiseFloorDb,
        noiseFloor === null ? level : noiseFloor + (warming ? 0.35 : rate) * (level - noiseFloor),
      );
      if (warming) return "none";
      const onset = Math.min(
        config.maxOnsetDb,
        Math.max(config.onsetDb, noiseFloor + config.onsetMarginDb),
      );
      if (level >= onset) {
        aboveSince ??= now;
        if (now - aboveSince >= config.onsetMs) {
          speechStartedAt = aboveSince;
          lastVoiceAt = now;
          return "speech-start";
        }
      } else {
        aboveSince = null;
      }
      if (config.noSpeechTimeoutMs !== null && now - startedAt >= config.noSpeechTimeoutMs) {
        return "no-speech-timeout";
      }
      return "none";
    }
    const offset = Math.max(config.offsetDb, (noiseFloor ?? -160) + config.offsetMarginDb);
    if (level >= offset) lastVoiceAt = now;
    if (now - speechStartedAt >= config.maxUtteranceMs) return "max-duration";
    if (now - lastVoiceAt >= config.silenceMs && now - speechStartedAt >= config.minSpeechMs) {
      return "end-of-speech";
    }
    return "none";
  };

  return {
    push,
    get speaking() {
      return speechStartedAt !== null;
    },
  };
}

export type VoiceActivityDetector = ReturnType<typeof createVoiceActivityDetector>;

/** Maps an HTTP audio content type to the cache file extension the player recognizes. */
export function audioExtensionForContentType(contentType: string | null | undefined): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("wav")) return "wav";
  if (type.includes("ogg") || type.includes("opus")) return "ogg";
  if (type.includes("aac")) return "aac";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  return "mp3";
}
