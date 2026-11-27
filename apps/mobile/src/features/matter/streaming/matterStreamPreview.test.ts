import { describe, expect, it } from "vite-plus/test";

import { parseStoredMatterStreamAnimation } from "./matterStreamAnimationStore";
import { matterStreamPreviewArrivals } from "./matterStreamPreview";

describe("matterStreamPreviewArrivals", () => {
  it("grows in whole tokens, later each time, and ends at the whole sample", () => {
    const sample = "Moved the session store behind `reconnect()`, so a dropped socket resumes.";
    const arrivals = matterStreamPreviewArrivals(sample);
    expect(arrivals.at(-1)?.length).toBe(sample.length);
    for (let index = 1; index < arrivals.length; index++) {
      expect(arrivals[index]!.at).toBeGreaterThan(arrivals[index - 1]!.at);
      expect(arrivals[index]!.length).toBeGreaterThanOrEqual(arrivals[index - 1]!.length);
    }
    expect(sample[arrivals[0]!.length]).toBe(" ");
  });

  it("stops early for a short sample", () => {
    expect(matterStreamPreviewArrivals("One two")).toEqual([
      { at: 90, length: 3 },
      { at: 200, length: 7 },
    ]);
  });
});

describe("parseStoredMatterStreamAnimation", () => {
  it("reads the web's storage key and falls back to Instant", () => {
    expect(parseStoredMatterStreamAnimation('{"mattr:stream-animation:v1":"fade"}')).toBe("fade");
    expect(parseStoredMatterStreamAnimation('{"mattr:stream-animation:v1":"blur"}')).toBe(
      "instant",
    );
    expect(parseStoredMatterStreamAnimation("not json")).toBe("instant");
    expect(parseStoredMatterStreamAnimation(null)).toBe("instant");
  });
});
