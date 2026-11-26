import { describe, expect, it } from "vite-plus/test";

import { islandModel as M } from "../../../../matter/island/islandModel.ts";
import {
  ISLAND_SPRINGS,
  sampleSpringEasing,
  springFromDurationBounce,
} from "../../../../matter/island/islandMotion.ts";
import type { IslandDoneNotification } from "../../../../matter/island/types.ts";
import { makeIslandApproval, makeIslandSnapshot, makeIslandThread } from "./islandTestFixtures.ts";

const NOTCH = { hasNotch: true, notchWidth: 200, notchHeight: 32, windowWidth: 520 };

function done(overrides: Partial<IslandDoneNotification> = {}): IslandDoneNotification {
  return {
    key: "env:done",
    environmentId: "env",
    threadId: "done",
    threadTitle: "Finished thread",
    completedAt: 10_000,
    outcome: "completed",
    ...overrides,
  };
}

function easingValues(easing: string): number[] {
  return easing
    .replace(/^linear\(|\)$/g, "")
    .split(",")
    .map((value) => Number(value.trim()));
}

describe("spring easings", () => {
  it("converts SwiftUI springs and samples a step response that ends exactly at 1", () => {
    const expand = springFromDurationBounce(0.6, 0.35);
    expect(expand.stiffness).toBeCloseTo(((2 * Math.PI) / 0.6) ** 2);
    for (const spring of Object.values(ISLAND_SPRINGS)) {
      const { easing, durationMs } = sampleSpringEasing(spring);
      const values = easingValues(easing);
      expect(values[0]).toBe(0);
      expect(values.at(-1)).toBe(1);
      expect(durationMs).toBeGreaterThan(100);
      expect(durationMs).toBeLessThan(2000);
    }
  });

  it("overshoots on bouncy springs and never on the overdamped collapse", () => {
    expect(
      Math.max(...easingValues(sampleSpringEasing(ISLAND_SPRINGS.expand).easing)),
    ).toBeGreaterThan(1);
    expect(
      Math.max(...easingValues(sampleSpringEasing(ISLAND_SPRINGS.collapse).easing)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...easingValues(sampleSpringEasing(ISLAND_SPRINGS.settle).easing)),
    ).toBeLessThanOrEqual(1);
  });
});

