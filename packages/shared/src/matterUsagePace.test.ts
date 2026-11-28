import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { rankByUsagePace, usagePace } from "./matterUsagePace.ts";

const now = Date.parse("2026-11-27T12:00:00.000Z");
const HOUR = 3_600_000;
const inHours = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(now + hours * HOUR));

const account = (
  id: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  driver = "claudeAgent",
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-27T11:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: { checkedAt: "2026-11-27T11:00:00.000Z", windows },
});

const weekly = (usedPercent: number, resetsInHours: number): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: inHours(resetsInHours),
});

const session = (usedPercent: number, resetsInHours: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt: inHours(resetsInHours),
});

const fableWeekly: ServerProviderUsageWindow = {
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  modelIds: ["claude-fable-5-2"],
  usedPercent: 97,
  resetsAt: inHours(60),
};

const ids = (providers: ReadonlyArray<ServerProvider>, model?: string) =>
  rankByUsagePace(providers, now, model).map(({ provider }) => provider.instanceId);

describe("usage pace", () => {
  // All $200 plans: main is more used and resets later than alt, so it is the last choice.
  const main = account("claudeAgent", [session(20, 3), weekly(68, 3 * 24 + 16), fableWeekly]);
  const alt = account("claude-alt", [session(40, 2), weekly(61, 2 * 24 + 21)]);
  const codex = account("codex", [weekly(10, 4 * 24 + 13)], "codex");

  it("ranks by usage left per hour until reset, not by usage left", () => {
    expect(ids([main, alt, codex])).toEqual(["codex", "claude-alt", "claudeAgent"]);
    expect(usagePace(main, now)).toEqual({
      leftPercentPerHour: 32 / 88,
      bindingWindow: "Weekly",
      nearLimit: false,
    });
  });

  it("skips model-scoped windows unless that model is the target", () => {
    expect(usagePace(main, now).nearLimit).toBe(false);
    const fable = usagePace(main, now, "claude-fable-5-2");
    expect(fable.nearLimit).toBe(true);
    expect(ids([main, alt], "claude-fable-5-2")).toEqual(["claude-alt", "claudeAgent"]);
  });

  it("puts an account near any limit last, even one that resets soon", () => {
    const nearlyOut = account("nearly-out", [session(96, 0.5), weekly(10, 100)]);
    expect(usagePace(nearlyOut, now).nearLimit).toBe(true);
    expect(ids([nearlyOut, main])).toEqual(["claudeAgent", "nearly-out"]);
  });

  it("treats a window that has not started as full over its duration", () => {
    const fresh = account("fresh", [
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      },
    ]);
    expect(usagePace(fresh, now).leftPercentPerHour).toBeCloseTo(100 / 168);
    expect(ids([main, fresh])).toEqual(["fresh", "claudeAgent"]);
  });

  it("treats a window whose reset has passed as refilled, and one with no duration as unknown", () => {
    const refilled = account("refilled", [
      { ...weekly(99, -1), windowDurationMins: 10080 },
      { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 0 },
    ]);
    expect(usagePace(refilled, now)).toEqual({
      leftPercentPerHour: 100 / 168,
      bindingWindow: "Weekly",
      nearLimit: false,
    });
  });

  it("ranks accounts with no usage reported after those with a known pace", () => {
    const unknown = account("unknown", []);
    expect(usagePace(unknown, now).leftPercentPerHour).toBeNull();
    expect(ids([unknown, main])).toEqual(["claudeAgent", "unknown"]);
  });
});
