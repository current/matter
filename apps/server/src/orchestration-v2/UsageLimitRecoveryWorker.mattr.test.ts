import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type * as ProjectionStore from "./ProjectionStore.ts";
import { limitSwitchCommand } from "./UsageLimitRecoveryWorker.ts";

const nowMs = Date.parse("2026-10-19T12:00:00.000Z");
const failedAt = DateTime.makeUnsafe(nowMs - 60_000);
const thread: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  id: ThreadId.make("thread:limited"),
  projectId: ProjectId.make("project:limited"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 60 * 60_000)),
  latestRunId: RunId.make("run:limited"),
  latestRunCompletedAt: failedAt,
  updatedAt: failedAt,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  limitRecovery: null,
  snoozedUntil: null,
};

const claude = (id: string, usedPercent: number): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-19T11:00:00.000Z",
  models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-10-19T11:00:00.000Z",
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent }],
  },
});

const providers = [claude("claudeAgent", 40), claude("claude-alt", 0), claude("claude-alt-2", 50)];
const settingsExcluding = (excluded: ReadonlyArray<string>) => ({
  ...DEFAULT_SERVER_SETTINGS,
  fallbackToAvailableAccounts: true,
  fallbackExcludedInstanceIds: excluded.map((id) => ProviderInstanceId.make(id)),
  providerInstances: Object.fromEntries(
    providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: true }]),
  ),
});
const switchTo = (excluded: ReadonlyArray<string>) => {
  const command = limitSwitchCommand(thread, {
    providers,
    settings: settingsExcluding(excluded),
    nowMs,
    limitedUntil: new Map(),
  });
  return command?.type === "message.dispatch" ? command.modelSelection?.instanceId : command;
};

describe("limitSwitchCommand with excluded accounts", () => {
  it("never continues a limited thread on an excluded account", () => {
    assert.equal(switchTo([]), "claude-alt");
    assert.equal(switchTo(["claude-alt"]), "claude-alt-2");
  });

  it("waits for the reset when every other account is excluded", () => {
    assert.isNull(switchTo(["claude-alt", "claude-alt-2"]));
  });
});
