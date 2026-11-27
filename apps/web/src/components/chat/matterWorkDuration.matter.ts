import * as DateTime from "effect/DateTime";

import type { WorkLogEntry } from "../../session-logic";

type WorkEntryTiming = Pick<WorkLogEntry, "projectedItem">;

function itemSpan(entry: WorkEntryTiming): readonly [number, number] | null {
  const item = entry.projectedItem?.item;
  if (!item?.startedAt || !item.completedAt) return null;
  const start = DateTime.toEpochMillis(item.startedAt);
  const end = DateTime.toEpochMillis(item.completedAt);
  return end >= start ? [start, end] : null;
}

/** How long a finished tool call or thought ran, from its item's start and completion. */
export function workEntryDurationMs(entry: WorkEntryTiming): number | null {
  const span = itemSpan(entry);
  return span ? span[1] - span[0] : null;
}

/** From the first finished entry's start to the last one's end; null while none has finished. */
export function workEntriesSpanMs(entries: ReadonlyArray<WorkEntryTiming>): number | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const span = itemSpan(entry);
    if (!span) continue;
    start = Math.min(start, span[0]);
    end = Math.max(end, span[1]);
  }
  return end >= start ? end - start : null;
}

/** Spreads into a row only when known, so rows without timing keep upstream's shape. */
export function withMatterDuration(durationMs: number | null): { durationMs?: number } {
  return durationMs === null ? {} : { durationMs };
}
