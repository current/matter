import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import { resetVoiceInputGlobalsForTests } from "../../../../packages/client-runtime/src/voice-input/controller";
import type {
  VoiceAssistantTurnResponse,
  VoiceWorkspaceContext,
} from "../../../../antimatter/voice-assistant/types";

const mocks = vi.hoisted(() => {
  const players: Array<{
    readonly source: unknown;
    readonly options: unknown;
    readonly play: ReturnType<typeof vi.fn>;
    readonly pause: ReturnType<typeof vi.fn>;
    readonly release: ReturnType<typeof vi.fn>;
    readonly emitStatus: (status: Record<string, unknown>) => void;
  }> = [];
  const writtenFiles: Array<{ readonly uri: string; readonly bytes: Uint8Array }> = [];
  const createAudioPlayer = vi.fn((source: unknown, options: unknown) => {
    const listeners: Array<(status: Record<string, unknown>) => void> = [];
    const play = vi.fn();
    const pause = vi.fn();
    const release = vi.fn();
    const record = {
      source,
      options,
      play,
      pause,
      release,
      emitStatus: (status: Record<string, unknown>) => {
        for (const listener of listeners) listener(status);
      },
    };
    players.push(record);
    return {
      play,
      pause,
      release,
      addListener: vi.fn((_event: string, listener: (status: Record<string, unknown>) => void) => {
        listeners.push(listener);
        return { remove: vi.fn() };
      }),
    };
  });
  const setAudioModeAsync = vi.fn(async () => {});
  const setIsAudioActiveAsync = vi.fn(async () => {});
  return { players, writtenFiles, createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync };
});

vi.mock("expo-audio", () => ({
  AudioModule: {},
  createAudioPlayer: mocks.createAudioPlayer,
  setAudioModeAsync: mocks.setAudioModeAsync,
  setIsAudioActiveAsync: mocks.setIsAudioActiveAsync,
}));

vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class FakeFile {
    readonly uri: string;
    constructor(base: string, name: string) {
      this.uri = `${base}/${name}`;
    }
    create() {}
    async write(bytes: Uint8Array) {
      mocks.writtenFiles.push({ uri: this.uri, bytes });
    }
  },
}));

import {
  isMobileAudioCueEnabled,
  playMobileAudioCue,
  resetMobileAudioCuesForTests,
} from "./mattrAudioCues";
import {
  createVoiceInputTarget,
  VoiceInputSession,
} from "../features/voice-input/voiceInputSession";
import { VoiceModeSession, type VoiceModeAudio } from "../features/mattr-voice/voiceModeSession";
import type {
  ActiveListening,
  ActivePlayback,
  ListenResult,
} from "../features/mattr-voice/nativeVoiceAudio";
import type { VoiceAssistantApi } from "../features/mattr-voice/voiceAssistantApi";

