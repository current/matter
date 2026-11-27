import type { OrchestrationV2Run, OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";

import { announcedRun } from "../state/threadActivityAnnouncement.ts";

type PredictionRun = {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly startedAt: string | null;
};

/**
 * Matter: the composer prediction while the run that produced it is the thread's latest finished
 * turn (`waiting` only holds for subagents). A message promoted to Steer leaves a never-started
 * cancelled run as latest, so this skips to the last run that ran, but only once the runs include
 * that cancelled run: detail can lag the shell. Mirrors web's `offeredPromptSuggestion`.
 */
export function offeredMatterPromptPrediction<Prediction extends { readonly runId: RunId }>(
  prediction: Prediction | null | undefined,
  latestRun: PredictionRun | null | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
): Prediction | null {
  const run = announcedRun(latestRun ?? null, runs);
  const skippedUnseenRun =
    latestRun != null &&
    run?.runId !== latestRun.runId &&
    !runs.some(
      (candidate) =>
        candidate.id === latestRun.runId &&
        candidate.status === "cancelled" &&
        candidate.startedAt === null,
    );
  return prediction &&
    !skippedUnseenRun &&
    run?.runId === prediction.runId &&
    (run.status === "completed" || run.status === "waiting")
    ? prediction
    : null;
}

/** A late accept must never prepend the prediction to a draft that already has text. */
export function matterPromptPredictionToAccept(
  prediction: string | null,
  draft: string,
): string | null {
  return draft.length === 0 ? prediction : null;
}
