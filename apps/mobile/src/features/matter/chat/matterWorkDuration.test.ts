import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { workItemDurationMs } from "./matterWorkDuration";

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("workItemDurationMs", () => {
  it("measures a finished call", () => {
    expect(
      workItemDurationMs({
        startedAt: at("2026-01-01T00:00:00.000Z"),
        completedAt: at("2026-01-01T00:00:02.500Z"),
      }),
    ).toBe(2_500);
  });

  it("has no duration while running, untimed, or out of order", () => {
    expect(
      workItemDurationMs({ startedAt: at("2026-01-01T00:00:00.000Z"), completedAt: null }),
    ).toBe(null);
    expect(workItemDurationMs({})).toBe(null);
    expect(
      workItemDurationMs({
        startedAt: at("2026-01-01T00:00:02.000Z"),
        completedAt: at("2026-01-01T00:00:00.000Z"),
      }),
    ).toBe(null);
  });
});
