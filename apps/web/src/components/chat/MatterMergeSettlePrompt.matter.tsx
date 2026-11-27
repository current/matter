import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useSyncExternalStore } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useQuietThreadShell } from "../../state/entities";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  addMergeSettleDismissal,
  MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY,
  type MergeSettleDismissals,
  parseMergeSettleDismissals,
  resolveAutoSettleOnMerge,
  resolveMergeSettlePrompt,
} from "@t3tools/client-runtime/matter/merge-settle-prompt";

const MERGED = PULL_REQUEST_STATE_PRESENTATION.merged;

let dismissalsCache: MergeSettleDismissals | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): MergeSettleDismissals {
  if (dismissalsCache === null) {
    try {
      dismissalsCache = parseMergeSettleDismissals(
        localStorage.getItem(MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY),
      );
    } catch {
      dismissalsCache = [];
    }
  }
  return dismissalsCache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dismissMergeSettlePrompt(threadKey: string, prNumber: number): void {
  dismissalsCache = addMergeSettleDismissal(getSnapshot(), threadKey, prNumber);
  try {
    localStorage.setItem(MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY, JSON.stringify(dismissalsCache));
  } catch {
    // Storage is unavailable; the prompt still stays hidden until the page reloads.
  }
  for (const listener of listeners) listener();
}

/** Asks whether to settle a thread whose PR just merged, when the server won't do it itself. */
export function MatterMergeSettlePrompt(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const gt = useGT();
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const threadKey = scopedThreadKey(ref);
  const thread = useQuietThreadShell(ref);
  const projectId = thread?.projectId ?? null;
  const autoSettleOnMerge = useEnvironmentSettings(props.environmentId, (settings) =>
    resolveAutoSettleOnMerge(settings, projectId),
  );
  const dismissals = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const nowMinute = useNowMinute();
  const { settleThread } = useThreadActions();
  if (thread === null) return null;
  const prNumber = resolveMergeSettlePrompt({
    thread,
    threadKey,
    autoSettleOnMerge,
    dismissals,
    nowMs: Date.parse(`${nowMinute}:00Z`),
  });
  if (prNumber === null) return null;

  const settle = async () => {
    const result = await settleThread(ref);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({ type: "error", title: gt("Could not update the thread") }),
      );
    }
  };

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant="info"
        role="status"
        surface="glass"
        controlAlignment="first-line"
        data-matter-merge-prompt=""
      >
        <MERGED.Icon className={MERGED.toneClassName} />
        <AlertTitle>{gt("Pull request #{number} merged", { number: prNumber })}</AlertTitle>
        <AlertDescription>
          {gt("Settle this thread? It moves to Settled in the sidebar.")}
        </AlertDescription>
        <AlertAction>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => dismissMergeSettlePrompt(threadKey, prNumber)}
          >
            {gt("Keep")}
          </Button>
          <Button size="xs" variant="outline" onClick={() => void settle()}>
            {gt("Settle")}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
