import { assert, describe, it } from "@effect/vitest";

import {
  acpEffectiveInteractionMode,
  buildT3AcpInstructions,
  t3AcpPromptWithInstructions,
  withMattrGoalModeInstructions,
} from "./orchestrationInstructions.ts";

describe("mattr interaction mode instructions", () => {
  it("adds nothing to Default or Plan turns, so native plan modes run untouched", () => {
    for (const nativeGoals of [false, true]) {
      assert.equal(
        withMattrGoalModeInstructions("Fix the bug", "default", nativeGoals),
        "Fix the bug",
      );
      assert.equal(
        withMattrGoalModeInstructions("Fix the bug", "plan", nativeGoals),
        "Fix the bug",
      );
    }
  });

  it("leaves Goal turns bare on providers with a native /goal", () => {
    assert.equal(
      withMattrGoalModeInstructions("Ship the importer", "goal", true),
      "Ship the importer",
    );
  });

  it("appends the fallback Goal block after the user's words on other providers", () => {
    const text = withMattrGoalModeInstructions("Ship the importer", "goal", false);
    assert.isTrue(text.startsWith("Ship the importer\n\n<mattr_goal_mode>\n"));
    assert.isTrue(text.endsWith("</mattr_goal_mode>"));
    for (const cue of ["end to end", "- [ ]", "subagents", "verified"]) assert.include(text, cue);
    assert.isBelow(text.length, 800);
    assert.equal(withMattrGoalModeInstructions("  ", "goal", false), "  ");
  });

  it("keeps ACP's Default mode text for Goal, since Goal edits like Default", () => {
    const state = { hasT3Mcp: false, hasDeviceTools: false } as const;
    assert.equal(
      buildT3AcpInstructions({ ...state, interactionMode: "goal" }),
      buildT3AcpInstructions({ ...state, interactionMode: "default" }),
    );
    const leavingPlan = t3AcpPromptWithInstructions({
      prompt: "go",
      state: { ...state, interactionMode: "goal" },
      previousState: { ...state, interactionMode: "plan" },
      systemPromptState: { ...state, interactionMode: "plan" },
    });
    assert.include(leavingPlan, "interaction mode: Default");
    assert.notInclude(leavingPlan, "interaction mode: Plan");
  });

  it("sends no mode delta between Default and Goal, which ACP runs the same way", () => {
    const state = { hasT3Mcp: false, hasDeviceTools: false } as const;
    for (const [from, to] of [
      ["default", "goal"],
      ["goal", "default"],
    ] as const) {
      assert.equal(
        t3AcpPromptWithInstructions({
          prompt: "go",
          state: { ...state, interactionMode: to },
          previousState: { ...state, interactionMode: from },
          systemPromptState: { ...state, interactionMode: from },
        }),
        "go",
      );
      assert.equal(
        t3AcpPromptWithInstructions({
          prompt: "go",
          state: { ...state, interactionMode: to },
          systemPromptState: { ...state, interactionMode: from },
        }),
        "go",
      );
    }
    assert.equal(acpEffectiveInteractionMode("goal"), "default");
    assert.equal(acpEffectiveInteractionMode("plan"), "plan");
  });
});
