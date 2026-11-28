import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

import { modelUsageWindows } from "./usageLimits.ts";

const HOUR = 3_600_000;
/** A window this close to used up makes its account a last resort, however soon it resets. */
const NEAR_LIMIT_LEFT_PERCENT = 5;

export interface UsagePace {
  /** Usage left per hour until the binding window resets; null when no window says. */
  readonly leftPercentPerHour: number | null;
  readonly bindingWindow: string | null;
  readonly nearLimit: boolean;
}

function upcomingReset(window: ServerProviderUsageWindow, now: number): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) && at > now ? at : null;
}

// A window with no upcoming reset has not started (or already refilled): full over its duration.
function windowRate(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = upcomingReset(window, now);
  if (resetsAt !== null) {
    const left = 100 - Math.max(0, Math.min(100, window.usedPercent));
    return left / Math.max((resetsAt - now) / HOUR, 1 / 60);
  }
  if (window.windowDurationMins === undefined || window.windowDurationMins <= 0) return null;
  return 100 / (window.windowDurationMins / 60);
}

/**
 * How much usage an account can afford to spend per hour before its limits reset; the binding
 * (slowest) window wins. Without `model`, model-scoped windows such as "Weekly · Fable" are skipped.
 */
export function usagePace(provider: ServerProvider, now: number, model?: string): UsagePace {
  let leftPercentPerHour: number | null = null;
  let bindingWindow: string | null = null;
  let nearLimit = false;
  // An empty model id matches no model- or provider-scoped window, leaving the account-wide ones.
  for (const window of modelUsageWindows(provider, model ?? "")) {
    const refilled = upcomingReset(window, now) === null && window.resetsAt !== undefined;
    if (!refilled && 100 - window.usedPercent <= NEAR_LIMIT_LEFT_PERCENT) nearLimit = true;
    const rate = windowRate(window, now);
    if (rate !== null && (leftPercentPerHour === null || rate < leftPercentPerHour)) {
      leftPercentPerHour = rate;
      bindingWindow = window.label;
    }
  }
  return { leftPercentPerHour, bindingWindow, nearLimit };
}

/** Best first: a known pace before an unknown one, and anything near its limit last. */
function compareUsagePace(a: UsagePace, b: UsagePace): number {
  if (a.nearLimit !== b.nearLimit) return a.nearLimit ? 1 : -1;
  if (a.leftPercentPerHour === null || b.leftPercentPerHour === null) {
    return (a.leftPercentPerHour === null ? 1 : 0) - (b.leftPercentPerHour === null ? 1 : 0);
  }
  return b.leftPercentPerHour - a.leftPercentPerHour;
}

/** Accounts in the order to give them work; ties keep their input order. */
export function rankByUsagePace(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
  model?: string,
): ReadonlyArray<{ readonly provider: ServerProvider; readonly pace: UsagePace }> {
  return providers
    .map((provider) => ({ provider, pace: usagePace(provider, now, model) }))
    .sort((a, b) => compareUsagePace(a.pace, b.pace));
}
