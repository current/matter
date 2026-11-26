import { describe, expect, it } from "vite-plus/test";

import type { TimelineRow } from "./components/chat/timelineRowContext";
import type { WorkLogEntry } from "./session-logic";
import { deriveMatterAiStatusPhase, MATTER_AI_STATUS_PHASES } from "./matterAiStatus";

const idle = { awaitingUser: false, compacting: false, preparingWorktree: false };
const working: TimelineRow = { kind: "working", id: "working-indicator-row", createdAt: null };

function tool(entry: Partial<WorkLogEntry>, active = true): TimelineRow {
  const full: WorkLogEntry = {
    id: "tool",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Tool",
    tone: "tool",
    ...entry,
  };
  return {
    kind: "work-live",
    id: "work-live:tool",
    createdAt: full.createdAt,
    entry: full,
    groupedEntries: [full],
    groupId: "group",
    expanded: false,
    active,
  };
}

function assistant(streaming: boolean): TimelineRow {
  return {
    kind: "message",
    id: "assistant",
    createdAt: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", streaming } as never,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  };
}

describe("deriveMatterAiStatusPhase", () => {
  it("thinks until the turn does something", () => {
    expect(deriveMatterAiStatusPhase([working], idle)).toBe("thinking");
    expect(deriveMatterAiStatusPhase([], idle)).toBe("thinking");
    expect(
      deriveMatterAiStatusPhase([working, { kind: "thinking", id: "t", createdAt: null }], idle),
    ).toBe("thinking");
  });

  it("names the running tool", () => {
    const phase = (entry: Partial<WorkLogEntry>) =>
      deriveMatterAiStatusPhase([working, tool(entry)], idle);
    expect(phase({ itemType: "command_execution", command: "ls" })).toBe("running");
    expect(phase({ itemType: "file_change", changedFiles: ["a.ts"] })).toBe("editing");
    expect(phase({ itemType: "web_search", label: "Web search" })).toBe("searching");
    expect(phase({ requestKind: "file-read" })).toBe("reading");
    expect(phase({ itemType: "reasoning", tone: "thinking" })).toBe("thinking");
  });

  it("ignores finished tool groups", () => {
    expect(
      deriveMatterAiStatusPhase([working, tool({ itemType: "command_execution" }, false)], idle),
    ).toBe("thinking");
  });

  it("writes while the reply streams, after earlier tools", () => {
    const rows = [working, tool({ itemType: "command_execution" }, false), assistant(true)];
    expect(deriveMatterAiStatusPhase(rows, idle)).toBe("writing");
    expect(deriveMatterAiStatusPhase([working, assistant(false)], idle)).toBe("thinking");
  });

  it("puts waiting on the user, setup and compaction ahead of the rows", () => {
    const rows = [working, assistant(true)];
    expect(deriveMatterAiStatusPhase(rows, { ...idle, awaitingUser: true })).toBe("input");
    expect(deriveMatterAiStatusPhase(rows, { ...idle, preparingWorktree: true })).toBe("setup");
    expect(deriveMatterAiStatusPhase(rows, { ...idle, compacting: true })).toBe("compacting");
    expect(deriveMatterAiStatusPhase([{ ...working, compacting: true }], idle)).toBe("compacting");
  });

  it("waits for subagents as delegating", () => {
    const rows: TimelineRow[] = [
      working,
      { kind: "thinking", id: "t", createdAt: null, label: "Waiting on 2 subagents" },
    ];
    expect(deriveMatterAiStatusPhase(rows, idle)).toBe("delegating");
  });

  it("only animates phases where the agent is busy", () => {
    expect(MATTER_AI_STATUS_PHASES.input.active).toBe(false);
    expect(
      Object.entries(MATTER_AI_STATUS_PHASES)
        .filter(([phase]) => phase !== "input")
        .every(([, config]) => config.active),
    ).toBe(true);
  });
});