describe("mobile mattrAudioCues", () => {
  beforeEach(() => {
    resetMobileAudioCuesForTests();
    resetVoiceInputGlobalsForTests();
    mocks.players.length = 0;
    mocks.writtenFiles.length = 0;
    mocks.createAudioPlayer.mockClear();
    mocks.setAudioModeAsync.mockClear();
    mocks.setIsAudioActiveAsync.mockClear();
  });

  it("defaults enabled and honors voiceSoundCuesEnabled and voiceThinkingCueEnabled", () => {
    expect(isMobileAudioCueEnabled("dictation-start", {})).toBe(true);
    expect(isMobileAudioCueEnabled("voice-mode-thinking", {})).toBe(true);
    expect(isMobileAudioCueEnabled("voice-mode-thinking", { voiceThinkingCueEnabled: false })).toBe(
      false,
    );
    expect(isMobileAudioCueEnabled("dictation-start", { voiceThinkingCueEnabled: false })).toBe(
      true,
    );
    expect(isMobileAudioCueEnabled("dictation-start", { voiceSoundCuesEnabled: false })).toBe(
      false,
    );
    expect(isMobileAudioCueEnabled("voice-mode-open", { voiceSoundCuesEnabled: false })).toBe(
      false,
    );
  });

  it("writes cached WAV cues, plays with keepAudioSessionActive, and never mutates audio mode", async () => {
    const first = await playMobileAudioCue("dictation-start", { preferences: {} });
    expect(first).toBe(true);
    expect(mocks.writtenFiles).toHaveLength(1);
    const header = new TextDecoder().decode(mocks.writtenFiles[0]!.bytes.subarray(0, 4));
    expect(header).toBe("RIFF");

    expect(mocks.createAudioPlayer).toHaveBeenCalledWith(
      { uri: "file:///cache/mattr-audio-cue-v1-dictation-start.wav" },
      { updateInterval: 100, keepAudioSessionActive: true },
    );
    expect(mocks.players[0]!.play).toHaveBeenCalledTimes(1);
    expect(mocks.setAudioModeAsync).not.toHaveBeenCalled();
    expect(mocks.setIsAudioActiveAsync).not.toHaveBeenCalled();

    // Finishing playback disposes the player cleanly
    mocks.players[0]!.emitStatus({ didJustFinish: true });
    await Promise.resolve();
    expect(mocks.players[0]!.release).toHaveBeenCalledTimes(1);

    // Second play reuses the cached WAV file without rewriting
    const second = await playMobileAudioCue("dictation-start", { preferences: {} });
    expect(second).toBe(true);
    expect(mocks.writtenFiles).toHaveLength(1);
    expect(mocks.players).toHaveLength(2);
  });

  it("fails silently when expo-audio throws", async () => {
    mocks.createAudioPlayer.mockImplementationOnce(() => {
      throw new Error("Audio engine unavailable");
    });
    await expect(playMobileAudioCue("dictation-stop", { preferences: {} })).resolves.toBe(false);
  });

  it("triggers dictation-start and dictation-stop on mobile VoiceInputSession recording transitions", async () => {
    const cues: string[] = [];
    const recorder = {
      uri: "file:///voice.m4a",
      prepareToRecordAsync: vi.fn(async () => {}),
      record: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const prepare = vi.fn(async (): Promise<PreparedVoiceTranscription> => ({
      locale: "en-US",
      transcribe: async () => "hello mobile",
    }));
    const session = new VoiceInputSession({
      recorder,
      getTranscriber: () => ({ prepare }),
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => {},
      releaseRecording: vi.fn(async () => {}),
      deleteRecording: vi.fn(),
      sampleRecording: () => null,
      publishAudioLevels: vi.fn(),
      keepAwake: () => () => {},
      onAudioCue: (cue) => cues.push(cue),
    });

    await session.start(
      createVoiceInputTarget("thread-1", () => "", vi.fn(), { start: 0, end: 0 }),
    );
    expect(cues).toEqual(["dictation-start"]);

    await session.controller.stop();
    expect(cues).toEqual(["dictation-start", "dictation-stop"]);
  });

  it("triggers open, single thinking pulse, and close cues on mobile VoiceModeSession", async () => {
    const cues: string[] = [];
    let resolveListen!: (result: ListenResult) => void;
    const listenPromise = new Promise<ListenResult>((resolve) => {
      resolveListen = resolve;
    });
    let listenCount = 0;

    const audio: VoiceModeAudio = {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      listen: vi.fn(async () => {
        listenCount += 1;
        if (listenCount === 1) {
          return {
            result: listenPromise,
            finish: () =>
              resolveListen({
                kind: "utterance",
                recording: { uri: "file:///turn.m4a" },
                heardSpeech: true,
              }),
            cancel: () => resolveListen({ kind: "cancelled" }),
          } satisfies ActiveListening;
        }
        return {
          result: new Promise<ListenResult>(() => {}),
          finish: () => {},
          cancel: () => {},
        } satisfies ActiveListening;
      }),
      watchForBargeIn: vi.fn(async () => async () => {}),
      play: vi.fn(
        async () =>
          ({
            done: Promise.resolve("finished"),
            stop: () => {},
          }) satisfies ActivePlayback,
      ),
      transcribe: vi.fn(async () => "status check"),
      discardRecording: vi.fn(),
    };
    const emptyContext: VoiceWorkspaceContext = {
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
    const routeMissing = Object.assign(new Error("Not found"), { status: 404, routeMissing: true });
    const api = {
      turnStream: vi.fn(async () => {
        throw routeMissing;
      }),
      turn: vi.fn(async (): Promise<VoiceAssistantTurnResponse> => ({
        route: "assistant",
        spokenReply: "Everything is green.",
        displayReply: "Everything is green.",
        expectFollowUp: false,
        toolResults: [],
        clientActions: [],
      })),
      speak: vi.fn(async () => ({ bytes: new Uint8Array([1]), contentType: "audio/mpeg" })),
    } as unknown as VoiceAssistantApi;

    const session = new VoiceModeSession({
      audio,
      getApi: () => api,
      readContext: () => emptyContext,
      watchWorkspace: () => () => {},
      executeAction: vi.fn(async () => {}),
      setLevel: () => {},
      onAudioCue: (cue) => cues.push(cue),
    });

    session.start();
    expect(cues).toEqual(["voice-mode-open"]);

    // Wait for first listen to arm, then finish the utterance
    await vi.waitFor(() => expect(audio.listen).toHaveBeenCalledTimes(1));
    resolveListen({
      kind: "utterance",
      recording: { uri: "file:///turn.m4a" },
      heardSpeech: true,
    });
    await vi.waitFor(() => expect(api.turn).toHaveBeenCalledTimes(1));
    expect(cues).toEqual(["voice-mode-open", "voice-mode-thinking"]);

    await session.stop();
    expect(cues).toEqual(["voice-mode-open", "voice-mode-thinking", "voice-mode-close"]);
  });
});
