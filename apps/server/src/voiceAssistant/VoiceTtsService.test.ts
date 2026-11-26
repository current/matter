import { describe, expect, it } from "vite-plus/test";

import { elevenLabsStreamUrl } from "./VoiceTtsService.ts";

describe("elevenLabsStreamUrl", () => {
  it("leaves out optimize_streaming_latency for the v3 and v4 models that reject it", () => {
    for (const model of ["eleven_v4_turbo", "eleven_v4", "eleven_v3_conversational"] as const) {
      expect(elevenLabsStreamUrl("cjVigY5qzO86Huf0OWal", model)).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/cjVigY5qzO86Huf0OWal/stream?output_format=mp3_44100_64",
      );
    }
  });

  it("keeps low-latency streaming for Flash v2.5", () => {
    expect(elevenLabsStreamUrl("voice id", "eleven_flash_v2_5")).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%20id/stream?output_format=mp3_44100_64&optimize_streaming_latency=3",
    );
  });
});
