import * as DateTime from "effect/DateTime";

export interface WorkItemTiming {
  readonly startedAt?: DateTime.Utc | null;
  readonly completedAt?: DateTime.Utc | null;
}

/** How long a finished tool call ran, from its item's start and completion; null until then. */
export function workItemDurationMs(item: WorkItemTiming): number | null {
  if (!item.startedAt || !item.completedAt) return null;
  const durationMs =
    DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt);
  return durationMs >= 0 ? durationMs : null;
}
