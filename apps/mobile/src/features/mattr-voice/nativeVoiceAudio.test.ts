import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => {
  const listeners = new Map<string, (status: Record<string, unknown>) => void>();
  return {
    permission: vi.fn(async () => ({ granted: true })),
    setMode: vi.fn(async () => {}),
    setActive: vi.fn(async () => {}),
    keepAwake: vi.fn(async () => {}),
    releaseAwake: vi.fn(),
    written: vi.fn<(bytes: Uint8Array) => Promise<void>>(async () => {}),
    deleted: vi.fn(),
    playerOptions: vi.fn(),
    play: vi.fn(),
    release: vi.fn(),
    listeners,
    recorderOptions: vi.fn(),
    transcription: {} as Record<string, unknown>,
    emit: (status: Record<string, unknown>) => listeners.get("playbackStatusUpdate")?.(status),
  };
});

vi.mock("expo-audio", () => ({
  AudioModule: {
    AudioRecorder: class {
      readonly uri = "file:///cache/recording.m4a";
      constructor(options: unknown) {
        native.recorderOptions(options);
      }
      prepareToRecordAsync = async () => {};
      record = () => {};
      stop = async () => {};
      release = () => {};
      getStatus = () => ({ isRecording: true, metering: -60, mediaServicesDidReset: false });
    },
    setAudioSessionOwner: vi.fn(),
  },
  RecordingPresets: {
    HIGH_QUALITY: {
      extension: ".m4a",
      sampleRate: 44_100,
      // The real preset records stereo at 128 kbps without metering.
      ios: { numberOfChannels: 2, bitRate: 128_000, isMeteringEnabled: false },
    },
  },
  requestRecordingPermissionsAsync: native.permission,
  setAudioModeAsync: native.setMode,
  setIsAudioActiveAsync: native.setActive,
  createAudioPlayer: (_source: unknown, options: unknown) => {
    native.playerOptions(options);
    return {
      play: native.play,
      pause: vi.fn(),
      release: native.release,
      addListener: (event: string, listener: (status: Record<string, unknown>) => void) => {
        native.listeners.set(event, listener);
        return { remove: () => native.listeners.delete(event) };
      },
    };
  },
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    readonly uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    create() {}
    write(bytes: Uint8Array) {
      return native.written(bytes);
    }
    delete() {
      native.deleted(this.uri);
    }
  },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: native.keepAwake,
  deactivateKeepAwake: native.releaseAwake,
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native.transcription }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("./voiceAssistantApi", () => ({ isVoiceAssistantApiError: () => false }));

import { NativeVoiceAudio } from "./nativeVoiceAudio";
import { LISTENING_VAD } from "./voiceAudioLogic";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  native.listeners.clear();
  for (const key of Object.keys(native.transcription)) delete native.transcription[key];
});

/** Installs the native live microphone tap and returns a way to feed it chunks. */
function installPcmTap(voiceProcessing = true) {
  let listener: ((event: { data: string; level: number }) => void) | null = null;
  const stop = vi.fn(async () => {});
  Object.assign(native.transcription, {
    startPcmStream: vi.fn(async () => ({ voiceProcessing })),
    stopPcmStream: stop,
    addListener: (_event: string, next: typeof listener) => {
      listener = next;
      return { remove: () => (listener = null) };
    },
  });
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    stop,
    emit: (bytes: number[], level: number) => {
      now += 80;
      listener?.({ data: btoa(String.fromCharCode(...bytes)), level });
    },
  };
}

