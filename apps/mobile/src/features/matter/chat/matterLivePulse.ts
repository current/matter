/*
 * Matter "Tighter" live rows pulse in place of upstream's sweeping shimmer, as on web
 * (`matter-wl-pulse` in matter/chat-worklog.css): full ink for 800 ms, six steps down to 58% over
 * 200 ms, hold, six steps back. Each step is one native value write, so a 2 s cycle costs twelve
 * timer ticks and no frames in between.
 */
/** Live rows pulse instead of shimmering; upstream's shimmer stays in place, switched off. */
export const MATTER_LIVE_PULSE: boolean = true;

export const MATTER_PULSE_CYCLE_MS = 2_000;
export const MATTER_PULSE_DIM_OPACITY = 0.58;
const HOLD_MS = 800;
const FADE_MS = 200;
const FADE_STEPS = 6;

/** One cycle's `[opacity, delay before it]` writes, starting from full opacity. */
export function matterPulseSchedule(): ReadonlyArray<readonly [opacity: number, delayMs: number]> {
  const stepMs = FADE_MS / FADE_STEPS;
  const fade = (from: number, to: number) =>
    Array.from({ length: FADE_STEPS }, (_, index) => {
      const value = from + ((to - from) * (index + 1)) / FADE_STEPS;
      return [Math.round(value * 1_000) / 1_000, index === 0 ? HOLD_MS + stepMs : stepMs] as const;
    });
  return [...fade(1, MATTER_PULSE_DIM_OPACITY), ...fade(MATTER_PULSE_DIM_OPACITY, 1)];
}

const SCHEDULE = matterPulseSchedule();

/** Runs the pulse on `opacity` until the returned stop, which restores full opacity. */
export function startMatterPulseSteps(opacity: { setValue(value: number): void }): () => void {
  let index = 0;
  let timer: ReturnType<typeof setTimeout>;
  const advance = () => {
    const [value] = SCHEDULE[index]!;
    opacity.setValue(value);
    index = (index + 1) % SCHEDULE.length;
    timer = setTimeout(advance, SCHEDULE[index]![1]);
  };
  opacity.setValue(1);
  timer = setTimeout(advance, SCHEDULE[0]![1]);
  return () => {
    clearTimeout(timer);
    opacity.setValue(1);
  };
}
