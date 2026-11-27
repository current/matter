import {
  deriveMatterCloudRuns,
  type MatterCloudRun,
} from "@t3tools/client-runtime/matter/cloud-runs";
import { CLAUDE_CLOUD_ADDON_ID } from "@t3tools/contracts";
import { useEffect } from "react";

import { useMatterApiConfig } from "../../addons/matterApi";
import { useIsAddonEnabled } from "../../addons/useAddonRegistry";
import {
  nudgeClaudeCloudRuns,
  retainClaudeCloudRunWatch,
  useClaudeCloudSessionsState,
} from "./claudeCloudStore";

const NO_RUNS: ReadonlyArray<MatterCloudRun> = [];

/**
 * Running and waiting cloud runs that chats started, while the Claude Cloud add-on is on.
 * Off, it renders nothing and makes no requests.
 */
export function useMatterCloudRuns(): ReadonlyArray<MatterCloudRun> {
  const enabled = useIsAddonEnabled(CLAUDE_CLOUD_ADDON_ID);
  const config = useMatterApiConfig();
  const state = useClaudeCloudSessionsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the cloud store's run watch, which reads the server only while a chat's cloud run is live
  useEffect(() => {
    if (!enabled || config === null) return;
    return retainClaudeCloudRunWatch(config);
  }, [enabled, config]);
  return enabled ? deriveMatterCloudRuns(state.sessions) : NO_RUNS;
}

/** Re-reads once whenever a chat's `runKey` changes: its run started or ended. */
export function useMatterCloudRunNudge(threadKey: string, runKey: string): void {
  const enabled = useIsAddonEnabled(CLAUDE_CLOUD_ADDON_ID);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a chat's turn boundary is when its agent may have launched a cloud run, so the external cloud store reads once
  useEffect(() => {
    if (!enabled) return;
    nudgeClaudeCloudRuns(threadKey, runKey);
  }, [enabled, threadKey, runKey]);
}
