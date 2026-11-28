import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:matter-delegation-parent");
const projectId = ProjectId.make("project:matter-delegation");
const claudeMain = ProviderInstanceId.make("claudeAgent");
const claudeAlt = ProviderInstanceId.make("claude-alt");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:matter-delegation"),
  requestNamespace: "provider-session:matter-delegation",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:matter-delegation",
    providerInstanceId: claudeMain,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const provider = (
  instanceId: ProviderInstanceId,
  usedPercent: number,
  resetsInHours?: number,
): ServerProvider => ({
  instanceId,
  driver: claudeDriver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [{ slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-01T00:00:00.000Z",
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent,
        // The test clock starts at the epoch.
        ...(resetsInHours === undefined
          ? {}
          : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsInHours * 3_600_000)) }),
      },
    ],
  },
});

const parentProjection = {
  thread: {
    id: parentThreadId,
    projectId,
    title: "Lead",
    createdBy: "user",
    creationSource: "web",
    modelSelection: { instanceId: claudeMain, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  runs: [
    {
      id: RunId.make("run:matter-delegation-parent"),
      ordinal: 1,
      status: "running",
      rootNodeId: NodeId.make("node:matter-delegation-root"),
      providerInstanceId: claudeMain,
      modelSelection: { instanceId: claudeMain, model: "claude-opus-5-5" },
    },
  ],
  contextTransfers: [],
  subagents: [],
} as unknown as OrchestrationV2ThreadProjection;

const unpacedProviders = [provider(claudeMain, 30), provider(claudeAlt, 80)];

const serviceLayer = (
  settings: Partial<ServerSettingsType>,
  providers: ReadonlyArray<ServerProvider> = unpacedProviders,
) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        isNonGitProject: () => Effect.succeed(false),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection),
        }),
        ServerSettings.layerTest({
          providerInstances: { [claudeAlt]: { driver: claudeDriver, enabled: true } },
          ...settings,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(providers),
          refreshInstance: () => Effect.succeed(providers),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed([claudeMain, claudeAlt]),
            get: (instanceId) =>
              Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );

const capabilitiesWith = (
  settings: Partial<ServerSettingsType>,
  providers?: ReadonlyArray<ServerProvider>,
) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.capabilities(scope);
    return new Map(result.providers.map((entry) => [entry.providerInstanceId, entry]));
  }).pipe(Effect.provide(serviceLayer(settings, providers)));

// Main has more usage left but resets much later, so alt can spend faster.
const pacedProviders = [provider(claudeMain, 30, 140), provider(claudeAlt, 50, 20)];

describe("OrchestratorMcpService Matter delegation", () => {
  it.effect("shows usage left while multi-provider delegation is on, even with usage hidden", () =>
    Effect.gen(function* () {
      const byId = yield* capabilitiesWith({ agentUsageLimitsVisible: false });
      assert.deepEqual(byId.get(claudeAlt)?.usage?.windows, [{ label: "Weekly", leftPercent: 20 }]);
      assert.deepEqual(byId.get(claudeMain)?.usage?.windows, [
        { label: "Weekly", leftPercent: 70 },
      ]);
    }),
  );

  it.effect("hides usage when delegation and agent usage limits are both off", () =>
    Effect.gen(function* () {
      const byId = yield* capabilitiesWith({
        agentUsageLimitsVisible: false,
        mattrMultiProviderDelegation: false,
      });
      assert.isUndefined(byId.get(claudeMain)?.usage);
    }),
  );

  it.effect("marks an excluded instance and says why it cannot run children", () =>
    Effect.gen(function* () {
      const byId = yield* capabilitiesWith({ mattrDelegationExcludedInstanceIds: [claudeAlt] });
      const excluded = byId.get(claudeAlt);
      assert.isTrue(excluded?.excludedFromDelegation);
      assert.isFalse(excluded?.canRunChildTask);
      assert.isTrue(excluded?.constraints.some((line) => line.includes("instance_excluded")));
      assert.isUndefined(byId.get(claudeMain)?.excludedFromDelegation);
      assert.isTrue(byId.get(claudeMain)?.canRunChildTask);
    }),
  );

  it.effect("ignores exclusions while multi-provider delegation is off", () =>
    Effect.gen(function* () {
      const byId = yield* capabilitiesWith({
        mattrMultiProviderDelegation: false,
        mattrDelegationExcludedInstanceIds: [claudeAlt],
      });
      assert.isUndefined(byId.get(claudeAlt)?.excludedFromDelegation);
      assert.isTrue(byId.get(claudeAlt)?.canRunChildTask);
    }),
  );

  it.effect("ranks instances by usage left per hour until reset", () =>
    Effect.gen(function* () {
      const byId = yield* capabilitiesWith({}, pacedProviders);
      assert.equal(byId.get(claudeAlt)?.delegationRank, 1);
      assert.deepEqual(byId.get(claudeAlt)?.usagePace, {
        leftPercentPerHour: 2.5,
        bindingWindow: "Weekly",
      });
      assert.equal(byId.get(claudeMain)?.delegationRank, 2);
      assert.deepEqual(byId.get(claudeMain)?.usagePace, {
        leftPercentPerHour: 0.5,
        bindingWindow: "Weekly",
      });
    }),
  );

  it.effect("never ranks an excluded instance", () =>
    Effect.gen(function* () {
      const byId = yield* capabilitiesWith(
        { mattrDelegationExcludedInstanceIds: [claudeAlt] },
        pacedProviders,
      );
      assert.equal(byId.get(claudeMain)?.delegationRank, 1);
      assert.isUndefined(byId.get(claudeAlt)?.delegationRank);
      assert.isUndefined(byId.get(claudeAlt)?.usagePace);
    }),
  );

  it.effect("leaves ranks out while pace balancing or delegation is off", () =>
    Effect.gen(function* () {
      for (const settings of [
        { mattrDelegationBalanceByPace: false },
        { mattrMultiProviderDelegation: false },
      ]) {
        const byId = yield* capabilitiesWith(settings, pacedProviders);
        assert.isUndefined(byId.get(claudeMain)?.delegationRank);
        assert.isUndefined(byId.get(claudeAlt)?.usagePace);
      }
    }),
  );

  it.effect("refuses delegate_task to an excluded instance with instance_excluded", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const failure = yield* service
        .delegateTask(scope, {
          task: "Summarize the diff.",
          target: { providerInstanceId: claudeAlt },
          mode: "async",
          clientRequestId: "matter-delegation-excluded-1",
        })
        .pipe(Effect.flip);
      assert.equal(failure.code, "instance_excluded");
      assert.include(failure.message, "claude-alt");
      assert.include(failure.message, "Settings → Threads");
    }).pipe(Effect.provide(serviceLayer({ mattrDelegationExcludedInstanceIds: [claudeAlt] }))),
  );
});
