import {
  type ClaudeCloudAccountStatus,
  type HostPowerSnapshot,
  ProviderInstanceId,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  type ClaudeCloudOffloadInput,
  claudeCloudOffloadAdvice,
} from "./claudeCloudOffloadPolicy.ts";

const power = (patch: Partial<HostPowerSnapshot> = {}): HostPowerSnapshot => ({
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "unknown",
  thermalState: "nominal",
  stale: false,
  updatedAt: DateTime.makeUnsafe(0),
  ...patch,
});

const window = (patch: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow => ({
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 10,
  ...patch,
});

const readyAccount: ClaudeCloudAccountStatus = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  displayName: "Claude",
  ready: true,
  checkedAt: "2026-11-27T00:00:00.000Z",
};

const input = (patch: Partial<ClaudeCloudOffloadInput> = {}): ClaudeCloudOffloadInput => ({
  policy: "balanced",
  hostPower: power(),
  usageWindows: [],
  account: readyAccount,
  blockers: [],
  ...patch,
});

describe("claudeCloudOffloadAdvice", () => {
  it("sends only long jobs to the cloud while plugged in, and everything heavy on battery", () => {
    expect(claudeCloudOffloadAdvice(input())).toEqual({
      level: "cloud_ok",
      reasons: ["Plugged in"],
    });
    expect(claudeCloudOffloadAdvice(input({ hostPower: power({ onBattery: "true" }) }))).toEqual({
      level: "prefer_cloud",
      reasons: ["On battery power"],
    });
  });

  it("counts Low Power Mode and thermal load as pressure, but not a stale reading", () => {
    expect(
      claudeCloudOffloadAdvice(
        input({ hostPower: power({ lowPowerMode: "true", thermalState: "serious" }) }),
      ),
    ).toEqual({
      level: "prefer_cloud",
      reasons: ["Low Power Mode is on", "This machine is running hot"],
    });
    expect(
      claudeCloudOffloadAdvice(input({ hostPower: power({ onBattery: "true", stale: true }) })),
    ).toEqual({ level: "cloud_ok", reasons: ["No power pressure reported"] });
    expect(claudeCloudOffloadAdvice(input({ hostPower: null })).level).toBe("cloud_ok");
  });

  it("keeps work local on AC power under Battery saver, and in the cloud under Cloud first", () => {
    expect(claudeCloudOffloadAdvice(input({ policy: "battery_saver" })).level).toBe("prefer_local");
    expect(
      claudeCloudOffloadAdvice(
        input({ policy: "battery_saver", hostPower: power({ onBattery: "true" }) }),
      ).level,
    ).toBe("prefer_cloud");
    expect(claudeCloudOffloadAdvice(input({ policy: "cloud_first" }))).toEqual({
      level: "prefer_cloud",
      reasons: ["Cloud first is on"],
    });
  });

  it("stays local when the account is nearly out of usage, even on battery", () => {
    expect(
      claudeCloudOffloadAdvice(
        input({
          hostPower: power({ onBattery: "true" }),
          usageWindows: [
            window({ usedPercent: 91.6 }),
            window({ id: "fable", label: "Weekly · Fable", usedPercent: 99, modelIds: ["fable"] }),
            window({ id: "session", kind: "session", label: "Session", usedPercent: 79 }),
          ],
        }),
      ),
    ).toEqual({ level: "prefer_local", reasons: ["Claude weekly limit 92% used"] });
  });

  it("is unavailable when off, signed out or the repository can't reach GitHub", () => {
    expect(claudeCloudOffloadAdvice(input({ policy: "off" })).level).toBe("unavailable");
    expect(claudeCloudOffloadAdvice(input({ account: { ...readyAccount, ready: false } }))).toEqual(
      { level: "unavailable", reasons: ["The Claude account can't run cloud sessions"] },
    );
    expect(
      claudeCloudOffloadAdvice(input({ blockers: ["no_github_remote", "unpushed_commits"] })),
    ).toEqual({ level: "unavailable", reasons: ["This repository has no GitHub origin"] });
  });

  it("still recommends the cloud with unpushed commits, telling the agent to push first", () => {
    expect(
      claudeCloudOffloadAdvice(
        input({ hostPower: power({ onBattery: "true" }), blockers: ["unpushed_commits"] }),
      ),
    ).toEqual({
      level: "prefer_cloud",
      reasons: ["On battery power", "The branch has unpushed commits; launch with pushFirst"],
    });
  });
});
