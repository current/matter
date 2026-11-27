import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { isListedThreadLineage, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { useQuietThreadShells } from "../../../state/entities";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../../state/olderSettledShelf";
import type { MatterThreadItem } from "./matterSidebar.logic";
import type { MatterSidebarProject } from "./useMatterSidebarModel";

const FIRST_ROWS = 25;
const MORE_ROWS = 25;

/** Every environment the projects live in, or only the filtered project's members. */
function settledScopes(
  projects: ReadonlyArray<MatterSidebarProject>,
  projectFilter: string | null,
): ReadonlyArray<OlderSettledScope> {
  const byEnvironment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (projectFilter !== null && project.key !== projectFilter) continue;
    for (const ref of project.group.memberProjectRefs) {
      const ids = byEnvironment.get(ref.environmentId) ?? [];
      ids.push(ref.projectId);
      byEnvironment.set(ref.environmentId, ids);
    }
  }
  return [...byEnvironment].map(([environmentId, projectIds]) => ({
    environmentId,
    projectIds: projectFilter === null ? null : projectIds,
  }));
}

/**
 * The Settled section's rows. Shells hold only each environment's newest settled threads, so
 * older ones load in pages through upstream's Settled shelf, which also counts the ones not loaded.
 */
export function useMatterSettledShelf(input: {
  /** The section's local rows, newest settle first. */
  readonly items: ReadonlyArray<MatterThreadItem>;
  readonly projects: ReadonlyArray<MatterSidebarProject>;
  readonly projectFilter: string | null;
  readonly open: boolean;
  readonly activeThreadKey: string | null;
}) {
  const scopes = settledScopes(input.projects, input.projectFilter);
  const scopeKey = JSON.stringify(scopes);
  const [tail, setTail] = useState({ scopeKey, count: FIRST_ROWS });
  if (tail.scopeKey !== scopeKey) setTail({ scopeKey, count: FIRST_ROWS });
  const visibleCount = tail.scopeKey === scopeKey ? tail.count : FIRST_ROWS;
  const shelf = useOlderSettledShelf({ scopes, expanded: input.open, visibleCount });

  const threads = useQuietThreadShells();
  const shellByKey = new Map<string, EnvironmentThreadShell>();
  for (const thread of threads) {
    if (thread.settledOverride !== "settled") continue;
    shellByKey.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
  }
  // A loaded page can hold rows that sort below threads another environment has not sent yet.
  const listed = input.items.filter((item) => {
    const shell = shellByKey.get(item.key);
    return shell === undefined || shelf.isListed(shell);
  });
  useOlderSettledShelfGrowth(
    shelf,
    listed.flatMap((item) => shellByKey.get(item.key) ?? []),
  );

  const shown = listed.slice(0, visibleCount);
  const active = listed.find((item) => item.key === input.activeThreadKey);
  if (active !== undefined && !shown.includes(active)) shown.push(active);
  const total =
    input.items.length +
    shelf.unloadedCount(threads.filter((thread) => isListedThreadLineage(thread.lineage)));
  return {
    rows: shown,
    total,
    hiddenCount: Math.max(0, total - shown.length),
    /** How many rows the next Show more adds. */
    nextCount: Math.min(Math.max(0, total - shown.length), MORE_ROWS),
    loading: shelf.loading,
    failed: shelf.failed,
    showMore: () => {
      if (shelf.loading) return;
      shelf.retry();
      setTail({ scopeKey, count: visibleCount + MORE_ROWS });
    },
  };
}
