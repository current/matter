import { describe, expect, it } from "vite-plus/test";

import { isPredictionAcceptKey, isPredictionClamped } from "./promptPrediction.mattr";
import { promptSuggestionToAccept } from "./usePromptSuggestion";

describe("isPredictionAcceptKey", () => {
  it("accepts with Tab or ArrowRight only", () => {
    expect(isPredictionAcceptKey("Tab")).toBe(true);
    expect(isPredictionAcceptKey("ArrowRight")).toBe(true);
    for (const key of ["Escape", "Enter", "ArrowLeft", "ArrowDown", "a"]) {
      expect(isPredictionAcceptKey(key)).toBe(false);
    }
  });

  it("never fills a prediction into a draft that already has text", () => {
    expect(promptSuggestionToAccept("ship it", "")).toBe("ship it");
    expect(promptSuggestionToAccept("ship it", "s")).toBeNull();
  });
});

describe("isPredictionClamped", () => {
  it("reports overflow beyond the clamp, ignoring sub-pixel rounding", () => {
    expect(isPredictionClamped({ scrollHeight: 60, clientHeight: 60 })).toBe(false);
    expect(isPredictionClamped({ scrollHeight: 61, clientHeight: 60 })).toBe(false);
    expect(isPredictionClamped({ scrollHeight: 80, clientHeight: 60 })).toBe(true);
  });
});
