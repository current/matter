/**
 * Pure TypeScript synthesis of Chris's Lilt audio cues + complementary Voice Mode cues.
 *
 * Mirrors Lilt's `lilt_lib::synth` (`pop` recipe, major pentatonic pitch table, Mulberry32
 * variation hash, RBJ biquad high-pass noise transient, and warm damped room tail) so Web,
 * Desktop, and Mobile share identical sonic DNA with zero external asset dependencies.
 */

export type MatterAudioCueId =
  | "dictation-start"
  | "dictation-stop"
  | "voice-mode-open"
  | "voice-mode-close"
  | "voice-mode-thinking";

export const MATTER_AUDIO_CUE_SAMPLE_RATE = 48_000;

/**
 * Chris's active Lilt configuration from `~/Library/Application Support/dev.lilt.app/settings.json`:
 * theme "pop", cueVolume 0.65, start = pop(note: 3, variation: 1), stop = pop(note: 0, variation: 7).
 */
export const LILT_SELECTED_CUES = {
  theme: "pop",
  volume: 0.65,
  start: { sound: "pop", note: 3, variation: 1 },
  stop: { sound: "pop", note: 0, variation: 7 },
} as const;

const PENTATONIC_SEMITONES = [0, 2, 4, 7, 9] as const;
const POP_HASH_SALT = 0x47826ddf;
const DECAY_FLOOR = 0.0001; // -80 dB, matching lilt_lib::synth::Mix::voice

/** Pentatonic pitch table from `lilt_lib::synth::render_dry`: A4 (440 Hz) upward. */
export function liltNoteFrequency(note: number): number {
  const clamped = Math.min(9, Math.max(0, Math.floor(note)));
  const octave = Math.floor(clamped / 5);
  const degree = clamped % 5;
  const semitones = PENTATONIC_SEMITONES[degree]! + octave * 12 + 12;
  return 220 * 2 ** (semitones / 12);
}

/** Deterministic Mulberry32-style hash used by `lilt_lib::synth::render_dry` for variation. */
export function liltVariationHash(variation: number, salt = POP_HASH_SALT): number {
  let x = (variation + salt) >>> 0;
  x = Math.imul(x ^ (x >>> 15), x | 1) >>> 0;
  x = (x ^ ((x + Math.imul(x ^ (x >>> 7), x | 61)) >>> 0)) >>> 0;
  x = (x ^ (x >>> 14)) >>> 0;
  return x / 4_294_967_296;
}

class MixBuffer {
  private samples: Float32Array;
  private length = 0;

  constructor(
    readonly sampleRate: number,
    initialCapacity = 16_384,
  ) {
    this.samples = new Float32Array(initialCapacity);
  }

  private ensure(minLength: number): void {
    if (minLength <= this.samples.length) return;
    let next = this.samples.length;
    while (next < minLength) next *= 2;
    const grown = new Float32Array(next);
    grown.set(this.samples.subarray(0, this.length));
    this.samples = grown;
  }

  addSineVoice(opts: {
    readonly delaySec?: number;
    readonly startFreq: number;
    readonly endFreq: number;
    readonly glideSec: number;
    readonly attackSec: number;
    readonly decaySec: number;
    readonly gain: number;
    readonly harmonic2Gain?: number;
  }): void {
    const startIdx = Math.max(0, Math.round((opts.delaySec ?? 0) * this.sampleRate));
    const totalSec = opts.attackSec + opts.decaySec;
    const count = Math.max(1, Math.round(totalSec * this.sampleRate));
    const endIdx = startIdx + count;
    this.ensure(endIdx);
    if (endIdx > this.length) this.length = endIdx;

    const nyquist = this.sampleRate * 0.5;
    const ratio = opts.endFreq / opts.startFreq;
    const h2 = opts.harmonic2Gain ?? 0;
    let phase = 0;

    for (let i = 0; i < count; i += 1) {
      const t = i / this.sampleRate;
      const freq =
        opts.glideSec > 0
          ? opts.startFreq * ratio ** Math.min(1, t / opts.glideSec)
          : opts.startFreq;
      if (freq < nyquist) {
        let env: number;
        if (opts.attackSec > 0 && t < opts.attackSec) {
          env = t / opts.attackSec;
        } else {
          const decayT = Math.max(0, t - opts.attackSec);
          env = opts.decaySec > 0 ? DECAY_FLOOR ** (decayT / opts.decaySec) : 0;
        }
        const angle = 2 * Math.PI * phase;
        const wave = Math.sin(angle) + (h2 > 0 ? h2 * Math.sin(2 * angle) : 0);
        this.samples[startIdx + i] = (this.samples[startIdx + i] ?? 0) + wave * opts.gain * env;
      }
      phase = (phase + freq / this.sampleRate) % 1;
    }
  }

