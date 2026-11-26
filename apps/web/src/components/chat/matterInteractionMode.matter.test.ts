import { EnvironmentId, PlanId, ProviderDriverKind, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "../../proposedPlan";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  clearPersistedComposerInteractionMode,
  deriveMatterComposerInteractionMode,
  isGoalClearCommand,
  latestProposedPlan,
  matterInteractionModeSlashItems,
  nextInteractionMode,
  providerHasNativeGoals,
  resolveComposerInteractionMode,
  resolveInteractionModeSend,
  prependKeepingGoalCommand,
  resolveMatterModeSend,
  threadHasNativeGoal,
  withNativeGoalCommand,
} from "./matterInteractionMode.matter";
import { resolveMultipleModelTargets } from "./chatViewSend";
import type { ProviderInstanceEntry } from "../../providerInstances";

const english = (message: string) => message;

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

  it("leaves fallback providers (Cursor, Pi, Kiro, Grok, Muse, fx) to Matter's Goal block", () => {
    for (const driver of ["cursor", "pi", "kiro", "grok", "muse", "fx"]) {
      expect(providerHasNativeGoals(ProviderDriverKind.make(driver), [])).toBe(false);
    }
  });
});

describe("threadHasNativeGoal", () => {
  it("is set once a Goal turn was sent or the provider reports an unfinished goal", () => {
    expect(threadHasNativeGoal(undefined)).toBe(false);
    expect(threadHasNativeGoal({ interactionMode: "default", goal: null })).toBe(false);
    expect(threadHasNativeGoal({ interactionMode: "goal", goal: null })).toBe(true);
    const goal = { objective: "Ship", status: "active" } as const;
    expect(threadHasNativeGoal({ interactionMode: "default", goal })).toBe(true);
    expect(
      threadHasNativeGoal({ interactionMode: "default", goal: { ...goal, status: "complete" } }),
    ).toBe(false);
  });

  it("re-arms once the provider's goal is complete, even while the thread stays in Goal", () => {
    const complete = { objective: "Ship", status: "complete" } as const;
    expect(threadHasNativeGoal({ interactionMode: "goal", goal: complete })).toBe(false);
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

  it("never double-prefixes and leaves other commands alone", () => {
    expect(withNativeGoalCommand({ ...first, prompt: "/goal ship it" })).toBe("/goal ship it");
    expect(withNativeGoalCommand({ ...first, prompt: "/review" })).toBe("/review");
  });

  it("sends follow-ups, other modes, fallback providers and attachments unchanged", () => {
    for (const input of [
      { ...first, nativeGoalStarted: true },
      { ...first, interactionMode: "default" },
      { ...first, interactionMode: "plan" },
      { ...first, nativeGoals: false },
      { ...first, attachmentCount: 1 },
    ] as const) {
      expect(withNativeGoalCommand({ ...input, prompt: "ship it" })).toBe("ship it");
    }
    expect(withNativeGoalCommand({ ...first, prompt: "  " })).toBe("  ");
  });
});

describe("resolveInteractionModeSend", () => {
  const send = (prompt: string, nativeGoals = false, attachmentCount = 0) =>
    resolveInteractionModeSend({ prompt, nativeGoals, attachmentCount });

  it("switches without sending when the command stands alone", () => {
    expect(send("/plan")).toEqual({ kind: "switch", mode: "plan" });
    expect(send("  /GOAL  ")).toEqual({ kind: "switch", mode: "goal" });
    expect(send("/default")).toEqual({ kind: "switch", mode: "default" });
  });

  it("strips the command and sends the rest in that mode", () => {
    expect(send("/plan add dark mode\nwith tests")).toEqual({
      kind: "send",
      mode: "plan",
      prompt: "add dark mode\nwith tests",
    });
    expect(send("/goal ship it")).toEqual({ kind: "send", mode: "goal", prompt: "ship it" });
  });

  it("sends attachments in the new mode when the command has no text", () => {
    expect(send("/plan", false, 1)).toEqual({ kind: "send", mode: "plan", prompt: "" });
  });

  it("leaves other text alone", () => {
    expect(send("/planner")).toBeNull();
    expect(send("make a /plan")).toBeNull();
    expect(send("/goals")).toBeNull();
  });

  it("sends a native /goal unchanged, entering Goal mode only for a new objective", () => {
    expect(send("/goal ship it", true)).toEqual({
      kind: "send",
      mode: "goal",
      prompt: "/goal ship it",
    });
    // `/goal clear` ends the goal, so the composer leaves Goal too.
    expect(send("/goal clear", true)).toEqual({
      kind: "send",
      mode: "default",
      prompt: "/goal clear",
    });
    expect(send("/goal resume", true)).toEqual({
      kind: "send",
      mode: null,
      prompt: "/goal resume",
    });
    expect(send("/goal", true)).toEqual({ kind: "send", mode: null, prompt: "/goal" });
  });

  it("treats a native /goal with attachments as an ordinary Goal prompt", () => {
    expect(send("/goal ship it", true, 1)).toEqual({
      kind: "send",
      mode: "goal",
      prompt: "ship it",
    });
  });
});

describe("resolveMatterModeSend", () => {
  it("keeps the composer's mode for ordinary text", () => {
    expect(resolveMatterModeSend({ ...baseSend, prompt: "hi", interactionMode: "goal" })).toEqual({
      ...noExtras,
      prompt: "hi",
      interactionMode: "goal",
      switchTo: null,
      startsNativeGoal: true,
    });
  });

  it("never rewrites annotation sends or queued-message edits", () => {
    for (const bypass of [
      { bypass: true, editingQueuedMessage: false },
      { bypass: false, editingQueuedMessage: true },
    ]) {
      expect(resolveMatterModeSend({ ...baseSend, ...bypass, prompt: "/plan x" })).toEqual({
        ...noExtras,
        prompt: "/plan x",
        interactionMode: "default",
        switchTo: null,
      });
    }
  });

  it("reports a standalone command as a switch with nothing to send", () => {
    expect(resolveMatterModeSend({ ...baseSend, prompt: "/goal" })).toEqual({
      ...noExtras,
      prompt: null,
      interactionMode: "goal",
      switchTo: "goal",
    });
  });

  it("starts a native goal only from the first Goal prompt", () => {
    const goal = { ...baseSend, interactionMode: "goal", nativeGoals: true } as const;
    expect(resolveMatterModeSend({ ...goal, prompt: "ship it" }).startsNativeGoal).toBe(true);
    expect(resolveMatterModeSend({ ...goal, prompt: "/goal ship it" }).startsNativeGoal).toBe(
      false,
    );
    expect(
      resolveMatterModeSend({ ...goal, nativeGoalStarted: true, prompt: "also docs" })
        .startsNativeGoal,
    ).toBe(false);
    expect(
      resolveMatterModeSend({ ...goal, bypass: true, prompt: "ship it" }).startsNativeGoal,
    ).toBe(false);
    // `/goal <objective>` typed in Default on a native provider stays as typed.
    expect(
      resolveMatterModeSend({ ...baseSend, nativeGoals: true, prompt: "/goal ship it" }),
    ).toEqual({ ...noExtras, prompt: "/goal ship it", interactionMode: "goal", switchTo: "goal" });
  });

  it("leaves Goal when a native `/goal clear` is typed", () => {
    expect(
      resolveMatterModeSend({
        ...baseSend,
        prompt: "/goal clear",
        nativeGoals: true,
        interactionMode: "goal",
      }),
    ).toEqual({
      ...noExtras,
      prompt: "/goal clear",
      interactionMode: "default",
      switchTo: "default",
    });
    expect(isGoalClearCommand("/goal clear")).toBe(true);
    expect(isGoalClearCommand("/goal ship it")).toBe(false);
  });

  it("implements a ready plan from an empty composer, back in Default, citing the plan", () => {
    const planImplementation = {
      planId: PlanId.make("plan-1"),
      prompt: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan`,
    };
    expect(
      resolveMatterModeSend({
        ...baseSend,
        prompt: "  ",
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
    // Feedback refines the plan instead.
    expect(
      resolveMatterModeSend({
        ...baseSend,
        prompt: "smaller steps",
        interactionMode: "plan",
        planImplementation,
      }),
    ).toEqual({ ...noExtras, prompt: "smaller steps", interactionMode: "plan", switchTo: null });
    expect(
      resolveMatterModeSend({
        ...baseSend,
        prompt: "",
        interactionMode: "plan",
        planImplementation,
        contextCount: 1,
      }).switchTo,
    ).toBeNull();
  });
});

describe("prependKeepingGoalCommand", () => {
  const card = "[[context:reply-1]]";
  it("keeps `/goal` first so the server still reads the objective", () => {
    expect(prependKeepingGoalCommand("/goal ship it", card)).toBe(`/goal ${card} ship it`);
  });
  it("leads other text, and `/goal` controls, with the card as before", () => {
    expect(prependKeepingGoalCommand("ship it", card)).toBe(`${card} ship it`);
    expect(prependKeepingGoalCommand("/goal clear", card)).toBe(`${card} /goal clear`);
  });
});

describe("latestProposedPlan", () => {
  const base = { threadId: "t", status: "proposed" } as const;
  it("takes the proposed plan, and its id, from the newest run", () => {
    const runs = [
      { id: RunId.make("run-1"), ordinal: 1 },
      { id: RunId.make("run-2"), ordinal: 2 },
    ];
    const plans = [
      {
        ...base,
        id: "plan-2",
        kind: "proposed_plan",
        runId: RunId.make("run-2"),
        markdown: " # Second ",
      },
      {
        ...base,
        id: "plan-1",
        kind: "proposed_plan",
        runId: RunId.make("run-1"),
        markdown: "# First",
      },
      { ...base, id: "todos", kind: "todo_list", runId: RunId.make("run-2"), steps: [] },
    ];
    expect(
      latestProposedPlan({ runs, plans } as unknown as Parameters<typeof latestProposedPlan>[0]),
    ).toEqual({ planId: "plan-2", markdown: "# Second" });
    expect(latestProposedPlan(null)).toBeNull();
  });
});

describe("deriveMatterComposerInteractionMode", () => {
  const derive = (
    overrides: Partial<Parameters<typeof deriveMatterComposerInteractionMode>[0]> = {},
  ) =>
    deriveMatterComposerInteractionMode({
      composerDraftTarget: DraftId.make("matter-derive"),
      composerMode: null,
      thread: undefined,
      isServerThread: true,
      selectedProvider: ProviderDriverKind.make("codex"),
      providerSlashCommands: [],
      providerVersion: null,
      pendingUserInputCount: 0,
      latestProposedPlanId: null,
      latestProposedPlanMarkdown: null,
      canChangeMode: true,
      canClearNativeGoal: true,
      onClearNativeGoal: undefined,
      ...overrides,
    });
  const goalThread = {
    interactionMode: "goal",
    goal: null,
    hasActionableProposedPlan: false,
    latestRun: null,
    runtime: null,
  } as unknown as NonNullable<Parameters<typeof deriveMatterComposerInteractionMode>[0]["thread"]>;

  it("never treats an unsent draft as running a native goal, whatever its draft thread says", () => {
    const draft = derive({ thread: goalThread, isServerThread: false, composerMode: "goal" });
    expect(draft.nativeGoalStarted).toBe(false);
    expect(draft.clearsNativeGoalOnExit).toBe(false);
    const server = derive({ thread: goalThread, isServerThread: true });
    expect(server.nativeGoalStarted).toBe(true);
    expect(server.clearsNativeGoalOnExit).toBe(true);
  });

  it("clears a running native goal on every way out of Goal mode", () => {
    for (const leave of [
      (mode: ReturnType<typeof derive>) => mode.setMode("default"),
      (mode: ReturnType<typeof derive>) => mode.cycleMode(),
      (mode: ReturnType<typeof derive>) => mode.setMode("plan"),
    ]) {
      let clears = 0;
      leave(derive({ thread: goalThread, onClearNativeGoal: () => (clears += 1) }));
      expect(clears).toBe(1);
    }
  });

  it("only switches when the goal can't be cleared there", () => {
    let clears = 0;
    const onClearNativeGoal = () => (clears += 1);
    derive({ thread: goalThread, onClearNativeGoal, canClearNativeGoal: false }).setMode("default");
    derive({ thread: goalThread, onClearNativeGoal, isServerThread: false }).setMode("default");
    derive({
      thread: goalThread,
      onClearNativeGoal,
      selectedProvider: ProviderDriverKind.make("antigravity"),
      providerSlashCommands: [{ name: "goal" }],
    }).setMode("default");
    expect(clears).toBe(0);
  });

  it("keeps the mode on a read-only or offline thread", () => {
    const target = DraftId.make("matter-derive-readonly");
    derive({ composerDraftTarget: target, canChangeMode: false }).setMode("plan");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.interactionMode ?? null).toBe(
      null,
    );
  });
});

describe("resolveMultipleModelTargets", () => {
  const entry = (instanceId: string, driverKind: string) =>
    ({
      instanceId,
      driverKind: ProviderDriverKind.make(driverKind),
      enabled: true,
      isAvailable: true,
      status: "ready",
      models: [],
      snapshot: { slashCommands: [], version: null },
    }) as unknown as ProviderInstanceEntry;
  const providerInstanceEntries = [entry("codex", "codex"), entry("cursor", "cursor")];
  const selections = [
    { instanceId: "codex", model: "gpt" },
    { instanceId: "cursor", model: "composer" },
  ] as unknown as Parameters<typeof resolveMultipleModelTargets>[0]["selections"];

  it("adds `/goal` only for targets whose provider runs native goals", () => {
    const targets = resolveMultipleModelTargets({
      selections,
      providerInstanceEntries,
      messageText: "ship the release",
      startsNativeGoal: true,
    });
    expect(targets.map((target) => ("text" in target ? target.text : target.error))).toEqual([
      "/goal ship the release",
      "ship the release",
    ]);
  });

  it("leaves every target's text alone outside a new Goal", () => {
    const targets = resolveMultipleModelTargets({
      selections,
      providerInstanceEntries,
      messageText: "ship the release",
    });
    expect(targets.map((target) => ("text" in target ? target.text : target.error))).toEqual([
      "ship the release",
      "ship the release",
    ]);
  });
});

describe("matterInteractionModeSlashItems", () => {
  it("adds /plan, /goal and /default to the slash menu search", () => {
    const items = matterInteractionModeSlashItems(english as never, false);
    expect(items.map((item) => item.label)).toEqual(["/plan", "/goal", "/default"]);
    expect(searchSlashCommandItems(items, "pla").map((item) => item.label)[0]).toBe("/plan");
    expect(searchSlashCommandItems(items, "goal").map((item) => item.label)[0]).toBe("/goal");
  });
});

describe("composer draft store", () => {
  it("keeps Goal as a composer's interaction mode", () => {
    const draftId = DraftId.make("matter-goal-mode");
    const store = useComposerDraftStore.getState();
    store.setInteractionMode(draftId, "goal");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.interactionMode).toBe(
      "goal",
    );
    store.setInteractionMode(draftId, "plan");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.interactionMode).toBe(
      "plan",
    );
    store.setInteractionMode(draftId, null);
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.interactionMode ?? null,
    ).toBe(null);
  });

  it("drops a pending mode once the server thread holds it, keeping a newer pick", () => {
    const threadRef = {
      environmentId: EnvironmentId.make("env-matter"),
      threadId: ThreadId.make("thread-matter-persisted"),
    };
    const store = useComposerDraftStore.getState();
    store.setInteractionMode(threadRef, "plan");
    clearPersistedComposerInteractionMode(threadRef, "plan");
    expect(store.getComposerDraft(threadRef)?.interactionMode ?? null).toBe(null);
    store.setInteractionMode(threadRef, "goal");
    clearPersistedComposerInteractionMode(threadRef, "plan");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.interactionMode).toBe(
      "goal",
    );
  });
});