describe("wing state", () => {
  it("hides when nothing is going on", () => {
    const wing = M.deriveWing(makeIslandSnapshot(), 0);
    expect(wing.kind).toBe("idle");
    expect(
      M.resolveMode({
        open: false,
        dropActive: false,
        hoverPeek: false,
        autoPeeking: false,
        wingKind: wing.kind,
      }),
    ).toBe("hidden");
  });

  it("shows one running agent with its plan ring, or event-driven dots without a plan", () => {
    const withPlan = M.deriveWing(
      makeIslandSnapshot({
        recentThreads: [
          makeIslandThread({
            key: "env:a",
            status: "running",
            providerKind: "codex",
            plan: { completed: 2, total: 5, currentStep: null },
          }),
        ],
      }),
      0,
    );
    expect(withPlan).toMatchObject({
      kind: "running",
      providerKind: "codex",
      progress: { completed: 2, total: 5 },
      wingWidth: 36,
    });
    const dots = M.deriveWing(
      makeIslandSnapshot({
        recentThreads: [makeIslandThread({ key: "env:a", status: "running", toolCallCount: 7 })],
      }),
      0,
    );
    expect(dots).toMatchObject({ kind: "running", progress: null, step: 7 });
  });

  it("counts several running agents behind the newest provider", () => {
    const wing = M.deriveWing(
      makeIslandSnapshot({
        recentThreads: [
          makeIslandThread({
            key: "env:old",
            status: "running",
            providerKind: "codex",
            runStartedAt: "2026-11-26T09:00:00.000Z",
          }),
          makeIslandThread({
            key: "env:new",
            status: "running",
            providerKind: "claudeAgent",
            runStartedAt: "2026-11-26T09:30:00.000Z",
          }),
          makeIslandThread({ key: "env:idle", status: "idle" }),
        ],
      }),
      0,
    );
    expect(wing).toMatchObject({ kind: "running-many", count: 2, providerKind: "claudeAgent" });
  });

  it("puts what needs you first, with wider wings and a count", () => {
    const snapshot = makeIslandSnapshot({
      recentThreads: [
        makeIslandThread({ key: "env:a", status: "running" }),
        makeIslandThread({ key: "env:thread", status: "approval", providerKind: "codex" }),
      ],
      pendingApprovals: [makeIslandApproval(), makeIslandApproval({ requestId: "request-2" })],
    });
    expect(M.deriveWing(snapshot, 0)).toMatchObject({
      kind: "needs-you",
      count: 2,
      wingWidth: 44,
      providerKind: "codex",
    });
    // Answered locally: the wing steps down before the server confirms.
    expect(M.deriveWing(snapshot, 0, new Set(["request-1", "request-2"])).kind).toBe("running");
  });

  it("shows a failure or usage limit until it is seen, ahead of running work", () => {
    const snapshot = makeIslandSnapshot({
      recentThreads: [makeIslandThread({ key: "env:a", status: "running" })],
      doneNotifications: [done({ outcome: "limited" })],
    });
    expect(M.deriveWing(snapshot, 999_999).kind).toBe("failed");
  });

  it("holds the ✓ for 4 s after a run finishes, then retracts", () => {
    const snapshot = makeIslandSnapshot({ doneNotifications: [done({ completedAt: 10_000 })] });
    const wing = M.deriveWing(snapshot, 10_000);
    expect(wing).toMatchObject({ kind: "done", expiresAt: 14_000 });
    expect(M.deriveWing(snapshot, 13_999).kind).toBe("done");
    expect(M.deriveWing(snapshot, 14_000).kind).toBe("idle");
  });

  it("shows the wave while listening, even with notch status turned off", () => {
    const base = makeIslandSnapshot();
    const listening = makeIslandSnapshot({
      settings: { ...base.settings, showNotifications: false },
      voice: { ...base.voice, phase: "recording" },
      recentThreads: [makeIslandThread({ key: "env:a", status: "running" })],
    });
    expect(M.deriveWing(listening, 0)).toMatchObject({ kind: "listening", wingWidth: 64 });
    expect(M.deriveWing({ ...listening, voice: base.voice }, 0).kind).toBe("idle");
    const voiceMode = makeIslandSnapshot({
      assistant: { ...base.assistant, handsFreeActive: true },
    });
    expect(M.deriveWing(voiceMode, 0).kind).toBe("listening");
  });
});

