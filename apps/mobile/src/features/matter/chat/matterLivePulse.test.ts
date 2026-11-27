import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MATTER_PULSE_CYCLE_MS,
  MATTER_PULSE_DIM_OPACITY,
  matterPulseSchedule,
  startMatterPulseSteps,
} from "./matterLivePulse";

describe("matterPulseSchedule", () => {
  it("dims and returns in six steps each over one two-second cycle", () => {
    const schedule = matterPulseSchedule();
    expect(schedule).toHaveLength(12);
    expect(schedule[5]![0]).toBe(MATTER_PULSE_DIM_OPACITY);
    expect(schedule[11]![0]).toBe(1);
    expect(schedule.reduce((total, [, delay]) => total + delay, 0)).toBeCloseTo(
      MATTER_PULSE_CYCLE_MS,
    );
  });
});

describe("startMatterPulseSteps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds full ink, steps down, and restores full ink when stopped", () => {
    vi.useFakeTimers();
    const values: number[] = [];
    const stop = startMatterPulseSteps({ setValue: (value) => values.push(value) });
    expect(values).toEqual([1]);
    vi.advanceTimersByTime(800);
    expect(values).toEqual([1]);
    vi.advanceTimersByTime(200);
    expect(values.at(-1)).toBe(MATTER_PULSE_DIM_OPACITY);
    vi.advanceTimersByTime(MATTER_PULSE_CYCLE_MS);
    expect(values.at(-1)).toBe(MATTER_PULSE_DIM_OPACITY);
    const written = values.length;
    stop();
    expect(values.at(-1)).toBe(1);
    vi.advanceTimersByTime(MATTER_PULSE_CYCLE_MS);
    expect(values).toHaveLength(written + 1);
  });
});
