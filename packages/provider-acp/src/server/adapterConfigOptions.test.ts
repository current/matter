import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { resolveAcpConfigOptionSelection } from "./adapter.ts";

const makeSelectOption = (
  id: string,
  values: ReadonlyArray<string>,
  category?: string,
): EffectAcpSchema.SessionConfigOption => ({
  id,
  name: id,
  type: "select",
  currentValue: values[0] ?? "",
  options: values.map((value) => ({ value, name: value })),
  ...(category === undefined ? {} : { category }),
});

describe("resolveAcpConfigOptionSelection", () => {
  it("matches thought_level and thinking_level aliases by ACP category", () => {
    const thoughtLevelOption = makeSelectOption(
      "thought_level",
      ["low", "medium", "high", "xhigh"],
      "thought_level",
    );
    const thinkingLevelOption = makeSelectOption(
      "thinking_level",
      ["low", "medium", "high"],
      "thought_level",
    );
    const reasoningOption = makeSelectOption(
      "reasoning_effort",
      ["low", "medium", "high"],
      "thought_level",
    );

    expect(
      resolveAcpConfigOptionSelection([thoughtLevelOption], {
        id: "thinking_level",
        value: "high",
      }),
    ).toMatchObject({
      kind: "apply",
      option: thoughtLevelOption,
      value: "high",
      mappedFromId: "thinking_level",
    });

    expect(
      resolveAcpConfigOptionSelection([thinkingLevelOption], {
        id: "thought_level",
        value: "high",
      }),
    ).toMatchObject({
      kind: "apply",
      option: thinkingLevelOption,
      value: "high",
      mappedFromId: "thought_level",
    });

    expect(
      resolveAcpConfigOptionSelection([reasoningOption], {
        id: "thought_level",
        value: "medium",
      }),
    ).toMatchObject({
      kind: "apply",
      option: reasoningOption,
      value: "medium",
      mappedFromId: "thought_level",
    });
  });

  it("falls back to the highest valid advertised effort level instead of dropping thought_level", () => {
    const fourTier = makeSelectOption(
      "thought_level",
      ["low", "medium", "high", "xhigh"],
      "thought_level",
    );
    const threeTier = makeSelectOption("thought_level", ["low", "medium", "high"], "thought_level");

    expect(
      resolveAcpConfigOptionSelection([fourTier], { id: "thought_level", value: "max" }),
    ).toMatchObject({
      kind: "apply",
      option: fourTier,
      value: "xhigh",
      fallbackFromValue: "max",
    });

    expect(
      resolveAcpConfigOptionSelection([threeTier], { id: "thinking_level", value: "xhigh" }),
    ).toMatchObject({
      kind: "apply",
      option: threeTier,
      value: "high",
      mappedFromId: "thinking_level",
      fallbackFromValue: "xhigh",
    });

    expect(
      resolveAcpConfigOptionSelection([fourTier], { id: "thought_level", value: "extra-high" }),
    ).toMatchObject({
      kind: "apply",
      option: fourTier,
      value: "xhigh",
      fallbackFromValue: "extra-high",
    });

    expect(
      resolveAcpConfigOptionSelection([fourTier], { id: "thought_level", value: "ultra" }),
    ).toMatchObject({
      kind: "apply",
      option: fourTier,
      value: "xhigh",
      fallbackFromValue: "ultra",
    });
  });

  it("reports unadvertised non-thought options and absent options without falling back", () => {
    const contextOption = makeSelectOption("context", ["200k", "1m"], "model_config");

    expect(
      resolveAcpConfigOptionSelection([contextOption], { id: "context", value: "2m" }),
    ).toEqual({
      kind: "unadvertised",
      option: contextOption,
      requestedValue: "2m",
      advertisedValues: ["200k", "1m"],
    });

    expect(
      resolveAcpConfigOptionSelection([contextOption], { id: "thought_level", value: "high" }),
    ).toEqual({
      kind: "unsupported",
    });
  });
});
