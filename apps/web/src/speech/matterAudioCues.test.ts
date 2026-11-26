import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_ISLAND_SETTINGS } from "../../../../matter/island/types";
import {
  encodeMonoPcmWav,
  LILT_SELECTED_CUES,
  liltNoteFrequency,
  liltVariationHash,
  MATTER_AUDIO_CUE_SAMPLE_RATE,
  renderMatterAudioCuePcm,
  type MatterAudioCueId,
} from "../../../../matter/voice-assistant/audioCuesSynth";
import type {
  VoiceAssistantTurnResponse,
  VoiceWorkspaceContext,
} from "../../../../matter/voice-assistant/types";
import { updateIslandSettings, updateVoiceAssistantSettings } from "../island/islandSettingsStore";
import {
  registerHostBridge,
  resetVoiceAssistantStoreForTests,
  setVoiceModeOpen,
  submitVoiceAssistantUtterance,
  toggleVoiceAssistantHandsFree,
} from "../island/voiceAssistantStore";
import {
  isMatterAudioCueEnabled,
  playMatterAudioCue,
  resetMatterAudioCuesForTests,
  setMatterAudioCueObserverForTests,
} from "./matterAudioCues";
import * as browserVoiceInput from "./browserVoiceInput";
import * as voiceConsent from "./voiceConsent";
import { VoiceInputSession } from "./voiceInputSession";

const ALL_CUES: ReadonlyArray<MatterAudioCueId> = [
  "dictation-start",
  "dictation-stop",
  "voice-mode-open",
  "voice-mode-close",
  "voice-mode-thinking",
];

function makeFakeAudioContext(options?: { readonly state?: AudioContextState }) {
  const createdBuffers: Array<{ readonly length: number; readonly sampleRate: number }> = [];
  const startedSources: Array<{ readonly buffer: AudioBuffer | null }> = [];
  const resume = vi.fn(async () => {
    ctx.state = "running";
  });
  const close = vi.fn(async () => {
    ctx.state = "closed";
  });
  const ctx = {
    state: (options?.state ?? "running") as AudioContextState,
    sampleRate: 48_000,
    destination: {} as AudioDestinationNode,
    resume,
    close,
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
      createdBuffers.push({ length, sampleRate });
      const data = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        copyToChannel: (src: Float32Array) => data.set(src),
        getChannelData: () => data,
      } as unknown as AudioBuffer;
    }),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as AudioBuffer | null,
        connect: vi.fn(),
        start: vi.fn(() => {
          startedSources.push({ buffer: source.buffer });
        }),
      };
      return source as unknown as AudioBufferSourceNode;
    }),
  };
  return { ctx, createdBuffers, startedSources, resume, close };
}

function emptyWorkspaceContext(): VoiceWorkspaceContext {
  return {
    activeEnvironmentId: "env-1",
    activeThreadId: "thread-1",
    activeRoute: "/env-1/thread-1",
    mainWindowFocused: true,
    composerFocused: false,
    projects: [],
    threads: [],
    pendingApprovals: [],
    pendingQuestions: [],
  };
}

