import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { availableAccountSelection, resolveNewThreadModelSelection } from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

const account = (id: string, usedPercent: number, driver = "claudeAgent"): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-03T11:00:00.000Z",
  models: [
    {
      slug: driver === "claudeAgent" ? selection.model : "gpt-6.1-sol",
      name: "Model",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-09-03T11:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        resetsAt: "2026-09-03T14:00:00.000Z",
      },
    ],
  },
});

const limited = account("claudeAgent", 100);

const settingsFor = (providers: ServerProvider[], excluded: string[]) => ({
  ...DEFAULT_SERVER_SETTINGS,
  fallbackToAvailableAccounts: true,
  fallbackExcludedInstanceIds: excluded.map((id) => ProviderInstanceId.make(id)),
  providerInstances: Object.fromEntries(
    providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: true }]),
  ),
});

const choose = (others: ServerProvider[], excluded: string[]) => {
  const providers = [limited, ...others];
  const settings = settingsFor(providers, excluded);
  return {
    send: availableAccountSelection({ selection, providers, now, settings }),
    newThread: resolveNewThreadModelSelection({
      defaultSelection: selection,
      fallbackSelection: null,
      providers,
      settings,
      now,
    }),
  };
};

describe("accounts excluded from automatic switching", () => {
  it("skips an excluded account even when it has the most headroom", () => {
    const result = choose(
      [account("claude-alt", 0), account("claude-alt-2", 60), account("codex", 0, "codex")],
      ["claude-alt"],
    );
    expect(result.send).toEqual({ ...selection, instanceId: "claude-alt-2" });
    expect(result.newThread.selection).toEqual({ ...selection, instanceId: "claude-alt-2" });
  });

  it("skips an excluded account on another provider", () => {
    const result = choose([account("claude-alt", 100), account("codex", 0, "codex")], ["codex"]);
    expect(result.send).toBeNull();
  });

  it("falls through like no account having usage when every candidate is excluded", () => {
    const others = [account("claude-alt", 0), account("codex", 0, "codex")];
    const noneLeft = choose(
      others.map((entry) => account(entry.instanceId, 100, entry.driver)),
      [],
    );
    const allExcluded = choose(others, ["claude-alt", "codex"]);
    expect(allExcluded.send).toBeNull();
    expect(allExcluded.send).toEqual(noneLeft.send);
    expect(allExcluded.newThread).toEqual(noneLeft.newThread);
    expect(allExcluded.newThread.selection).toEqual(selection);
  });

  it("moves work off an excluded account that ran out", () => {
    const providers = [account("claude-alt", 100), account("claude-alt-2", 30)];
    const settings = settingsFor(providers, ["claude-alt"]);
    expect(
      availableAccountSelection({
        selection: { ...selection, instanceId: ProviderInstanceId.make("claude-alt") },
        providers,
        now,
        settings,
      }),
    ).toEqual({ ...selection, instanceId: "claude-alt-2" });
  });
});
