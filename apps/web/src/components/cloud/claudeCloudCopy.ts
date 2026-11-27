import type { ClaudeCloudSessionState } from "@t3tools/contracts";
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