describe("audioCuesSynth (Lilt pop DNA)", () => {
  it("matches Chris's selected Lilt pentatonic pitches and variation hash", () => {
    expect(LILT_SELECTED_CUES.theme).toBe("pop");
    expect(LILT_SELECTED_CUES.start).toEqual({ sound: "pop", note: 3, variation: 1 });
    expect(LILT_SELECTED_CUES.stop).toEqual({ sound: "pop", note: 0, variation: 7 });
    // Start = E5 (659.255 Hz), Stop = A4 (440 Hz)
    expect(liltNoteFrequency(3)).toBeCloseTo(659.255, 2);
    expect(liltNoteFrequency(0)).toBeCloseTo(440.0, 2);
    expect(liltVariationHash(1)).toBeCloseTo(0.527447, 5);
    expect(liltVariationHash(7)).toBeCloseTo(0.976908, 5);
  });

  it.each(ALL_CUES)("renders bounded, finite, non-silent PCM and valid WAV for %s", (cue) => {
    const pcm = renderMatterAudioCuePcm(cue, MATTER_AUDIO_CUE_SAMPLE_RATE);
    expect(pcm.length).toBeGreaterThan(1_000);
    let peak = 0;
    for (const sample of pcm) {
      expect(Number.isFinite(sample)).toBe(true);
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    expect(peak).toBeGreaterThan(0.15);
    expect(peak).toBeLessThanOrEqual(0.98);
    // Clean de-click fade-out at buffer end
    expect(Math.abs(pcm[pcm.length - 1] ?? 1)).toBeLessThan(0.01);

    const wav = encodeMonoPcmWav(pcm, MATTER_AUDIO_CUE_SAMPLE_RATE);
    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    const header = new TextDecoder().decode(wav.subarray(0, 4));
    const format = new TextDecoder().decode(wav.subarray(8, 12));
    expect(header).toBe("RIFF");
    expect(format).toBe("WAVE");
  });

  it("keeps the thinking pulse noticeably softer than dictation start", () => {
    const peakOf = (samples: Float32Array) => {
      let max = 0;
      for (const s of samples) max = Math.max(max, Math.abs(s));
      return max;
    };
    expect(peakOf(renderMatterAudioCuePcm("voice-mode-thinking"))).toBeLessThan(
      peakOf(renderMatterAudioCuePcm("dictation-start")) * 0.65,
    );
  });
});

describe("web matterAudioCues engine", () => {
  const originalAudioContext = globalThis.AudioContext;

  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetMatterAudioCuesForTests();
  });

  afterEach(() => {
    resetMatterAudioCuesForTests();
    if (originalAudioContext === undefined) {
      delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    } else {
      globalThis.AudioContext = originalAudioContext;
    }
  });

  it("is enabled by default and respects soundCuesEnabled and thinkingCueEnabled toggles", () => {
    expect(isMatterAudioCueEnabled("dictation-start")).toBe(true);
    expect(isMatterAudioCueEnabled("voice-mode-thinking")).toBe(true);

    updateVoiceAssistantSettings({ thinkingCueEnabled: false });
    expect(isMatterAudioCueEnabled("dictation-start")).toBe(true);
    expect(isMatterAudioCueEnabled("voice-mode-open")).toBe(true);
    expect(isMatterAudioCueEnabled("voice-mode-thinking")).toBe(false);

    updateVoiceAssistantSettings({ soundCuesEnabled: false, thinkingCueEnabled: true });
    for (const cue of ALL_CUES) {
      expect(isMatterAudioCueEnabled(cue)).toBe(false);
    }
  });

  it("plays via Web Audio API, caches rendered buffers, and resumes suspended contexts", async () => {
    const fake = makeFakeAudioContext({ state: "suspended" });
    globalThis.AudioContext = vi.fn(function () {
      return fake.ctx;
    }) as unknown as typeof AudioContext;

    expect(playMatterAudioCue("dictation-start")).toBe(true);
    expect(fake.resume).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(fake.createdBuffers).toHaveLength(1);
    expect(fake.startedSources).toHaveLength(1);

    // Second play reuses the cached AudioBuffer
    expect(playMatterAudioCue("dictation-start")).toBe(true);
    expect(fake.createdBuffers).toHaveLength(1);
    expect(fake.startedSources).toHaveLength(2);
  });

  it("never throws when AudioContext is absent or throws in headless environments", () => {
    delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    expect(() => playMatterAudioCue("dictation-start")).not.toThrow();
    expect(playMatterAudioCue("dictation-start")).toBe(false);

    globalThis.AudioContext = vi.fn(function () {
      throw new Error("No audio device");
    }) as unknown as typeof AudioContext;
    expect(() => playMatterAudioCue("dictation-stop")).not.toThrow();
    expect(playMatterAudioCue("dictation-stop")).toBe(false);
  });
});

