import type { ClaudeCloudOffloadPolicy, ClaudeCloudSessionState } from "@t3tools/contracts";
import { msg } from "gt-react";

export const CLAUDE_CLOUD_STATE_LABELS: Readonly<Record<ClaudeCloudSessionState, string>> = {
  running: msg("Working"),
  needs_input: msg("Needs you"),
  idle: msg("Idle"),
  failed: msg("Failed"),
  archived: msg("Archived"),
};

export const CLAUDE_CLOUD_STATE_BADGE: Readonly<
  Record<ClaudeCloudSessionState, "info" | "warning" | "outline" | "error" | "secondary">
> = {
  running: "info",
  needs_input: "warning",
  idle: "outline",
  failed: "error",
  archived: "secondary",
};

export const CLAUDE_CLOUD_OFFLOAD_POLICY_ORDER: ReadonlyArray<ClaudeCloudOffloadPolicy> = [
  "balanced",
  "battery_saver",
  "cloud_first",
  "ask",
  "off",
];

export const CLAUDE_CLOUD_OFFLOAD_POLICY_LABELS: Readonly<
  Record<ClaudeCloudOffloadPolicy, string>
> = {
  balanced: msg("Balanced", { $context: "Claude Cloud offload policy" }),
  battery_saver: msg("Battery saver", { $context: "Claude Cloud offload policy" }),
  cloud_first: msg("Cloud first", { $context: "Claude Cloud offload policy" }),
  ask: msg("Ask first", { $context: "agents ask before offloading to Claude Cloud" }),
  off: msg("Manual only", { $context: "only the user launches Claude Cloud sessions" }),
};

export const CLAUDE_CLOUD_OFFLOAD_POLICY_HINTS: Readonly<Record<ClaudeCloudOffloadPolicy, string>> =
  {
    balanced: msg("Long jobs, plus the rest on battery"),
    battery_saver: msg("Only on battery or when hot"),
    cloud_first: msg("All heavy work, whenever it can"),
    ask: msg("Agents ask you each time"),
    off: msg("Only when you send it"),
  };

export const CLAUDE_CLOUD_OFFLOAD_POLICY_DESCRIPTIONS: Readonly<
  Record<ClaudeCloudOffloadPolicy, string>
> = {
  balanced: msg(
    "Long builds and test suites run in the cloud. Other heavy work moves there on battery or when this machine runs hot.",
  ),
  battery_saver: msg(
    "Heavy work runs in the cloud on battery or when this machine runs hot, and stays here while plugged in.",
  ),
  cloud_first: msg("Heavy work runs in the cloud whenever it can."),
  ask: msg("Agents ask you before moving work to the cloud."),
  off: msg("Agents never offload. You can still send work to the cloud yourself."),
};
