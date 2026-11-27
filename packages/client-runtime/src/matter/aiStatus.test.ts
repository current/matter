import { describe, expect, it } from "vite-plus/test";

import type { WorkLogPresentationEntry } from "../work-log/presentation.ts";
import {
  deriveMatterAiStatusPhaseFrom,
  MATTER_AI_STATUS_PHASE_ICONS,
  matterAiStatusToolPhase,
  type MatterAiStatusRow,
} from "./aiStatus.ts";

const idle = { awaitingUser: false, compacting: false, preparingWorktree: false };
const working: MatterAiStatusRow = { kind: "working", compacting: false };

function entry(fields: Partial<WorkLogPresentationEntry>): WorkLogPresentationEntry {
  return {
    id: "tool",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Tool",
    tone: "tool",
    ...fields,
  };
}

const derive = (rows: ReadonlyArray<MatterAiStatusRow>, activity = idle) =>
  deriveMatterAiStatusPhaseFrom(rows, (row: MatterAiStatusRow) => row, activity);

describe("deriveMatterAiStatusPhaseFrom", () => {
  it("thinks until the turn does something", () => {
    expect(derive([])).toBe("thinking");
    expect(derive([working])).toBe("thinking");
    expect(derive([working, null, { kind: "thinking", delegating: false }])).toBe("thinking");
  });

  it("names the newest running tool", () => {
    const rows: MatterAiStatusRow[] = [
      working,
      { kind: "tool", entry: entry({ itemType: "file_change", changedFiles: ["a.ts"] }) },
      { kind: "tool", entry: entry({ itemType: "command_execution", command: "ls" }) },
    ];
    expect(derive(rows)).toBe("running");
  });

  it("stops at the working indicator and ignores rows that say nothing", () => {
    const rows: MatterAiStatusRow[] = [{ kind: "streaming-reply" }, working, null];
    expect(derive(rows)).toBe("thinking");
    expect(derive([{ kind: "working", compacting: true }])).toBe("compacting");
  });

  it("writes while the reply streams and delegates under a subagent's label", () => {
    expect(derive([working, { kind: "streaming-reply" }])).toBe("writing");
    expect(derive([working, { kind: "thinking", delegating: true }])).toBe("delegating");
    expect(derive([working, { kind: "compacting" }])).toBe("compacting");
    expect(derive([working, { kind: "tool-group", summaryKind: "edit" }])).toBe("editing");
  });

  it("puts waiting on the user, setup and compaction ahead of the rows", () => {
    const rows: MatterAiStatusRow[] = [working, { kind: "streaming-reply" }];
    expect(derive(rows, { ...idle, awaitingUser: true })).toBe("input");
    expect(derive(rows, { ...idle, preparingWorktree: true })).toBe("setup");
    expect(derive(rows, { ...idle, compacting: true })).toBe("compacting");
  });
});

describe("matterAiStatusToolPhase", () => {
  it("maps tool actions to phases", () => {
    expect(matterAiStatusToolPhase(entry({ itemType: "reasoning", tone: "thinking" }))).toBe(
      "thinking",
    );
    expect(matterAiStatusToolPhase(entry({ itemType: "web_search", label: "Web search" }))).toBe(
      "searching",
    );
    expect(matterAiStatusToolPhase(entry({ requestKind: "file-read" }))).toBe("reading");
  });

  it("marks only waiting on the user as not live", () => {
    const quiet = (
      Object.keys(MATTER_AI_STATUS_PHASE_ICONS) as Array<keyof typeof MATTER_AI_STATUS_PHASE_ICONS>
    ).filter((phase) => !MATTER_AI_STATUS_PHASE_ICONS[phase].active);
    expect(quiet).toEqual(["input"]);
  });
});
