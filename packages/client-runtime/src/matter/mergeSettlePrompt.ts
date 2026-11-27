import type { EnvironmentThreadShell } from "../state/models.ts";
import { resolveThreadCurrentPullRequestLink } from "../threadPullRequests.ts";
import type { ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

export const MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY = "mattr:merge-settle-prompt:v1";
const MATTER_MERGE_SETTLE_PROMPT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_DISMISSALS = 200;

type PromptThread = Pick<
  EnvironmentThreadShell,
  "projectId" | "pullRequests" | "settledOverride" | "unsettledAt" | "archivedAt" | "latestRun"
>;

/** Thread key → dismissed PR number, oldest first. */
export type MergeSettleDismissals = ReadonlyArray<readonly [threadKey: string, prNumber: number]>;

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The project's effective auto-settle-on-merge, resolved the way ThreadSettlementService does. */
export function resolveAutoSettleOnMerge(
  settings: ServerSettings,
  projectId: EnvironmentThreadShell["projectId"] | null,
): boolean {
  return resolveProjectSettings(settings, projectId).settings.sidebarAutoSettleOnMerge;
}

/** The merged PR number the thread should ask about, or null when it should stay quiet. */
export function resolveMergeSettlePrompt(input: {
  thread: PromptThread;
  threadKey: string;
  autoSettleOnMerge: boolean;
  dismissals: MergeSettleDismissals;
  nowMs: number;
}): number | null {
  const { thread } = input;
  if (thread.settledOverride === "settled" || thread.archivedAt !== null) return null;
  if (thread.latestRun !== null && ACTIVE_RUN_STATUSES.has(thread.latestRun.status)) return null;
  const link = resolveThreadCurrentPullRequestLink(thread.pullRequests ?? []);
  const snapshot = link?.snapshot;
  if (!link || !snapshot || snapshot.state !== "merged") return null;
  const mergedMs = Date.parse(snapshot.mergedAt ?? snapshot.updatedAt ?? "");
  if (!Number.isFinite(mergedMs) || input.nowMs - mergedMs > MATTER_MERGE_SETTLE_PROMPT_WINDOW_MS) {
    return null;
  }
  // Unsettled after the merge: the user already chose to keep it.
  const unsettledMs = Date.parse(thread.unsettledAt ?? "");
  if (Number.isFinite(unsettledMs) && unsettledMs >= mergedMs) return null;
  // The server settles it itself when the effective setting is on.
  if (input.autoSettleOnMerge) return null;
  const dismissed = input.dismissals.some(
    ([key, number]) => key === input.threadKey && number === link.number,
  );
  return dismissed ? null : link.number;
}

export function parseMergeSettleDismissals(raw: string | null): MergeSettleDismissals {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, number] =>
        Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number",
    );
  } catch {
    return [];
  }
}

/** One entry per thread, newest last, capped at the newest 200. */
export function addMergeSettleDismissal(
  dismissals: MergeSettleDismissals,
  threadKey: string,
  prNumber: number,
): MergeSettleDismissals {
  const next = dismissals.filter(([key]) => key !== threadKey);
  next.push([threadKey, prNumber]);
  return next.slice(-MAX_DISMISSALS);
}
