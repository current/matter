import { describe, expect, it } from "vite-plus/test";

import {
  BARGE_IN_VAD,
  LISTENING_VAD,
  WAV_HEADER_BYTES,
  audioExtensionForContentType,
  buildWavFile,
  createVoiceActivityDetector,
} from "./voiceAudioLogic";

const text = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.slice(start, end));

describe("buildWavFile", () => {
  it("writes a canonical 44-byte RIFF/WAVE header for 16 kHz mono PCM", () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
    const wav = buildWavFile(pcm);
    const view = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.byteLength);
    expect(text(wav, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(text(wav, 8, 12)).toBe("WAVE");
    expect(text(wav, 12, 16)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(wav, 36, 40)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(Array.from(wav.subarray(WAV_HEADER_BYTES))).toEqual(Array.from(pcm));
  });

  it("scales the byte rate with the sample rate and channel count", () => {
    const view = new DataView(buildWavFile(new Uint8Array(4), 44_100, 2).buffer);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(28, true)).toBe(44_100 * 2 * 2);
    expect(view.getUint16(32, true)).toBe(4);
  });

  it("wraps an empty recording in a header-only file", () => {
    const wav = buildWavFile(new Uint8Array());
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});

/** Feeds one reading every 60 ms, as the recorder poll does. */
function drive(
  config = LISTENING_VAD,
  readings: ReadonlyArray<readonly [db: number, count: number]>,
) {
  const detector = createVoiceActivityDetector(config);
  const events: Array<{ at: number; event: string }> = [];
  let now = 0;
  for (const [db, count] of readings) {
    for (let index = 0; index < count; index += 1) {
      now += 60;
      const event = detector.push(db, now);
      if (event !== "none") events.push({ at: now, event });
      // The recorder stops at the first terminal event, as the session does.
      if (event !== "none" && event !== "speech-start") return { events, detector };
    }
  }
  return { events, detector };
}

describe("createVoiceActivityDetector", () => {
  it("stays quiet through room noise", () => {
    const { events, detector } = drive(LISTENING_VAD, [[-55, 100]]);
    expect(events).toEqual([]);
    expect(detector.speaking).toBe(false);
  });

  it("ignores a click shorter than the onset time", () => {
    const { events } = drive(LISTENING_VAD, [
      [-55, 10],
      [-15, 1],
      [-55, 30],
    ]);
    expect(events).toEqual([]);
  });

  it("starts on sustained speech and ends after the silence timeout", () => {
    const { events, detector } = drive(LISTENING_VAD, [
      [-55, 10],
      [-18, 20],
      [-55, 40],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(["speech-start", "end-of-speech"]);
    const [start, end] = events;
    // Speech runs through the poll at 1800 ms; the first poll 1150 ms later ends it.
    expect(start!.at).toBe(780);
    expect(end!.at).toBe(3000);
    expect(detector.speaking).toBe(true);
  });

  it("does not end an utterance during a short pause", () => {
    const { events } = drive(LISTENING_VAD, [
      [-55, 5],
      [-18, 10],
      [-55, 10],
      [-18, 10],
      [-55, 5],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(["speech-start"]);
  });

  it("raises its threshold above steady engine noise", () => {
    // -30 dB hum is louder than the fixed -34 dB onset but never speech on its own.
    const { events } = drive(LISTENING_VAD, [[-30, 100]]);
    expect(events).toEqual([]);
  });

  it("still hears speech over steady noise", () => {
    const { events } = drive(LISTENING_VAD, [
      [-45, 20],
      [-15, 10],
    ]);
    expect(events[0]?.event).toBe("speech-start");
  });

  it("gives up when nobody speaks within the no-speech timeout", () => {
    const { events } = drive({ ...LISTENING_VAD, noSpeechTimeoutMs: 1000 }, [[-60, 30]]);
    expect(events.map((entry) => entry.event)).toEqual(["no-speech-timeout"]);
  });

  it("caps a single utterance", () => {
    const { events } = drive({ ...LISTENING_VAD, maxUtteranceMs: 1000 }, [[-15, 60]]);
    expect(events.map((entry) => entry.event)).toEqual(["speech-start", "max-duration"]);
  });

  it("treats missing metering as silence", () => {
    const detector = createVoiceActivityDetector(LISTENING_VAD);
    expect(detector.push(undefined, 60)).toBe("none");
    expect(detector.push(Number.NaN, 120)).toBe("none");
  });

  it("needs louder, longer speech to interrupt playback", () => {
    const quiet = drive(BARGE_IN_VAD, [[-30, 40]]);
    expect(quiet.events).toEqual([]);
    const brief = drive(BARGE_IN_VAD, [
      [-55, 12],
      [-12, 3],
      [-55, 10],
    ]);
    expect(brief.events).toEqual([]);
    const spoken = drive(BARGE_IN_VAD, [
      [-55, 12],
      [-12, 8],
    ]);
    expect(spoken.events.map((entry) => entry.event)).toEqual(["speech-start"]);
  });

  it("ignores everything during the barge-in warmup", () => {
    expect(drive(BARGE_IN_VAD, [[-3, 11]]).events).toEqual([]);
  });

  it("does not mistake the reply leaking from the speaker for the user", () => {
    // Loud sentences with short pauses between them, as a spoken reply sounds at the mic.
    const sentence: ReadonlyArray<readonly [number, number]> = [
      [-15, 25],
      [-50, 7],
    ];
    const { events } = drive(BARGE_IN_VAD, Array.from({ length: 6 }, () => sentence).flat());
    expect(events).toEqual([]);
  });

  it("still hears the user over a loud reply", () => {
    const { events } = drive(BARGE_IN_VAD, [
      [-15, 30],
      [-3, 6],
    ]);
    expect(events.map((entry) => entry.event)).toEqual(["speech-start"]);
  });
});

describe("audioExtensionForContentType", () => {
  it.each([
    ["audio/mpeg", "mp3"],
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
    ["audio/ogg; codecs=opus", "ogg"],
    ["audio/aac", "aac"],
    ["audio/mp4", "m4a"],
    [null, "mp3"],
    ["application/octet-stream", "mp3"],
  ])("%s → %s", (contentType, extension) => {
    expect(audioExtensionForContentType(contentType)).toBe(extension);
  });
});
