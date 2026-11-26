import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MatterDelegationInstructions from "./MatterDelegationInstructions.ts";
import {
  buildMatterDelegationInstructions,
  matterDelegationPool,
  matterDelegationExcludes,
} from "./matterDelegationPolicy.ts";

const claudeMain = ProviderInstanceId.make("claudeAgent");
const claudeAlt = ProviderInstanceId.make("claude-alt");
const antigravity = ProviderInstanceId.make("antigravity");

const provider = (
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const on = { mattrMultiProviderDelegation: true };

describe("Matter delegation policy", () => {
  it("lists ready instances in the pool and keeps excluded ones out", () => {
    const pool = matterDelegationPool(
      [
        provider(claudeMain),
        provider(claudeAlt),
        provider(antigravity),
        provider(ProviderInstanceId.make("codex"), { enabled: false }),
        provider(ProviderInstanceId.make("cursor"), { auth: { status: "unauthenticated" } }),
        provider(ProviderInstanceId.make("grok"), { installed: false }),
        provider(ProviderInstanceId.make("pi"), { status: "error" }),
      ],
      { mattrDelegationExcludedInstanceIds: [claudeAlt] },
    );
    assert.deepEqual(pool, { pool: [claudeMain, antigravity], excluded: [claudeAlt] });
  });

  it("writes a short block naming the pool and the excluded instances", () => {
    const text = buildMatterDelegationInstructions(on, {
      pool: [claudeMain, antigravity],
      excluded: [claudeAlt],
    });
    assert.match(text, /^<matter_delegation>\n/);
    assert.match(text, /\n<\/matter_delegation>$/);
    assert.include(text, "`orchestrator_capabilities` first");
    assert.include(text, "`delegate_task`");
    assert.include(text, "leftPercent");
    assert.include(text, "- Pool: claudeAgent, antigravity");
    assert.include(text, "- Never delegate to: claude-alt");
    assert.include(text, "overrides this block");
    assert.isBelow(new TextEncoder().encode(text).length, 1500);
  });

  it("leaves out the never line when nothing is excluded", () => {
    const text = buildMatterDelegationInstructions(on, {
      pool: [claudeMain, antigravity],
      excluded: [],
    });
    assert.notInclude(text, "Never delegate to");
  });

  it("costs nothing while off or with fewer than two instances", () => {
    assert.equal(
      buildMatterDelegationInstructions(
        { mattrMultiProviderDelegation: false },
        { pool: [claudeMain, antigravity], excluded: [] },
      ),
      "",
    );
    assert.equal(buildMatterDelegationInstructions(on, { pool: [claudeMain], excluded: [] }), "");
  });

  it("applies exclusions only while delegation is on", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      mattrDelegationExcludedInstanceIds: [claudeAlt],
    };
    assert.isTrue(matterDelegationExcludes(settings, claudeAlt));
    assert.isFalse(
      matterDelegationExcludes({ ...settings, mattrMultiProviderDelegation: false }, claudeAlt),
    );
  });
});

describe("MatterDelegationInstructions", () => {
  const firstMatching = (predicate: (text: string) => boolean) =>
    Effect.gen(function* () {
      const service = yield* MatterDelegationInstructions.MatterDelegationInstructions;
      const text = yield* service.changes.pipe(Stream.filter(predicate), Stream.runHead);
      return Option.getOrThrow(text);
    });

  it.effect("follows settings and provider changes into new sessions' instructions", () =>
    Effect.gen(function* () {
      const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const settingsChanges = yield* Queue.unbounded<ServerSettingsType>();
      const dependencies = Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([provider(claudeMain)]),
          streamChanges: Stream.fromQueue(providerChanges),
        }),
      );

      yield* Effect.gen(function* () {
        const session = () => buildRuntimeInstructions({ harness: "Claude Code" });
        yield* firstMatching((text) => text === "");
        assert.notInclude(session(), "<matter_delegation>");

        yield* Queue.offer(providerChanges, [
          provider(claudeMain),
          provider(claudeAlt),
          provider(antigravity),
        ]);
        yield* firstMatching((text) => text.includes("claude-alt"));
        assert.include(session(), "- Pool: claudeAgent, claude-alt, antigravity");

        const excluding = {
          ...DEFAULT_SERVER_SETTINGS,
          mattrDelegationExcludedInstanceIds: [claudeAlt],
        };
        yield* Queue.offer(settingsChanges, excluding);
        yield* firstMatching((text) => text.includes("Never delegate to"));
        assert.include(session(), "- Pool: claudeAgent, antigravity");
        assert.include(session(), "- Never delegate to: claude-alt");

        yield* Queue.offer(settingsChanges, { ...excluding, mattrMultiProviderDelegation: false });
        yield* firstMatching((text) => text === "");
        assert.notInclude(session(), "<matter_delegation>");
      }).pipe(Effect.provide(MatterDelegationInstructions.layer.pipe(Layer.provide(dependencies))));

      assert.notInclude(
        buildRuntimeInstructions({ harness: "Claude Code" }),
        "<matter_delegation>",
      );
    }),
  );
});
