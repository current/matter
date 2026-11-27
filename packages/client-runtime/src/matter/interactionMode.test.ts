import { PlanId, ProviderDriverKind, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isGoalClearCommand,
  latestProposedPlan,
  nextInteractionMode,
  prependKeepingGoalCommand,
  providerHasNativeGoals,
  resolveComposerInteractionMode,
  resolveInteractionModeSend,
  resolveMatterModeSend,
  shouldClearNativeGoalOnExit,
  threadHasNativeGoal,
  withNativeGoalCommand,
} from "./interactionMode.ts";

const baseSend = {
  bypass: false,
  editingQueuedMessage: false,
  interactionMode: "default",
  nativeGoals: false,
  nativeGoalStarted: false,
  planImplementation: null,
  attachmentCount: 0,
  contextCount: 0,
} as const;

const noExtras = { startsNativeGoal: false, sourceProposedPlanId: null } as const;

describe("nextInteractionMode", () => {
  it("cycles Default → Plan → Goal → Default", () => {
    expect(nextInteractionMode("default")).toBe("plan");
    expect(nextInteractionMode("plan")).toBe("goal");
    expect(nextInteractionMode("goal")).toBe("default");
  });
});

describe("resolveComposerInteractionMode", () => {
  it("prefers the composer's pending mode over the thread's", () => {
    expect(resolveComposerInteractionMode("goal", "plan")).toBe("goal");
    expect(resolveComposerInteractionMode(null, "plan")).toBe("plan");
    expect(resolveComposerInteractionMode(undefined, undefined)).toBe("default");
  });
});

describe("providerHasNativeGoals", () => {
  it("matches the server's goal drivers and providers that advertise /goal", () => {
    expect(providerHasNativeGoals(ProviderDriverKind.make("codex"), [])).toBe(true);
    expect(providerHasNativeGoals(ProviderDriverKind.make("claudeAgent"), undefined)).toBe(true);
    expect(providerHasNativeGoals(ProviderDriverKind.make("cursor"), [{ name: "goal" }])).toBe(
      true,
    );
    expect(providerHasNativeGoals(ProviderDriverKind.make("cursor"), [{ name: "review" }])).toBe(
      false,
    );
    expect(providerHasNativeGoals(null, undefined)).toBe(false);
  });

  it("treats OpenCode as native from 2.2.5, like the server", () => {
    const opencode = ProviderDriverKind.make("opencode");
    expect(providerHasNativeGoals(opencode, [], "2.2.5")).toBe(true);
    expect(providerHasNativeGoals(opencode, [], null)).toBe(true);
    expect(providerHasNativeGoals(opencode, [], "2.2.4")).toBe(false);
  });

  it("leaves fallback providers to Matter's server-side Goal block", () => {
    for (const driver of ["cursor", "pi", "kiro", "grok", "muse", "fx"]) {
      expect(providerHasNativeGoals(ProviderDriverKind.make(driver), [])).toBe(false);
    }
  });
});

describe("threadHasNativeGoal", () => {
  it("tracks active goals and re-arms once complete", () => {
    expect(threadHasNativeGoal(undefined)).toBe(false);
    expect(threadHasNativeGoal({ interactionMode: "default", goal: null })).toBe(false);
    expect(threadHasNativeGoal({ interactionMode: "goal", goal: null })).toBe(true);
    const goal = { objective: "Ship", status: "active" } as const;
    expect(threadHasNativeGoal({ interactionMode: "default", goal })).toBe(true);
    expect(
      threadHasNativeGoal({ interactionMode: "goal", goal: { ...goal, status: "complete" } }),
    ).toBe(false);
  });
});

describe("shouldClearNativeGoalOnExit", () => {
  it("clears running goals except on Antigravity", () => {
    expect(
      shouldClearNativeGoalOnExit({
        mode: "goal",
        nativeGoalStarted: true,
        selectedProvider: ProviderDriverKind.make("codex"),
      }),
    ).toBe(true);
    expect(
      shouldClearNativeGoalOnExit({
        mode: "goal",
        nativeGoalStarted: true,
        selectedProvider: ProviderDriverKind.make("antigravity"),
      }),
    ).toBe(false);
    expect(
      shouldClearNativeGoalOnExit({
        mode: "plan",
        nativeGoalStarted: true,
        selectedProvider: ProviderDriverKind.make("codex"),
      }),
    ).toBe(false);
  });
});

