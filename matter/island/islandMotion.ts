/**
 * Island motion: the springs measured from a reference notch app (duration/bounce as in
 * SwiftUI's `Spring(duration:bounce:)`, response/damping as in `.spring(response:dampingFraction:)`),
 * baked into CSS `linear()` easings at build time so a settled island runs no JavaScript.
 */

export interface IslandSpring {
  /** Stiffness with unit mass. */
  readonly stiffness: number;
  readonly damping: number;
}

/** SwiftUI `Spring(duration:bounce:)` → physical spring (WWDC23 conversion, negative bounce overdamps). */
export function springFromDurationBounce(duration: number, bounce: number): IslandSpring {
  const omega = (2 * Math.PI) / duration;
  const zeta = bounce >= 0 ? Math.max(0.05, 1 - bounce) : 1 / Math.max(0.15, 1 + bounce);
  return { stiffness: omega * omega, damping: 2 * zeta * omega };
}

/** SwiftUI `.spring(response:dampingFraction:)` → physical spring. */
export function springFromResponseDamping(response: number, dampingFraction: number): IslandSpring {
  const omega = (2 * Math.PI) / response;
  return { stiffness: omega * omega, damping: 2 * dampingFraction * omega };
}

export const ISLAND_SPRINGS = {
  expand: springFromDurationBounce(0.6, 0.35),
  collapse: springFromDurationBounce(0.35, -0.2),
  hover: springFromDurationBounce(0.3, 0.325),
  pop: springFromDurationBounce(0.35, 0.45),
  morph: springFromDurationBounce(0.5, 0.375),
  notification: springFromDurationBounce(0.35, 0.3),
  settle: springFromResponseDamping(0.4875, 1),
  peek: springFromResponseDamping(0.3, 1),
  press: springFromResponseDamping(0.2, 1),
} as const satisfies Record<string, IslandSpring>;

export type IslandSpringName = keyof typeof ISLAND_SPRINGS;

/** Content transitions, in ms / px. */
export const ISLAND_CONTENT_TRANSITIONS = {
  insert: { blur: 8, y: 12, delayMs: 60, durationMs: 300 },
  remove: { blur: 5.6, y: -12, durationMs: 225 },
  swap: { scale: 0.6, blur: 4 },
  hoverBloom: { x: 1.06, y: 1.075 },
  press: 0.96,
} as const;

export interface SampledSpringEasing {
  /** CSS `linear()` easing; values above 1 carry the overshoot. */
  readonly easing: string;
  readonly durationMs: number;
}

const SETTLE_DISTANCE = 0.001;
const SETTLE_VELOCITY = 0.01;
const STEP_SECONDS = 0.001;
const MAX_SECONDS = 3;
const MAX_POINTS = 48;

/** Unit step response of the spring, sampled to a `linear()` easing that ends exactly at 1. */
export function sampleSpringEasing(spring: IslandSpring): SampledSpringEasing {
  const positions: number[] = [0];
  let x = 0;
  let v = 0;
  let t = 0;
  while (t < MAX_SECONDS) {
    v += (-spring.stiffness * (x - 1) - spring.damping * v) * STEP_SECONDS;
    x += v * STEP_SECONDS;
    t += STEP_SECONDS;
    positions.push(x);
    if (Math.abs(1 - x) < SETTLE_DISTANCE && Math.abs(v) < SETTLE_VELOCITY) break;
  }
  const last = positions.length - 1;
  const points = Math.min(MAX_POINTS, last);
  const values: string[] = [];
  for (let i = 0; i <= points; i += 1) {
    const value = i === points ? 1 : (positions[Math.round((i / points) * last)] ?? 1);
    values.push(String(Math.round(value * 1000) / 1000));
  }
  return { easing: `linear(${values.join(", ")})`, durationMs: Math.round(t * 1000) };
}

/** `--island-ease-<name>` / `--island-dur-<name>` custom properties for every spring. */
export function islandMotionCssVariables(): string {
  return Object.entries(ISLAND_SPRINGS)
    .map(([name, spring]) => {
      const sampled = sampleSpringEasing(spring);
      return `--island-ease-${name}: ${sampled.easing};\n    --island-dur-${name}: ${sampled.durationMs}ms;`;
    })
    .join("\n    ");
}
