import type {
  ClaudeCloudRemoteSession,
  ClaudeCloudSessionState,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Claude Cloud runs a chat started (by its agent's `claude_cloud_launch` or the user), shown like
 * that chat's subagents: in its Whisper Pill and nested under it in the sidebar while they run or
 * wait on input. A run brought back into a local thread (teleported) is that thread's now.
 */

export type MatterCloudRunState = Extract<ClaudeCloudSessionState, "running" | "needs_input">;

export interface MatterCloudRun {
  readonly id: string;
  readonly title: string;
  readonly state: MatterCloudRunState;
  readonly sourceThreadId: ThreadId;
  readonly instanceId: string;
  /** What it waits on, while it needs input. */
  readonly needsAction: string | null;
  /** When its current run began: the last message Matter sent it, else its launch. */
  readonly startedAt: string;
  readonly updatedAt: string;
}

export type MatterCloudRunSession = Pick<
  ClaudeCloudRemoteSession,
  "id" | "title" | "state" | "instanceId" | "needsAction" | "createdAt" | "updatedAt"
> & {
  readonly tracked: Pick<
    NonNullable<ClaudeCloudRemoteSession["tracked"]>,
    "sourceThreadId" | "teleportedThreadId" | "lastMessageAt"
  > | null;
};

function isMatterCloudRunState(
  state: ClaudeCloudSessionState | null | undefined,
): state is MatterCloudRunState {
  return state === "running" || state === "needs_input";
}

/** Every running or waiting cloud run that came from a chat, newest first. */
export function deriveMatterCloudRuns(
  sessions: ReadonlyArray<MatterCloudRunSession> | null,
): ReadonlyArray<MatterCloudRun> {
  if (sessions === null) return [];
  const runs: MatterCloudRun[] = [];
  for (const session of sessions) {
    const source = session.tracked?.sourceThreadId ?? null;
    if (source === null || session.tracked?.teleportedThreadId != null) continue;
    if (!isMatterCloudRunState(session.state)) continue;
    runs.push({
      id: session.id,
      title: session.title,
      state: session.state,
      sourceThreadId: source,
      instanceId: session.instanceId,
      needsAction: session.needsAction,
      startedAt: session.tracked?.lastMessageAt ?? session.createdAt,
      updatedAt: session.updatedAt,
    });
  }
  return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

const waitingFirst = (left: MatterCloudRun, right: MatterCloudRun) =>
  Number(right.state === "needs_input") - Number(left.state === "needs_input");

/** The runs one chat started, needs-input first so the one waiting on the user leads. */
export function matterCloudRunsForThread(
  runs: ReadonlyArray<MatterCloudRun>,
  threadId: ThreadId,
): ReadonlyArray<MatterCloudRun> {
  return runs.filter((run) => run.sourceThreadId === threadId).sort(waitingFirst);
}

/**
 * Runs grouped under the row each nests under. `rowKeyFor` maps a source thread id to that row's
 * key (the thread itself, or the listed thread it runs under), or null when it isn't listed.
 */
export function groupMatterCloudRuns(
  runs: ReadonlyArray<MatterCloudRun>,
  rowKeyFor: (sourceThreadId: ThreadId) => string | null,
): ReadonlyMap<string, ReadonlyArray<MatterCloudRun>> {
  const index = new Map<string, MatterCloudRun[]>();
  for (const run of runs) {
    const key = rowKeyFor(run.sourceThreadId);
    if (key === null) continue;
    const bucket = index.get(key) ?? [];
    bucket.push(run);
    index.set(key, bucket);
  }
  for (const bucket of index.values()) bucket.sort(waitingFirst);
  return index;
}

/**
 * Running cloud runs as work below their source thread, for `workingDescendantSince`, so the
 * chat shows as running while its cloud run does. One waiting on input isn't working.
 */
export function matterCloudRunWork(
  runs: ReadonlyArray<MatterCloudRun>,
  threadKeyFor: (sourceThreadId: ThreadId) => string,
): ReadonlyArray<{ readonly parentKey: string; readonly since: string }> {
  return runs
    .filter((run) => run.state === "running")
    .map((run) => ({ parentKey: threadKeyFor(run.sourceThreadId), since: run.startedAt }));
}

/**
 * Whether watchers (the pill, the sidebars) keep reading remote state: only while a chat's cloud
 * run was last seen running or waiting. Otherwise one read on mount, and on the nudges below.
 */
export function shouldWatchMatterCloudRuns(
  sessions: ReadonlyArray<MatterCloudRunSession> | null,
): boolean {
  return deriveMatterCloudRuns(sessions).length > 0;
}

/**
 * A key that changes when a chat may have just launched a cloud run: its run starting or ending.
 * Watchers re-read once on each change instead of polling for new launches.
 */
export function matterCloudRunNudgeKey(
  latestRun: { readonly runId: string; readonly status: string } | null,
): string {
  return latestRun === null ? "" : `${latestRun.runId}:${latestRun.status}`;
}
