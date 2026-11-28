import {
  isProviderAvailable,
  type OrchestratorMcpProviderCapability,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { rankByUsagePace } from "@t3tools/shared/matterUsagePace";

type DelegationSettings = Pick<
  ServerSettings,
  | "agentUsageLimitsVisible"
  | "mattrMultiProviderDelegation"
  | "mattrDelegationExcludedInstanceIds"
  | "mattrDelegationBalanceByPace"
>;

export const MATTER_DELEGATION_EXCLUDED_CONSTRAINT =
  "The user keeps this instance out of delegation; delegate_task to it fails with instance_excluded.";

/** Delegation spreads work by usage left, so agents see usage whenever it is on. */
export const matterUsageVisible = (settings: DelegationSettings): boolean =>
  settings.agentUsageLimitsVisible || settings.mattrMultiProviderDelegation;

/** Exclusions belong to multi-provider delegation; off restores upstream behavior. */
export const matterDelegationExcludes = (
  settings: DelegationSettings,
  instanceId: ProviderInstanceId,
): boolean =>
  settings.mattrMultiProviderDelegation &&
  settings.mattrDelegationExcludedInstanceIds.includes(instanceId);

/** Pace ranking belongs to multi-provider delegation, like exclusions. */
const matterDelegationRanksByPace = (
  settings: Pick<
    DelegationSettings,
    "mattrMultiProviderDelegation" | "mattrDelegationBalanceByPace"
  >,
): boolean => settings.mattrMultiProviderDelegation && settings.mattrDelegationBalanceByPace;

/**
 * Ranks the instances that can run a child right now by usage pace. Excluded instances can't, so
 * they are never ranked. The session block is read once, so live ordering travels here.
 */
export function withMatterDelegationRanks<
  Result extends { readonly providers: ReadonlyArray<OrchestratorMcpProviderCapability> },
>(
  settings: Pick<
    DelegationSettings,
    "mattrMultiProviderDelegation" | "mattrDelegationBalanceByPace"
  >,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
  result: Result,
): Result {
  if (!matterDelegationRanksByPace(settings)) return result;
  const eligible = new Set(
    result.providers
      .filter((entry) => entry.canRunChildTask)
      .map((entry) => entry.providerInstanceId),
  );
  const ranked = new Map(
    rankByUsagePace(
      providers.filter((provider) => eligible.has(provider.instanceId)),
      now,
    ).map(({ provider, pace }, index) => [provider.instanceId, { rank: index + 1, pace }]),
  );
  return {
    ...result,
    providers: result.providers.map((entry) => {
      const ranking = ranked.get(entry.providerInstanceId);
      if (ranking === undefined) return entry;
      const { pace } = ranking;
      return {
        ...entry,
        delegationRank: ranking.rank,
        ...(pace.leftPercentPerHour === null || pace.bindingWindow === null
          ? {}
          : {
              usagePace: {
                leftPercentPerHour: Math.round(pace.leftPercentPerHour * 100) / 100,
                bindingWindow: pace.bindingWindow,
                ...(pace.nearLimit ? { nearLimit: true } : {}),
              },
            }),
      };
    }),
  };
}

export const matterDelegationExcludedMessage = (instanceId: ProviderInstanceId): string =>
  `The user excluded ${instanceId} from delegation in Settings → Threads. Pick another provider from orchestrator_capabilities, or do the work yourself; don't retry ${instanceId}.`;

/** Instances a delegated child can start on right now: enabled, installed, healthy and signed in. */
const isDelegationReady = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

export interface MatterDelegationPool {
  readonly pool: ReadonlyArray<ProviderInstanceId>;
  readonly excluded: ReadonlyArray<ProviderInstanceId>;
}

export function matterDelegationPool(
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<DelegationSettings, "mattrDelegationExcludedInstanceIds">,
): MatterDelegationPool {
  const excludedIds = new Set<string>(settings.mattrDelegationExcludedInstanceIds);
  const ready = providers.filter(isDelegationReady).map((provider) => provider.instanceId);
  return {
    pool: ready.filter((instanceId) => !excludedIds.has(instanceId)),
    excluded: providers
      .map((provider) => provider.instanceId)
      .filter((instanceId) => excludedIds.has(instanceId)),
  };
}

/** Empty unless delegation is on with two or more instances to spread across, so it costs nothing otherwise. */
export function buildMatterDelegationInstructions(
  settings: Pick<
    DelegationSettings,
    "mattrMultiProviderDelegation" | "mattrDelegationBalanceByPace"
  >,
  { pool, excluded }: MatterDelegationPool,
): string {
  if (!settings.mattrMultiProviderDelegation || pool.length < 2) return "";
  return [
    "<matter_delegation>",
    "This app (Matter, a T3 Code build) runs the user's subscriptions at the same time. When the user asks for subagents, parallel work, or a task that splits into independent parts:",
    matterDelegationRanksByPace(settings)
      ? "- Call `orchestrator_capabilities` first, then start each independent child with `delegate_task`, spread across the pool. Prefer instances by `delegationRank` (1 first) and fit for the task, spreading children over the top few rather than all on one or on your own provider."
      : "- Call `orchestrator_capabilities` first, then start each independent child with `delegate_task`, spread across the pool. Put work on the instances with the most `usage.windows[].leftPercent` left and the best fit for the task, rather than every child on your own provider.",
    "- Use your native subagent tool only for a quick read-only lookup, or when the user names your current provider.",
    `- Pool: ${pool.join(", ")}`,
    ...(excluded.length === 0 ? [] : [`- Never delegate to: ${excluded.join(", ")}`]),
    "What the user says about providers, models or how many children overrides this block. As a child, follow your brief.",
    "</matter_delegation>",
  ].join("\n");
}