describe("island mode and Open card", () => {
  it("opens over everything, peeks on hover or auto-peek, else shows the wings", () => {
    const base = {
      open: false,
      dropActive: false,
      hoverPeek: false,
      autoPeeking: false,
      wingKind: "running" as const,
    };
    expect(M.resolveMode(base)).toBe("collapsed");
    expect(M.resolveMode({ ...base, hoverPeek: true })).toBe("peek");
    expect(M.resolveMode({ ...base, autoPeeking: true })).toBe("peek");
    expect(M.resolveMode({ ...base, autoPeeking: true, open: true })).toBe("open");
    expect(M.resolveMode({ ...base, wingKind: "idle", dropActive: true })).toBe("open");
  });

  it("picks Drop > Needs you > Prompt > Glance", () => {
    const none = {
      dropActive: false,
      needsYouCount: 0,
      hasDraft: false,
      wantsPrompt: false,
      glanceCount: 3,
    };
    expect(
      M.chooseOpenCard({ ...none, dropActive: true, needsYouCount: 2, wantsPrompt: true }),
    ).toBe("drop");
    expect(M.chooseOpenCard({ ...none, needsYouCount: 1, wantsPrompt: true })).toBe("needs-you");
    expect(M.chooseOpenCard({ ...none, wantsPrompt: true })).toBe("prompt");
    expect(M.chooseOpenCard(none)).toBe("glance");
    // Nothing to glance at: go straight to the composer.
    expect(M.chooseOpenCard({ ...none, glanceCount: 0 })).toBe("prompt");
  });

  it("keeps a draft the user is writing on screen when a request arrives", () => {
    expect(
      M.chooseOpenCard({
        dropActive: false,
        needsYouCount: 1,
        hasDraft: true,
        wantsPrompt: false,
        glanceCount: 2,
      }),
    ).toBe("prompt");
    expect(
      M.chooseOpenCard({
        dropActive: true,
        needsYouCount: 1,
        hasDraft: true,
        wantsPrompt: false,
        glanceCount: 2,
      }),
    ).toBe("drop");
  });

  it("sizes the shell: hidden is the camera housing, wings flank it, Peek and Open widen", () => {
    const idle = M.deriveWing(makeIslandSnapshot(), 0);
    expect(M.shellGeometry("hidden", idle, NOTCH, 0)).toMatchObject({
      width: 200,
      height: 32,
      ear: 0,
    });
    const running = M.deriveWing(
      makeIslandSnapshot({ recentThreads: [makeIslandThread({ status: "running" })] }),
      0,
    );
    expect(M.shellGeometry("collapsed", running, NOTCH, 0)).toEqual({
      width: 272,
      height: 32,
      ear: 8,
      bottomRadius: 10,
      pill: false,
    });
    expect(M.shellGeometry("peek", running, NOTCH, 120)).toMatchObject({
      width: 360,
      height: 152,
      ear: 18,
      bottomRadius: 24,
    });
    expect(M.shellGeometry("open", running, NOTCH, 200).width).toBe(420);
    const external = { ...NOTCH, hasNotch: false, notchWidth: 168, notchHeight: 34 };
    expect(M.shellGeometry("collapsed", running, external, 0)).toMatchObject({
      ear: 0,
      bottomRadius: 17,
      pill: true,
    });
  });

  it("keeps the shell on whole points when the notch is fractional", () => {
    const running = M.deriveWing(
      makeIslandSnapshot({ recentThreads: [makeIslandThread({ status: "running" })] }),
      0,
    );
    const wideNotch = { ...NOTCH, notchWidth: 353.5 };
    expect(M.shellGeometry("collapsed", running, wideNotch, 0).width).toBe(426);
    expect(M.shellGeometry("open", running, wideNotch, 200).width).toBe(426);
  });
});

describe("auto-peek", () => {
  it("peeks for 3 s the first time a request shows up, once per request", () => {
    let state = M.stepAutoPeek({ seen: [], until: 0 }, ["request-1"], 1000, true);
    expect(M.isAutoPeeking(state, 1000)).toBe(true);
    expect(M.isAutoPeeking(state, 3999)).toBe(true);
    expect(M.isAutoPeeking(state, 4000)).toBe(false);
    state = M.stepAutoPeek(state, ["request-1"], 5000, true);
    expect(M.isAutoPeeking(state, 5000)).toBe(false);
    state = M.stepAutoPeek(state, ["request-1", "request-2"], 6000, true);
    expect(state.until).toBe(9000);
  });

  it("marks requests seen without peeking while the island is open or the app shows them", () => {
    let state = M.stepAutoPeek({ seen: [], until: 0 }, ["request-1"], 1000, false);
    expect(M.isAutoPeeking(state, 1000)).toBe(false);
    state = M.stepAutoPeek(state, ["request-1"], 2000, true);
    expect(M.isAutoPeeking(state, 2000)).toBe(false);
  });

  it("forgets answered requests, so an id that comes back peeks again", () => {
    let state = M.stepAutoPeek({ seen: [], until: 0 }, ["request-1"], 0, true);
    state = M.stepAutoPeek(state, [], 4000, true);
    expect(state.seen).toEqual([]);
    state = M.stepAutoPeek(state, ["request-1"], 5000, true);
    expect(M.isAutoPeeking(state, 5000)).toBe(true);
  });
});