describe("NativeVoiceAudio", () => {
  it("keeps recording and playback alive with the screen locked", async () => {
    const audio = new NativeVoiceAudio();
    await audio.open();
    expect(native.setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        allowsRecording: true,
        shouldPlayInBackground: true,
        allowsBackgroundRecording: true,
        shouldRouteThroughEarpiece: false,
      }),
    );
    await audio.close();
  });

  it("releases everything when it closes while the permission prompt is up", async () => {
    let grant!: (value: { granted: boolean }) => void;
    native.permission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const audio = new NativeVoiceAudio();
    const opening = audio.open();
    const closing = audio.close();
    await vi.waitFor(() => expect(native.permission).toHaveBeenCalled());
    grant({ granted: true });
    await opening;
    await closing;

    expect(native.keepAwake).toHaveBeenCalledTimes(1);
    expect(native.releaseAwake).toHaveBeenCalledTimes(1);
    expect(native.setActive).toHaveBeenLastCalledWith(false);
  });

  it("writes the whole reply before the player opens it", async () => {
    let flush!: () => void;
    native.written.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          flush = resolve;
        }),
    );
    const audio = new NativeVoiceAudio();
    const playing = audio.play({ bytes: new Uint8Array([1, 2]), contentType: "audio/mpeg" });
    await Promise.resolve();
    expect(native.playerOptions).not.toHaveBeenCalled();

    flush();
    const playback = await playing;
    expect(native.playerOptions).toHaveBeenCalledWith(
      expect.objectContaining({ keepAudioSessionActive: true }),
    );
    expect(native.play).toHaveBeenCalled();
    playback.stop();
    await expect(playback.done).resolves.toBe("stopped");
  });

  it("ends playback when the reply fails to load instead of waiting minutes", async () => {
    const audio = new NativeVoiceAudio();
    const playback = await audio.play({ bytes: new Uint8Array([1]), contentType: "audio/mpeg" });
    native.emit({ didJustFinish: false, isLoaded: false, error: "Cannot decode" });
    await expect(playback.done).resolves.toBe("stopped");
    expect(native.deleted).toHaveBeenCalled();
  });

  it("records mono with metering on, whatever the platform preset says", async () => {
    const audio = new NativeVoiceAudio();
    await audio.open();
    const listening = await audio.listen({
      vad: LISTENING_VAD,
      onLevel: () => {},
      onSpeechStart: () => {},
    });
    expect(native.recorderOptions).toHaveBeenCalledWith(
      expect.objectContaining({ numberOfChannels: 1, bitRate: 64_000, isMeteringEnabled: true }),
    );
    listening.cancel();
    await expect(listening.result).resolves.toEqual({ kind: "cancelled" });
    await audio.close();
  });

  it("listens on the live microphone tap and keeps its PCM for transcription", async () => {
    const tap = installPcmTap();
    const audio = new NativeVoiceAudio();
    await audio.open();
    const onSpeechStart = vi.fn();
    const levels: number[] = [];
    const listening = await audio.listen({
      vad: LISTENING_VAD,
      onLevel: (level) => levels.push(level),
      onSpeechStart,
    });
    expect(native.recorderOptions).not.toHaveBeenCalled();

    // A quiet room, normal speech at -40 dBFS, then a pause long enough to end the turn.
    for (let index = 0; index < 3; index += 1) tap.emit([0, 0], 0.0005);
    for (let index = 0; index < 5; index += 1) tap.emit([1, 2], 0.01);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    // The tenth quiet chunk (800 ms) passes the 750 ms silence and ends the utterance.
    for (let index = 0; index < 12; index += 1) tap.emit([0, 0], 0.0001);
    const result = await listening.result;
    expect(result.kind).toBe("utterance");
    if (result.kind !== "utterance") return;
    expect(result.heardSpeech).toBe(true);
    expect("pcm" in result.recording && result.recording.pcm.byteLength).toBe(36);
    expect(Math.max(...levels)).toBeGreaterThan(0);

    await audio.close();
    expect(tap.stop).toHaveBeenCalled();
  });

  it("interrupts a reply at normal speaking level when echo is cancelled", async () => {
    const tap = installPcmTap(true);
    const audio = new NativeVoiceAudio();
    await audio.open();
    const onBargeIn = vi.fn();
    const stopWatching = await audio.watchForBargeIn(LISTENING_VAD, onBargeIn);
    // The warmup learns the cleaned-up floor, then the user speaks at -30 dBFS.
    for (let index = 0; index < 5; index += 1) tap.emit([0, 0], 0.001);
    for (let index = 0; index < 4; index += 1) tap.emit([1, 1], 0.03);
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    await stopWatching();
    await audio.close();
  });
});
