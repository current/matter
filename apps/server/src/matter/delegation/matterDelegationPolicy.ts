import {
  isProviderAvailable,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

type DelegationSettings = Pick<
  ServerSettings,
  "agentUsageLimitsVisible" | "mattrMultiProviderDelegation" | "mattrDelegationExcludedInstanceIds"
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
  settings: Pick<DelegationSettings, "mattrMultiProviderDelegation">,
  { pool, excluded }: MatterDelegationPool,
): string {
  if (!settings.mattrMultiProviderDelegation || pool.length < 2) return "";
  return [
    "<matter_delegation>",
    "This app (Matter, a T3 Code build) runs the user's subscriptions at the same time. When the user asks for subagents, parallel work, or a task that splits into independent parts:",
    "- Call `orchestrator_capabilities` first, then start each independent child with `delegate_task`, spread across the pool. Put work on the instances with the most `usage.windows[].leftPercent` left and the best fit for the task, rather than every child on your own provider.",
    "- Use your native subagent tool only for a quick read-only lookup, or when the user names your current provider.",
    `- Pool: ${pool.join(", ")}`,
    ...(excluded.length === 0 ? [] : [`- Never delegate to: ${excluded.join(", ")}`]),
    "What the user says about providers, models or how many children overrides this block. As a child, follow your brief.",
    "</matter_delegation>",
  ].join("\n");
}