describe("Peek and Glance rows", () => {
  it("lists needs-you, then running, then finished, four at most", () => {
    const snapshot = makeIslandSnapshot({
      pendingApprovals: [makeIslandApproval({ threadId: "thread" })],
      recentThreads: [
        makeIslandThread({ key: "env:thread", status: "approval" }),
        makeIslandThread({ key: "env:r1", status: "running" }),
        makeIslandThread({ key: "env:r2", status: "running" }),
      ],
      doneNotifications: [
        done({ key: "env:d1", threadId: "d1" }),
        done({ key: "env:d2", threadId: "d2", outcome: "failed" }),
      ],
    });
    const rows = M.peekRows(snapshot);
    expect(rows.map((row) => row.kind)).toEqual(["needs-you", "running", "running", "done"]);
    expect(rows[0]?.needsYou?.kind).toBe("approval");
  });

  it("glances at active threads first, then the most recent", () => {
    const snapshot = makeIslandSnapshot({
      recentThreads: [
        makeIslandThread({ key: "env:new", status: "done", updatedAt: "2026-11-26T12:00:00.000Z" }),
        makeIslandThread({
          key: "env:run",
          status: "running",
          updatedAt: "2026-11-26T08:00:00.000Z",
        }),
        makeIslandThread({ key: "env:mid", status: "idle", updatedAt: "2026-11-26T11:00:00.000Z" }),
      ],
    });
    expect(M.glanceThreads(snapshot).map((t) => t.key)).toEqual(["env:run", "env:new", "env:mid"]);
  });
});

describe("quick capture", () => {
  it("cycles → thread, New thread, Task with Tab", () => {
    const snapshot = makeIslandSnapshot({
      selectedThreadKey: "env:b",
      recentThreads: [makeIslandThread({ key: "env:a" }), makeIslandThread({ key: "env:b" })],
    });
    const targets = M.captureTargets(snapshot);
    expect(targets).toEqual([
      { kind: "thread", environmentId: "env", threadId: "b" },
      { kind: "new-thread" },
      { kind: "task" },
    ]);
    expect(M.nextTarget(targets, targets[0]!)).toEqual({ kind: "new-thread" });
    expect(M.nextTarget(targets, { kind: "task" })).toEqual(targets[0]);
    expect(M.nextTarget(targets, null)).toEqual(targets[0]);
    expect(
      M.captureTargets(makeIslandSnapshot({ canStartThread: false, canCreateTask: false })),
    ).toEqual([]);
  });

  it("reads /plan and /goal prefixes", () => {
    expect(M.parseCapturePrefix("/plan refactor auth")).toEqual({
      interactionMode: "plan",
      text: "refactor auth",
    });
    expect(M.parseCapturePrefix("  /GOAL ship it ")).toEqual({
      interactionMode: "goal",
      text: "ship it",
    });
    expect(M.parseCapturePrefix("/planner is a word")).toEqual({
      interactionMode: "default",
      text: "/planner is a word",
    });
    expect(M.parseCapturePrefix("fix the bug")).toEqual({
      interactionMode: "default",
      text: "fix the bug",
    });
  });
});

