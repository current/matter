import { describe, expect, it } from "vite-plus/test";

import type { TimelineRow } from "./components/chat/timelineRowContext";
import type { WorkLogEntry } from "./session-logic";
import { deriveMattrAiStatusPhase, MATTR_AI_STATUS_PHASES } from "./mattrAiStatus";

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

describe("deriveMattrAiStatusPhase", () => {
  it("thinks until the turn does something", () => {
    expect(deriveMattrAiStatusPhase([working], idle)).toBe("thinking");
    expect(deriveMattrAiStatusPhase([], idle)).toBe("thinking");
    expect(
      deriveMattrAiStatusPhase([working, { kind: "thinking", id: "t", createdAt: null }], idle),
    ).toBe("thinking");
  });

  it("names the running tool", () => {
    const phase = (entry: Partial<WorkLogEntry>) =>
      deriveMattrAiStatusPhase([working, tool(entry)], idle);
    expect(phase({ itemType: "command_execution", command: "ls" })).toBe("running");
    expect(phase({ itemType: "file_change", changedFiles: ["a.ts"] })).toBe("editing");
    expect(phase({ itemType: "web_search", label: "Web search" })).toBe("searching");
    expect(phase({ requestKind: "file-read" })).toBe("reading");
    expect(phase({ itemType: "reasoning", tone: "thinking" })).toBe("thinking");
  });

  it("ignores finished tool groups", () => {
    expect(
      deriveMattrAiStatusPhase([working, tool({ itemType: "command_execution" }, false)], idle),
    ).toBe("thinking");
  });

  it("writes while the reply streams, after earlier tools", () => {
    const rows = [working, tool({ itemType: "command_execution" }, false), assistant(true)];
    expect(deriveMattrAiStatusPhase(rows, idle)).toBe("writing");
    expect(deriveMattrAiStatusPhase([working, assistant(false)], idle)).toBe("thinking");
  });

  it("puts waiting on the user, setup and compaction ahead of the rows", () => {
    const rows = [working, assistant(true)];
    expect(deriveMattrAiStatusPhase(rows, { ...idle, awaitingUser: true })).toBe("input");
    expect(deriveMattrAiStatusPhase(rows, { ...idle, preparingWorktree: true })).toBe("setup");
    expect(deriveMattrAiStatusPhase(rows, { ...idle, compacting: true })).toBe("compacting");
    expect(deriveMattrAiStatusPhase([{ ...working, compacting: true }], idle)).toBe("compacting");
  });

  it("waits for subagents as delegating", () => {
    const rows: TimelineRow[] = [
      working,
      { kind: "thinking", id: "t", createdAt: null, label: "Waiting on 2 subagents" },
    ];
    expect(deriveMattrAiStatusPhase(rows, idle)).toBe("delegating");
  });

  it("only animates phases where the agent is busy", () => {
    expect(MATTR_AI_STATUS_PHASES.input.active).toBe(false);
    expect(
      Object.entries(MATTR_AI_STATUS_PHASES)
        .filter(([phase]) => phase !== "input")
        .every(([, config]) => config.active),
    ).toBe(true);
  });
});
