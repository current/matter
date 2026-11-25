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
    emit: (status: Record<string, unknown>) => listeners.get("playbackStatusUpdate")?.(status),
  };
});

vi.mock("expo-audio", () => ({
  AudioModule: { AudioRecorder: vi.fn(), setAudioSessionOwner: vi.fn() },
  RecordingPresets: { HIGH_QUALITY: { extension: ".m4a", sampleRate: 44_100, ios: {} } },
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
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("./voiceAssistantApi", () => ({ isVoiceAssistantApiError: () => false }));

import { NativeVoiceAudio } from "./nativeVoiceAudio";

afterEach(() => {
  vi.clearAllMocks();
  native.listeners.clear();
});

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
});
