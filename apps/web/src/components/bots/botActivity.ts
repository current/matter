import type { BotActivityState } from "@t3tools/contracts";
import { msg } from "gt-react";

export const BOT_ACTIVITY_LABELS: Readonly<Record<BotActivityState, string>> = {
  idle: msg("Idle"),
  working: msg("Working"),
  waiting_for_user: msg("Waiting for you"),
  waiting_for_approval: msg("Needs approval"),
  finished: msg("Finished"),
  suspended: msg("Suspended"),
  error: msg("Error"),
  offline: msg("Offline"),
  unknown: msg("Unknown"),
};

/** States worth a dot in the sidebar; the rest stay quiet. */
export const BOT_ACTIVITY_DOT: Readonly<Partial<Record<BotActivityState, string>>> = {
  working: "bg-info",
  waiting_for_user: "bg-warning",
  waiting_for_approval: "bg-warning",
  error: "bg-destructive",
};
