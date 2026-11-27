import type {
  ClaudeCloudAccountStatus,
  ClaudeCloudBlocker,
  ClaudeCloudOffloadAdvice,
  ClaudeCloudOffloadPolicy,
  HostPowerSnapshot,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

// Cloud sessions spend the same plan limits as local work, so a nearly spent account stays local.
const SESSION_LIMIT_PERCENT = 80;
const WEEKLY_LIMIT_PERCENT = 90;

const HARD_BLOCKERS: ReadonlySet<ClaudeCloudBlocker> = new Set([
  "account_not_ready",
  "no_project",
  "no_github_remote",
  "detached_head",
]);

const BLOCKER_REASONS: Record<ClaudeCloudBlocker, string> = {
  account_not_ready: "The Claude account can't run cloud sessions",
  no_project: "No project to start from",
  no_github_remote: "This repository has no GitHub origin",
  detached_head: "No branch is checked out",
  unpushed_commits: "The branch has unpushed commits; launch with pushFirst",
};

export interface ClaudeCloudOffloadInput {
  readonly policy: ClaudeCloudOffloadPolicy;
  readonly hostPower: HostPowerSnapshot | null;
  readonly usageWindows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly account: ClaudeCloudAccountStatus | null;
  readonly blockers: ReadonlyArray<ClaudeCloudBlocker>;
}

/** Power reasons to prefer the cloud. A stale reading counts as no pressure. */
const hostPressureReasons = (hostPower: HostPowerSnapshot | null): Array<string> => {
  if (hostPower === null || hostPower.stale) return [];
  const reasons: Array<string> = [];
  if (hostPower.onBattery === "true") reasons.push("On battery power");
  if (hostPower.lowPowerMode === "true") reasons.push("Low Power Mode is on");
  if (hostPower.thermalState === "serious" || hostPower.thermalState === "critical") {
    reasons.push("This machine is running hot");
  }
  return reasons;
};

const calmReason = (hostPower: HostPowerSnapshot | null) =>
  hostPower !== null && !hostPower.stale && hostPower.onBattery === "false"
    ? "Plugged in"
    : "No power pressure reported";

export const usageLimitReasons = (
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): Array<string> =>
  windows
    .filter(
      (window) =>
        (window.modelIds === undefined || window.modelIds.length === 0) &&
        ((window.kind === "session" && window.usedPercent >= SESSION_LIMIT_PERCENT) ||
          (window.kind === "weekly" && window.usedPercent >= WEEKLY_LIMIT_PERCENT)),
    )
    .map(
      (window) =>
        `Claude ${window.label.toLowerCase()} limit ${Math.round(window.usedPercent)}% used`,
    );

export const claudeCloudOffloadAdvice = (
  input: ClaudeCloudOffloadInput,
): ClaudeCloudOffloadAdvice => {
  if (input.policy === "off") {
    return { level: "unavailable", reasons: ["Cloud offload is off"] };
  }
  const blocked = input.blockers.filter((blocker) => HARD_BLOCKERS.has(blocker));
  if (input.account !== null && !input.account.ready && !blocked.includes("account_not_ready")) {
    blocked.unshift("account_not_ready");
  }
  if (blocked.length > 0) {
    return { level: "unavailable", reasons: blocked.map((blocker) => BLOCKER_REASONS[blocker]) };
  }
  const notes = input.blockers.includes("unpushed_commits")
    ? [BLOCKER_REASONS.unpushed_commits]
    : [];
  const limits = usageLimitReasons(input.usageWindows);
  if (limits.length > 0) {
    return { level: "prefer_local", reasons: [...limits, ...notes] };
  }
  const pressure = hostPressureReasons(input.hostPower);
  const underPressure = pressure.length > 0;
  switch (input.policy) {
    case "cloud_first":
      return {
        level: "prefer_cloud",
        reasons: [...(underPressure ? pressure : ["Cloud first is on"]), ...notes],
      };
    case "battery_saver":
      return underPressure
        ? { level: "prefer_cloud", reasons: [...pressure, ...notes] }
        : { level: "prefer_local", reasons: [calmReason(input.hostPower), ...notes] };
    case "ask":
    case "balanced":
      return underPressure
        ? { level: "prefer_cloud", reasons: [...pressure, ...notes] }
        : { level: "cloud_ok", reasons: [calmReason(input.hostPower), ...notes] };
  }
};