describe("capture target", () => {
  const plan = {
    environmentId: "env",
    threadId: "bg",
    threadTitle: "Background thread",
    planId: "plan-1",
    title: "Plan",
    steps: [],
    stepCount: 0,
    canApprove: true,
  };

  it("keeps Revise…'s plan thread even when it is not the selected thread", () => {
    const snapshot = makeIslandSnapshot({
      selectedThreadKey: "env:a",
      recentThreads: [makeIslandThread({ key: "env:a" })],
      pendingPlans: [plan],
    });
    const revise = { kind: "thread" as const, environmentId: "env", threadId: "bg" };
    expect(M.reconcileTarget(snapshot, revise)).toEqual(revise);
    expect(M.threadTitle(snapshot, "env:bg")).toBe("Background thread");
  });

  it("holds a chosen thread while another thread becomes the newest, until it disappears", () => {
    const chosen = { kind: "thread" as const, environmentId: "env", threadId: "a" };
    const busier = makeIslandSnapshot({
      recentThreads: [makeIslandThread({ key: "env:b" }), makeIslandThread({ key: "env:a" })],
    });
    expect(M.captureTargets(busier)[0]).toEqual({
      kind: "thread",
      environmentId: "env",
      threadId: "b",
    });
    expect(M.reconcileTarget(busier, chosen)).toEqual(chosen);
    const gone = makeIslandSnapshot({ recentThreads: [makeIslandThread({ key: "env:b" })] });
    expect(M.reconcileTarget(gone, chosen)).toEqual({
      kind: "thread",
      environmentId: "env",
      threadId: "b",
    });
  });

  it("picks the first target when none is set, and drops New thread once it can't start", () => {
    const snapshot = makeIslandSnapshot({ canStartThread: false });
    expect(M.reconcileTarget(snapshot, null)).toEqual({ kind: "task" });
    expect(M.reconcileTarget(snapshot, { kind: "new-thread" })).toEqual({ kind: "task" });
  });

  it("sends local paths only to threads on this Mac", () => {
    const snapshot = makeIslandSnapshot({
      localEnvironmentId: "env",
      selectedThreadKey: "remote:r",
      recentThreads: [makeIslandThread({ key: "remote:r" }), makeIslandThread({ key: "env:a" })],
    });
    expect(
      M.capturePathsAllowed(snapshot, { kind: "thread", environmentId: "env", threadId: "a" }),
    ).toBe(true);
    expect(
      M.capturePathsAllowed(snapshot, { kind: "thread", environmentId: "remote", threadId: "r" }),
    ).toBe(false);
    // New thread starts beside the selected thread, here on the remote environment.
    expect(M.capturePathsAllowed(snapshot, { kind: "new-thread" })).toBe(false);
    expect(M.capturePathsAllowed(snapshot, { kind: "task" })).toBe(true);
    expect(
      M.capturePathsAllowed(makeIslandSnapshot({ localEnvironmentId: null }), {
        kind: "thread",
        environmentId: "env",
        threadId: "a",
      }),
    ).toBe(false);
  });

  it("keeps only http(s) and file links and strips control characters from names", () => {
    expect(
      M.acceptedDropLinks(
        "# comment\nhttps://x.dev/a\njavascript:alert(1)\nfile:///Users/me/a.txt\nmailto:a@b.c\n",
      ),
    ).toEqual(["https://x.dev/a", "file:///Users/me/a.txt"]);
    expect(M.stripControlCharacters("re\nport\u0007.pdf\u009b")).toBe("report.pdf");
    expect(M.hasControlCharacters("/tmp/a\nb")).toBe(true);
    expect(M.hasControlCharacters("/tmp/ünïcode ok.png")).toBe(false);
  });
});

describe("answering safely", () => {
  it("ignores presses for 300 ms after the item under them changes", () => {
    let guard = M.stepInputGuard({ key: "", since: 0 }, "request-1", 1000);
    expect(M.isInputGuarded(guard, 1000 + M.INPUT_GUARD_MS - 1)).toBe(true);
    expect(M.isInputGuarded(guard, 1000 + M.INPUT_GUARD_MS)).toBe(false);
    // The same item on later renders keeps its original time.
    expect(M.stepInputGuard(guard, "request-1", 5000)).toBe(guard);
    // A request answered elsewhere: the next one slides in and is guarded again.
    guard = M.stepInputGuard(guard, "request-2", 5000);
    expect(M.isInputGuarded(guard, 5100)).toBe(true);
    // Nothing actionable on screen guards nothing.
    expect(M.isInputGuarded(M.stepInputGuard(guard, "", 6000), 6000)).toBe(false);
  });

  it("shows an answered request again if it is still live after the timeout", () => {
    const answered = new Map([
      ["cleared", 0],
      ["pending", 1000],
    ]);
    const live = new Set(["pending"]);
    expect([...M.pruneAnswered(answered, live, 2000).keys()]).toEqual(["pending"]);
    expect(M.pruneAnswered(answered, live, 1000 + M.ANSWER_TIMEOUT_MS).size).toBe(0);
    const snapshot = makeIslandSnapshot({ pendingApprovals: [makeIslandApproval()] });
    expect(M.needsYouItems(snapshot, new Map([["request-1", 0]]))).toEqual([]);
  });

  it("offers inline Approve / Deny only for a real accept and decline", () => {
    expect(M.inlineApprovalChoices(makeIslandApproval())).toEqual({
      accept: { decision: "accept", label: "Allow once" },
      decline: { decision: "decline", label: "Deny" },
    });
    // Antigravity without allow-once: no fallback to "always allow" or to cancel.
    expect(
      M.inlineApprovalChoices(
        makeIslandApproval({
          options: [
            { decision: "acceptForSession", label: "Always allow" },
            { decision: "decline", label: "Deny" },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      M.inlineApprovalChoices(
        makeIslandApproval({
          options: [
            { decision: "accept", label: "Allow" },
            { decision: "cancel", label: "Stop" },
          ],
        }),
      ),
    ).toBeNull();
  });
});
