import {
  MessageId,
  type ClaudeCloudRemoteSession,
  type ClaudeCloudSessionState,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import type { ChatMessage } from "../../types";

export type CloudTranscriptRow = OrchestrationV2ProjectedTurnItem;

const toRow = (item: OrchestrationV2TurnItem, position: number): CloudTranscriptRow => ({
  position,
  visibility: "local",
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
});

/**
 * Applies one transcript response. A full response replaces everything; a delta upserts by item
 * id, so unchanged rows keep their identity and the timeline re-derives only what moved.
 */
export function mergeCloudTranscriptRows(
  current: ReadonlyArray<CloudTranscriptRow> | null,
  response: { readonly full: boolean; readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem> },
): ReadonlyArray<CloudTranscriptRow> {
  if (current === null || response.full) return response.turnItems.map(toRow);
  if (response.turnItems.length === 0) return current;
  const updates = new Map(response.turnItems.map((item) => [item.id, item] as const));
  const next = current.map((row) => {
    const update = updates.get(row.item.id);
    if (update === undefined) return row;
    updates.delete(row.item.id);
    return update === row.item ? row : { ...row, item: update };
  });
  for (const item of updates.values()) next.push(toRow(item, next.length));
  return next;
}

/** A message sent from Matter that the transcript has not shown yet. */
export interface CloudEcho {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  /** User messages already in the transcript when it was sent; none of them can be its echo. */
  readonly knownUserItemIds: ReadonlySet<string>;
}

const normalize = (text: string) => text.trim().replaceAll(/\s+/g, " ");

export function userItemIds(rows: ReadonlyArray<CloudTranscriptRow>): ReadonlySet<string> {
  return new Set(rows.flatMap((row) => (row.item.type === "user_message" ? [row.item.id] : [])));
}

/** Echoes still waiting: each new user message with the same text settles at most one echo. */
export function pendingCloudEchoes(
  echoes: ReadonlyArray<CloudEcho>,
  rows: ReadonlyArray<CloudTranscriptRow>,
): ReadonlyArray<CloudEcho> {
  if (echoes.length === 0) return echoes;
  const claimed = new Set<string>();
  return echoes.filter((echo) => {
    const text = normalize(echo.text);
    const match = rows.find(
      ({ item }) =>
        item.type === "user_message" &&
        !claimed.has(item.id) &&
        !echo.knownUserItemIds.has(item.id) &&
        normalize(item.text) === text,
    );
    if (match === undefined) return true;
    claimed.add(match.item.id);
    return false;
  });
}

export function cloudEchoMessage(echo: CloudEcho): ChatMessage {
  return {
    id: MessageId.make(`claude-cloud-echo-${echo.id}`),
    role: "user",
    text: echo.text,
    runId: null,
    streaming: false,
    createdAt: echo.createdAt,
    updatedAt: echo.createdAt,
  };
}

export const CLOUD_ACTIVE_POLL_MS = 1_500;
export const CLOUD_IDLE_POLL_MS = 10_000;

export function isCloudSessionActive(state: ClaudeCloudSessionState | null | undefined): boolean {
  return state === "running" || state === "needs_input";
}

/** How long to wait before the next transcript read. `boosted` covers the gap after a send. */
export function cloudTranscriptPollDelay(
  session: Pick<ClaudeCloudRemoteSession, "state"> | null,
  boosted: boolean,
): number {
  return boosted || isCloudSessionActive(session?.state)
    ? CLOUD_ACTIVE_POLL_MS
    : CLOUD_IDLE_POLL_MS;
}

/** `owner/repo · branch`, or whichever half is known. */
export function cloudSessionSource(
  session: Pick<ClaudeCloudRemoteSession, "repository" | "branch">,
): string | null {
  const parts = [session.repository, session.branch].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Needs you first, then running, then newest activity. Archived sessions drop out. */
export function rankCloudSessions(
  sessions: ReadonlyArray<ClaudeCloudRemoteSession>,
): ReadonlyArray<ClaudeCloudRemoteSession> {
  const rank = (session: ClaudeCloudRemoteSession) =>
    session.state === "needs_input" ? 0 : session.state === "running" ? 1 : 2;
  return sessions
    .filter((session) => session.state !== "archived")
    .toSorted(
      (left, right) => rank(left) - rank(right) || right.updatedAt.localeCompare(left.updatedAt),
    );
}
