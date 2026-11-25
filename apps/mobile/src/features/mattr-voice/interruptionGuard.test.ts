import { describe, expect, it } from "vite-plus/test";

import {
  confirmsInterruption,
  createInterruptionGuard,
  type InterruptionDecision,
} from "./interruptionGuard";

/** Feeds 60 ms microphone readings: voiced for `voicedMs`, then quiet until `untilMs`. */
function feedLevels(
  guard: ReturnType<typeof createInterruptionGuard>,
  voicedMs: number,
  untilMs: number,
): InterruptionDecision[] {
  const decisions: InterruptionDecision[] = [];
  for (let now = 0; now <= untilMs; now += 60) {
    decisions.push(guard.level(now < voicedMs, now));
    decisions.push(guard.tick(now));
  }
  return decisions.filter((decision) => decision !== "none");
}

describe("confirmsInterruption", () => {
  it("needs two words or one command word", () => {
    expect(confirmsInterruption("um")).toBe(false);
    expect(confirmsInterruption("")).toBe(false);
    expect(confirmsInterruption("stop")).toBe(true);
    expect(confirmsInterruption("Wait!")).toBe(true);
    expect(confirmsInterruption("hold on")).toBe(true);
    expect(confirmsInterruption("actually no")).toBe(true);
  });
});

describe("createInterruptionGuard (energy fallback)", () => {
  it("a 150 ms car-door spike pauses, never interrupts, and resumes the reply", () => {
    const guard = createInterruptionGuard("energy");
    expect(feedLevels(guard, 150, 2_000)).toEqual(["pause", "resume"]);
    expect(guard.state).toBe("idle");
  });

  it("a 240 ms percussive transient is rejected too", () => {
    const guard = createInterruptionGuard("energy");
    expect(feedLevels(guard, 240, 2_000)).not.toContain("interrupt");
  });

  it("sustained speech past 420 ms interrupts, even with short gaps between syllables", () => {
    const guard = createInterruptionGuard("energy");
    const decisions: InterruptionDecision[] = [];
    for (let now = 0; now <= 1_000; now += 60) {
      // Every fourth reading dips below the floor, as speech does between syllables.
      const voiced = now % 240 !== 180;
      decisions.push(guard.level(voiced, now), guard.tick(now));
    }
    expect(decisions.filter((decision) => decision !== "none")).toEqual(["pause", "interrupt"]);
    expect(guard.state).toBe("interrupted");
  });
});

describe("createInterruptionGuard (Flux transcripts)", () => {
  it("StartOfTurn followed by no words resumes after the false-interruption timeout", () => {
    const guard = createInterruptionGuard("transcript");
    expect(guard.speechStart(1_000)).toBe("pause");
    expect(guard.tick(1_500)).toBe("none");
    expect(guard.transcript("", 1_600)).toBe("none");
    expect(guard.tick(1_899)).toBe("none");
    expect(guard.tick(1_900)).toBe("resume");
    expect(guard.state).toBe("idle");
    // A later real interruption still works.
    expect(guard.speechStart(5_000)).toBe("pause");
    expect(guard.transcript("hold on", 5_200)).toBe("interrupt");
  });

  it("energy readings never interrupt in transcript mode", () => {
    const guard = createInterruptionGuard("transcript");
    expect(feedLevels(guard, 2_000, 2_000)).toEqual([]);
  });

  it("two real words interrupt at once", () => {
    const guard = createInterruptionGuard("transcript");
    expect(guard.speechStart(0)).toBe("pause");
    expect(guard.transcript("so", 200)).toBe("none");
    expect(guard.transcript("so actually", 400)).toBe("interrupt");
    expect(guard.tick(5_000)).toBe("none");
    expect(guard.state).toBe("interrupted");
  });

  it("a single command word interrupts without a StartOfTurn first", () => {
    const guard = createInterruptionGuard("transcript");
    expect(guard.transcript("stop", 0)).toBe("interrupt");
  });

  it("a lone filler word keeps the pause alive, then resumes", () => {
    const guard = createInterruptionGuard("transcript");
    expect(guard.transcript("um", 0)).toBe("pause");
    expect(guard.transcript("um", 800)).toBe("none");
    expect(guard.tick(1_200)).toBe("none");
    expect(guard.tick(1_700)).toBe("resume");
  });
});