describe("withNativeGoalCommand", () => {
  const first = {
    interactionMode: "goal",
    nativeGoals: true,
    nativeGoalStarted: false,
    attachmentCount: 0,
  } as const;

  it("starts a native goal with `/goal <prompt>` on the first Goal prompt", () => {
    expect(withNativeGoalCommand({ ...first, prompt: "  ship the release " })).toBe(
      "/goal ship the release",
    );
  });

  it("never double-prefixes and leaves other commands, follow-ups, and attachments alone", () => {
    expect(withNativeGoalCommand({ ...first, prompt: "/goal ship it" })).toBe("/goal ship it");
    expect(withNativeGoalCommand({ ...first, prompt: "/review" })).toBe("/review");
    expect(withNativeGoalCommand({ ...first, nativeGoalStarted: true, prompt: "follow up" })).toBe(
      "follow up",
    );
    expect(withNativeGoalCommand({ ...first, attachmentCount: 1, prompt: "ship it" })).toBe(
      "ship it",
    );
    expect(withNativeGoalCommand({ ...first, nativeGoals: false, prompt: "ship it" })).toBe(
      "ship it",
    );
  });
});

describe("resolveInteractionModeSend", () => {
  const send = (prompt: string, nativeGoals = false, attachmentCount = 0) =>
    resolveInteractionModeSend({ prompt, nativeGoals, attachmentCount });

  it("switches on standalone commands and strips prefixes with trailing text", () => {
    expect(send("/plan")).toEqual({ kind: "switch", mode: "plan" });
    expect(send("  /GOAL  ")).toEqual({ kind: "switch", mode: "goal" });
    expect(send("/default")).toEqual({ kind: "switch", mode: "default" });
    expect(send("/plan add dark mode")).toEqual({
      kind: "send",
      mode: "plan",
      prompt: "add dark mode",
    });
    expect(send("/plan", false, 1)).toEqual({ kind: "send", mode: "plan", prompt: "" });
    expect(send("/planner")).toBeNull();
  });

  it("keeps native /goal commands intact and exits Goal on /goal clear", () => {
    expect(send("/goal ship it", true)).toEqual({
      kind: "send",
      mode: "goal",
      prompt: "/goal ship it",
    });
    expect(send("/goal clear", true)).toEqual({
      kind: "send",
      mode: "default",
      prompt: "/goal clear",
    });
    expect(send("/goal ship it", true, 1)).toEqual({
      kind: "send",
      mode: "goal",
      prompt: "ship it",
    });
  });
});

describe("resolveMatterModeSend", () => {
  it("handles switches, bypasses, native goals, and plan implementation", () => {
    expect(resolveMatterModeSend({ ...baseSend, prompt: "/goal" })).toEqual({
      ...noExtras,
      prompt: null,
      interactionMode: "goal",
      switchTo: "goal",
    });
    expect(resolveMatterModeSend({ ...baseSend, bypass: true, prompt: "/plan x" })).toEqual({
      ...noExtras,
      prompt: "/plan x",
      interactionMode: "default",
      switchTo: null,
    });
    expect(
      resolveMatterModeSend({
        ...baseSend,
        interactionMode: "goal",
        nativeGoals: true,
        prompt: "ship it",
      }).startsNativeGoal,
    ).toBe(true);
    expect(isGoalClearCommand("/goal clear")).toBe(true);
    expect(isGoalClearCommand("/goal ship")).toBe(false);
    const planImplementation = {
      planId: PlanId.make("plan-1"),
      prompt: "Implement this plan:\n# Plan",
    };
    expect(
      resolveMatterModeSend({
        ...baseSend,
        prompt: " ",
        interactionMode: "plan",
        planImplementation,
      }),
    ).toEqual({
      ...noExtras,
      prompt: planImplementation.prompt,
      interactionMode: "default",
      switchTo: "default",
      sourceProposedPlanId: PlanId.make("plan-1"),
    });
  });
});

describe("prependKeepingGoalCommand", () => {
  it("places context cards after a leading `/goal ` objective prefix", () => {
    expect(prependKeepingGoalCommand("/goal ship it", "[[context:1]]")).toBe(
      "/goal [[context:1]] ship it",
    );
    expect(prependKeepingGoalCommand("/goal clear", "[[context:1]]")).toBe(
      "[[context:1]] /goal clear",
    );
  });
});

describe("latestProposedPlan", () => {
  it("picks the proposed plan from the newest run", () => {
    const runs = [
      { id: RunId.make("run-1"), ordinal: 1 },
      { id: RunId.make("run-2"), ordinal: 2 },
    ];
    const plans = [
      {
        id: PlanId.make("plan-2"),
        kind: "proposed_plan",
        runId: RunId.make("run-2"),
        markdown: " # Second ",
      },
      {
        id: PlanId.make("plan-1"),
        kind: "proposed_plan",
        runId: RunId.make("run-1"),
        markdown: "# First",
      },
    ];
    expect(
      latestProposedPlan({ runs, plans } as unknown as Parameters<typeof latestProposedPlan>[0]),
    ).toEqual({ planId: PlanId.make("plan-2"), markdown: "# Second" });
    expect(latestProposedPlan(null)).toBeNull();
  });
});