  addHighPassNoise(opts: {
    readonly delaySec?: number;
    readonly cutoffHz: number;
    readonly q: number;
    readonly attackSec: number;
    readonly decaySec: number;
    readonly gain: number;
    readonly seed: number;
  }): void {
    const startIdx = Math.max(0, Math.round((opts.delaySec ?? 0) * this.sampleRate));
    const totalSec = opts.attackSec + opts.decaySec;
    const count = Math.max(1, Math.round(totalSec * this.sampleRate));
    const endIdx = startIdx + count;
    this.ensure(endIdx);
    if (endIdx > this.length) this.length = endIdx;

    const clampedCutoff = Math.min(this.sampleRate * 0.49, Math.max(10, opts.cutoffHz));
    const w0 = (2 * Math.PI * clampedCutoff) / this.sampleRate;
    const sinW0 = Math.sin(w0);
    const cosW0 = Math.cos(w0);
    const q = Math.max(0.05, opts.q);
    const alpha = sinW0 / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (1 + cosW0) / (2 * a0);
    const b1 = -(1 + cosW0) / a0;
    const b2 = (1 + cosW0) / (2 * a0);
    const a1 = (-2 * cosW0) / a0;
    const a2 = (1 - alpha) / a0;

    let state = opts.seed >>> 0 || 1;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;

    for (let i = 0; i < count; i += 1) {
      // Deterministic xorshift32 white noise in [-1, 1]
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const x0 = (state >>> 0) / 2_147_483_648 - 1;
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;

      const t = i / this.sampleRate;
      let env: number;
      if (opts.attackSec > 0 && t < opts.attackSec) {
        env = t / opts.attackSec;
      } else {
        const decayT = Math.max(0, t - opts.attackSec);
        env = opts.decaySec > 0 ? DECAY_FLOOR ** (decayT / opts.decaySec) : 0;
      }
      this.samples[startIdx + i] = (this.samples[startIdx + i] ?? 0) + y0 * opts.gain * env;
    }
  }

  toFloat32Array(): Float32Array {
    return this.samples.slice(0, this.length);
  }
}

/**
 * Exact `Recipe::Pop` from `lilt_lib::synth::render_dry`:
 * descending pitch-swept sine (`1.6 * f0 -> 0.5 * f0`) plus a crisp 8 ms 2.5 kHz HPF noise pop.
 */
function renderLiltPopDry(note: number, variation: number, sampleRate: number): Float32Array {
  const f0 = liltNoteFrequency(note);
  const decaySec = 0.03 + liltVariationHash(variation) * 0.03;
  const glideSec = decaySec * 0.7;

  const mix = new MixBuffer(sampleRate);
  mix.addSineVoice({
    startFreq: f0 * 1.6,
    endFreq: f0 * 0.5,
    glideSec,
    attackSec: 0.001,
    decaySec,
    gain: 0.6,
  });
  mix.addHighPassNoise({
    cutoffHz: 2500,
    q: 1.0,
    attackSec: 0.001,
    decaySec: 0.008,
    gain: 0.3,
    seed: (variation + 1) * 0x9e3779b1,
  });
  return mix.toFloat32Array();
}

/**
 * Subtle warm room reflection + loudness leveling matching Lilt's `synth::render` polish,
 * keeping cues crisp and short without ringing over speech capture.
 */
function applyLiltFinish(
  dry: Float32Array,
  sampleRate: number,
  options: { readonly targetPeak: number; readonly wetMix?: number; readonly tailSec?: number },
): Float32Array {
  const wetMix = options.wetMix ?? 0.22;
  const dryMix = 0.7;
  const feedback = 0.28;
  const delaySamples = Math.max(1, Math.round(sampleRate * 0.048));
  const tailSamples = Math.round(sampleRate * (options.tailSec ?? 0.14));
  const outLen = dry.length + tailSamples;
  const out = new Float32Array(outLen);
  const delayLine = new Float32Array(delaySamples);

  // One-pole low-pass inside the room feedback loop (~2.8 kHz damping)
  const lpAlpha = 0.32;
  let lpState = 0;

  for (let i = 0; i < outLen; i += 1) {
    const input = i < dry.length ? (dry[i] ?? 0) * dryMix : 0;
    const idx = i % delaySamples;
    const delayed = delayLine[idx] ?? 0;
    lpState = lpState + lpAlpha * (delayed - lpState);
    delayLine[idx] = input + lpState * feedback;
    out[i] = input + lpState * wetMix;
  }

  // Trim silent tail beyond -64 dB to keep clips compact on mobile & web
  let peak = 0;
  for (let i = 0; i < out.length; i += 1) {
    const abs = Math.abs(out[i] ?? 0);
    if (abs > peak) peak = abs;
  }
  const threshold = peak * 0.0006;
  let trimmedEnd = out.length;
  while (trimmedEnd > dry.length && Math.abs(out[trimmedEnd - 1] ?? 0) < threshold) {
    trimmedEnd -= 1;
  }
  const result = out.slice(0, Math.max(dry.length, trimmedEnd));

  // Normalize cleanly to targetPeak with a 3 ms de-click fade-out
  if (peak > 1e-6) {
    const scale = options.targetPeak / peak;
    for (let i = 0; i < result.length; i += 1) {
      result[i] = Math.max(-0.98, Math.min(0.98, (result[i] ?? 0) * scale));
    }
  }
  const fadeSamples = Math.min(result.length, Math.round(sampleRate * 0.003));
  for (let i = 0; i < fadeSamples; i += 1) {
    const idx = result.length - fadeSamples + i;
    result[idx] = (result[idx] ?? 0) * (1 - i / fadeSamples);
  }
  return result;
}