describe("web Voice Mode audio cue trigger points", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetMatterAudioCuesForTests();
    resetVoiceAssistantStoreForTests();
  });

  afterEach(() => {
    resetVoiceAssistantStoreForTests();
    resetMatterAudioCuesForTests();
  });

  it("fires voice-mode-open on modal open, voice-mode-close on close, and a single thinking pulse per turn", async () => {
    const played: MatterAudioCueId[] = [];
    setMatterAudioCueObserverForTests((cue) => played.push(cue));

    const turnResponse: VoiceAssistantTurnResponse = {
      route: "assistant",
      spokenReply: "All good.",
      displayReply: "All good.",
      expectFollowUp: false,
      toolResults: [],
      clientActions: [],
    };
    const unregister = registerHostBridge({
      getWorkspaceContext: emptyWorkspaceContext,
      executeClientAction: vi.fn(),
      transcribePcm: vi.fn(async () => ""),
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773", headers: {} }),
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify(turnResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ) as unknown as typeof fetch,
      createTtsPlayer: () => ({
        speak: vi.fn(async () => {}),
        stop: vi.fn(),
        isSpeaking: () => false,
      }),
    });

    try {
      setVoiceModeOpen(true, { autoStartHandsFree: false });
      setVoiceModeOpen(true, { autoStartHandsFree: false }); // idempotent, should not double-fire
      expect(played).toEqual(["voice-mode-open"]);

      await submitVoiceAssistantUtterance("what is running?", {
        modeOverride: "voice-mode",
        speakOverride: false,
      });
      expect(played).toEqual(["voice-mode-open", "voice-mode-thinking"]);

      // Direct dictation utterances do not emit the Voice Mode thinking pulse
      await submitVoiceAssistantUtterance("just dictate this", {
        modeOverride: "dictation",
        speakOverride: false,
      });
      expect(played).toEqual(["voice-mode-open", "voice-mode-thinking"]);

      setVoiceModeOpen(false);
      expect(played).toEqual(["voice-mode-open", "voice-mode-thinking", "voice-mode-close"]);
    } finally {
      unregister();
    }
  });

  it("fires voice-mode-open and voice-mode-close when toggling hands-free outside the modal", async () => {
    const played: MatterAudioCueId[] = [];
    setMatterAudioCueObserverForTests((cue) => played.push(cue));

    let active = false;
    const unregister = registerHostBridge({
      getWorkspaceContext: emptyWorkspaceContext,
      executeClientAction: vi.fn(),
      transcribePcm: vi.fn(async () => ""),
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773", headers: {} }),
      createVadCapture: () => ({
        start: vi.fn(async () => {
          active = true;
        }),
        stop: vi.fn(() => {
          active = false;
        }),
        setMuted: vi.fn(),
        setSpeakingDuck: vi.fn(),
        isActive: () => active,
      }),
    });

    try {
      toggleVoiceAssistantHandsFree();
      await Promise.resolve();
      expect(played).toEqual(["voice-mode-open"]);

      toggleVoiceAssistantHandsFree();
      expect(played).toEqual(["voice-mode-open", "voice-mode-close"]);
    } finally {
      unregister();
    }
  });

  it("suppresses thinking pulse when thinkingCueEnabled is off while keeping open/close cues", async () => {
    updateVoiceAssistantSettings({ thinkingCueEnabled: false });
    const played: MatterAudioCueId[] = [];
    setMatterAudioCueObserverForTests((cue) => played.push(cue));

    const unregister = registerHostBridge({
      getWorkspaceContext: emptyWorkspaceContext,
      executeClientAction: vi.fn(),
      transcribePcm: vi.fn(async () => ""),
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773", headers: {} }),
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              route: "assistant",
              spokenReply: "Done.",
              displayReply: "Done.",
              expectFollowUp: false,
              toolResults: [],
              clientActions: [],
            } satisfies VoiceAssistantTurnResponse),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ) as unknown as typeof fetch,
    });

    try {
      setVoiceModeOpen(true, { autoStartHandsFree: false });
      await submitVoiceAssistantUtterance("check status", {
        modeOverride: "voice-mode",
        speakOverride: false,
      });
      setVoiceModeOpen(false);
      expect(played).toEqual(["voice-mode-open", "voice-mode-close"]);
    } finally {
      unregister();
    }
  });
});

describe("web dictation audio cue trigger points", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetMatterAudioCuesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMatterAudioCuesForTests();
  });

  it("fires dictation-start on recording start and dictation-stop when recording stops", async () => {
    const played: MatterAudioCueId[] = [];
    setMatterAudioCueObserverForTests((cue) => played.push(cue));

    vi.spyOn(browserVoiceInput, "createAppleSpeechVoiceInputPlatform").mockReturnValue({
      recorder: {
        uri: "blob:dictation-test",
        prepareToRecordAsync: vi.fn(async () => {}),
        record: vi.fn(),
        stop: vi.fn(async () => {}),
      },
      transcriber: {
        prepare: vi.fn(async () => ({
          locale: "en-US",
          transcribe: vi.fn(async () => "hello world"),
        })),
      },
      cancelRecording: vi.fn(),
      deleteRecording: vi.fn(),
    });

    vi.spyOn(voiceConsent, "bindAudioGrant").mockReturnValue(() => true);
    const session = new VoiceInputSession({
      prepared: null,
      grantId: "test-grant-1",
      cloudProvider: undefined,
      cloudModel: undefined,
    });

    try {
      await session.start({
        ownerKey: "draft-1",
        label: "Test thread",
        persistent: false,
        open: null,
        readDraft: () => ({ text: "", selection: { start: 0, end: 0 } }),
        commitDraft: vi.fn(),
        readContext: () => ({
          environmentId: EnvironmentId.make("env-1"),
          projectName: null,
          projectWords: [],
          clientSettings: DEFAULT_CLIENT_SETTINGS,
          cleanup: false,
          cleanupPrepared: null,
        }),
      });
      expect(session.state.phase).toBe("recording");
      expect(played).toEqual(["dictation-start"]);

      await session.stop();
      expect(played).toEqual(["dictation-start", "dictation-stop"]);
    } finally {
      session.dispose();
    }
  });
});
