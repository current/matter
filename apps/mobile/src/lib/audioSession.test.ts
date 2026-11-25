import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const audio = vi.hoisted(() => ({
  setMode: vi.fn(async () => {}),
  setActive: vi.fn(async () => {}),
  setOwner: vi.fn(),
}));
vi.mock("expo-audio", () => ({
  AudioModule: { setAudioSessionOwner: audio.setOwner },
  setAudioModeAsync: audio.setMode,
  setIsAudioActiveAsync: audio.setActive,
}));

import { acquireAudioSession, activateAudioSession, releaseAudioSession } from "./audioSession";

afterEach(() => vi.clearAllMocks());

describe("activateAudioSession", () => {
  it("keeps the foreground-only defaults", async () => {
    const token = acquireAudioSession("recording");
    await activateAudioSession(token);
    expect(audio.setMode).toHaveBeenCalledWith({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await releaseAudioSession(token);
  });

  it("keeps a hands-free session alive in the background and on the speaker", async () => {
    const token = acquireAudioSession("recording");
    await activateAudioSession(token, {
      shouldPlayInBackground: true,
      shouldRouteThroughEarpiece: false,
    });
    expect(audio.setMode).toHaveBeenCalledWith({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      shouldRouteThroughEarpiece: false,
    });
    expect(audio.setActive).toHaveBeenLastCalledWith(true);
    await releaseAudioSession(token);
  });

  it("returns to foreground-only audio when a recording session is released", async () => {
    const token = acquireAudioSession("recording");
    await activateAudioSession(token, { shouldPlayInBackground: true });
    await releaseAudioSession(token);
    expect(audio.setMode).toHaveBeenLastCalledWith({
      allowsRecording: false,
      shouldPlayInBackground: false,
    });
    expect(audio.setActive).toHaveBeenLastCalledWith(false);
  });

  it("does not configure a session another owner has taken", async () => {
    const first = acquireAudioSession("recording");
    const second = acquireAudioSession("recording");
    expect(await activateAudioSession(first, { shouldPlayInBackground: true })).toBe(false);
    expect(audio.setMode).not.toHaveBeenCalled();
    await releaseAudioSession(second);
  });
});