/**
 * Renders mono Float32 PCM samples in [-1, 1] for any Matter audio cue.
 */
export function renderMatterAudioCuePcm(
  cue: MatterAudioCueId,
  sampleRate = MATTER_AUDIO_CUE_SAMPLE_RATE,
): Float32Array {
  const basePeak = LILT_SELECTED_CUES.volume;

  switch (cue) {
    case "dictation-start": {
      const dry = renderLiltPopDry(
        LILT_SELECTED_CUES.start.note,
        LILT_SELECTED_CUES.start.variation,
        sampleRate,
      );
      return applyLiltFinish(dry, sampleRate, { targetPeak: basePeak, tailSec: 0.1 });
    }

    case "dictation-stop": {
      const dry = renderLiltPopDry(
        LILT_SELECTED_CUES.stop.note,
        LILT_SELECTED_CUES.stop.variation,
        sampleRate,
      );
      return applyLiltFinish(dry, sampleRate, { targetPeak: basePeak * 0.94, tailSec: 0.1 });
    }

    case "voice-mode-open": {
      // Rising A4 -> E5 Lilt-family conversational bloom (same pentatonic fifth as Chris's pops)
      const a4 = liltNoteFrequency(0);
      const e5 = liltNoteFrequency(3);
      const mix = new MixBuffer(sampleRate);
      mix.addSineVoice({
        delaySec: 0,
        startFreq: a4 * 0.88,
        endFreq: a4,
        glideSec: 0.028,
        attackSec: 0.002,
        decaySec: 0.11,
        gain: 0.48,
        harmonic2Gain: 0.14,
      });
      mix.addHighPassNoise({
        delaySec: 0,
        cutoffHz: 2600,
        q: 1.0,
        attackSec: 0.001,
        decaySec: 0.006,
        gain: 0.14,
        seed: 0x1117a401,
      });
      mix.addSineVoice({
        delaySec: 0.068,
        startFreq: e5 * 0.92,
        endFreq: e5,
        glideSec: 0.032,
        attackSec: 0.002,
        decaySec: 0.165,
        gain: 0.56,
        harmonic2Gain: 0.12,
      });
      mix.addHighPassNoise({
        delaySec: 0.068,
        cutoffHz: 2800,
        q: 1.0,
        attackSec: 0.001,
        decaySec: 0.006,
        gain: 0.12,
        seed: 0x1117e502,
      });
      return applyLiltFinish(mix.toFloat32Array(), sampleRate, {
        targetPeak: basePeak * 0.92,
        wetMix: 0.26,
        tailSec: 0.14,
      });
    }

    case "voice-mode-close": {
      // Complementary gentle falling E5 -> A4 release
      const a4 = liltNoteFrequency(0);
      const e5 = liltNoteFrequency(3);
      const mix = new MixBuffer(sampleRate);
      mix.addSineVoice({
        delaySec: 0,
        startFreq: e5 * 1.04,
        endFreq: e5 * 0.96,
        glideSec: 0.03,
        attackSec: 0.002,
        decaySec: 0.095,
        gain: 0.44,
        harmonic2Gain: 0.08,
      });
      mix.addSineVoice({
        delaySec: 0.062,
        startFreq: a4 * 1.05,
        endFreq: a4 * 0.94,
        glideSec: 0.04,
        attackSec: 0.002,
        decaySec: 0.155,
        gain: 0.48,
        harmonic2Gain: 0.06,
      });
      return applyLiltFinish(mix.toFloat32Array(), sampleRate, {
        targetPeak: basePeak * 0.8,
        wetMix: 0.24,
        tailSec: 0.13,
      });
    }

    case "voice-mode-thinking": {
      // Single subtle, warm, muted soft pulse on turn handoff (never looping, no harsh click)
      const e4 = liltNoteFrequency(3) * 0.5; // 329.63 Hz — warm octave below Start cue
      const mix = new MixBuffer(sampleRate);
      mix.addSineVoice({
        delaySec: 0,
        startFreq: e4 * 0.86,
        endFreq: e4 * 1.02,
        glideSec: 0.038,
        attackSec: 0.006,
        decaySec: 0.095,
        gain: 0.34,
        harmonic2Gain: 0.04,
      });
      return applyLiltFinish(mix.toFloat32Array(), sampleRate, {
        targetPeak: basePeak * 0.46,
        wetMix: 0.18,
        tailSec: 0.09,
      });
    }
  }
}

/** Encodes mono Float32 PCM samples into a compact 16-bit PCM RIFF/WAVE byte buffer. */
export function encodeMonoPcmWav(
  samples: Float32Array,
  sampleRate = MATTER_AUDIO_CUE_SAMPLE_RATE,
): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true);
  }

  return new Uint8Array(buffer);
}
