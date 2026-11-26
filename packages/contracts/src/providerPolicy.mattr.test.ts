import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  interactionModeRank,
  isInteractionModeAbove,
  ProviderInteractionMode,
} from "./providerPolicy.ts";

describe("ProviderInteractionMode", () => {
  const decode = Schema.decodeUnknownSync(ProviderInteractionMode);
  const encode = Schema.encodeSync(ProviderInteractionMode);

  it("accepts default, plan and goal and round-trips them", () => {
    for (const mode of ["default", "plan", "goal"] as const) {
      expect(decode(mode)).toBe(mode);
      expect(encode(mode)).toBe(mode);
    }
  });

  it("rejects unknown modes", () => {
    expect(() => decode("autonomous")).toThrow();
    expect(() => decode("")).toThrow();
  });

  it("ranks goal with default, above read-only plan", () => {
    expect(interactionModeRank("plan")).toBeLessThan(interactionModeRank("default"));
    expect(interactionModeRank("goal")).toBe(interactionModeRank("default"));
    expect(isInteractionModeAbove("goal", "plan")).toBe(true);
    expect(isInteractionModeAbove("default", "plan")).toBe(true);
    expect(isInteractionModeAbove("goal", "default")).toBe(false);
    expect(isInteractionModeAbove("default", "goal")).toBe(false);
    expect(isInteractionModeAbove("plan", "goal")).toBe(false);
    expect(isInteractionModeAbove("goal", undefined)).toBe(false);
  });
});
