import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedRow } from "../../threads/pending-thread-feed";
import { IDLE_MATTER_AI_STATUS, matterAiStatusFeed } from "./matterAiStatus";

const createdAt = "2026-01-01T00:00:00.000Z";
const row = (fields: Record<string, unknown>) =>
  ({ createdAt, runId: null, ...fields }) as ThreadFeedRow;

const user = row({ type: "message", id: "user", message: { role: "user", streaming: false } });
const working = row({ type: "run-fold", id: "fold", workingSince: createdAt, expanded: false });
const finishedFold = row({ type: "run-fold", id: "old-fold", expanded: false });
const thinking = row({ type: "thinking", id: "thinking" });
const delegating = row({ type: "thinking", id: "thinking", label: "Agent A is working" });
const streaming = row({
  type: "message",
  id: "reply",
  message: { role: "assistant", streaming: true },
});
const liveCommand = row({
  type: "activity-group",
  id: "tools",
  activities: [
    {
      live: true,
      workEntry: { id: "cmd", createdAt, label: "ls", tone: "tool", itemType: "command_execution" },
      projectedItem: { item: { type: "command_execution", status: "running" } },
    },
  ],
});
const collapsedEdit = row({
  type: "work-toggle",
  id: "toggle",
  live: true,
  expanded: false,
  summaryKind: "edit",
});

const idle = { preparingWorktree: false };

describe("matterAiStatusFeed", () => {
  it("is idle without a working turn", () => {
    const rows = [user, finishedFold];
    expect(matterAiStatusFeed(rows, idle)).toEqual({ rows, status: IDLE_MATTER_AI_STATUS });
  });

  it("drops the plain thinking row under the Working row, which shows the status", () => {
    const result = matterAiStatusFeed([user, working, thinking], idle);
    expect(result.rows).toEqual([user, working]);
    expect(result.status).toEqual({ phase: "thinking", workingRowShowsStatus: true });
  });

  it("lets a lower or labeled thinking row own the status", () => {
    const lower = matterAiStatusFeed([user, working, liveCommand, thinking], idle);
    expect(lower.rows).toHaveLength(4);
    expect(lower.status.workingRowShowsStatus).toBe(false);
    const labeled = matterAiStatusFeed([user, working, delegating], idle);
    expect(labeled.rows).toHaveLength(3);
    expect(labeled.status).toEqual({ phase: "delegating", workingRowShowsStatus: false });
  });

  it("names running tools, collapsed groups and a streaming reply", () => {
    expect(matterAiStatusFeed([working, liveCommand], idle).status).toEqual({
      phase: "running",
      workingRowShowsStatus: true,
    });
    expect(matterAiStatusFeed([working, collapsedEdit], idle).status.phase).toBe("editing");
    expect(matterAiStatusFeed([working, liveCommand, streaming], idle).status.phase).toBe(
      "writing",
    );
  });

  it("shows worktree setup ahead of the rows", () => {
    const result = matterAiStatusFeed([working, thinking], { preparingWorktree: true });
    expect(result.status).toEqual({ phase: "setup", workingRowShowsStatus: true });
    expect(result.rows).toHaveLength(2);
  });
});
