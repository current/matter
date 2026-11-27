import { NodeId, ThreadId, type OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  countMatterPreviousAgents,
  deriveMatterWhisperRows,
  deriveMatterWhisperSegments,
  type MatterWhisperSubagent,
} from "./whisper.ts";

const PARENT = ThreadId.make("parent");

function subagent(
  id: string,
  overrides: Partial<MatterWhisperSubagent> = {},
): MatterWhisperSubagent {
  return {
    id: NodeId.make(id),
    threadId: PARENT,
    runId: null,
    origin: "app_owned",
    driver: "claudeAgent" as never,
    providerInstanceId: "claudeAgent" as never,
    childThreadId: ThreadId.make(`child-${id}`),
    remoteChild: null,
    nativeTaskRef: null,
    title: `Agent ${id}`,
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-11-26T10:00:00.000Z"),
    ...overrides,
  } as MatterWhisperSubagent;
}

function command(taskId: string): OrchestrationV2PendingBackgroundTask {
  return { taskId, kind: "command", description: "vp run dev\n--port 5173" } as never;
}

describe("deriveMatterWhisperSegments", () => {
  it("is empty, hiding the pill, while nothing runs", () => {
    const rows = deriveMatterWhisperRows({
      subagents: [subagent("done", { status: "completed" })],
      backgroundTasks: [],
      fallbackTitle: "Subagent",
    });
    expect(
      deriveMatterWhisperSegments({ rows, serverCount: 0, runningAutomationCount: 0 }).segments,
    ).toEqual([]);
  });

  it("splits running agents from background commands, then servers and automations", () => {
    const rows = deriveMatterWhisperRows({
      subagents: [subagent("a"), subagent("b", { status: "completed" })],
      backgroundTasks: [command("dev")],
      fallbackTitle: "Subagent",
    });
    const summary = deriveMatterWhisperSegments({
      rows,
      serverCount: 2,
      runningAutomationCount: 1,
    });
    expect(summary.segments).toEqual(["agents", "commands", "servers", "automations"]);
    expect(summary.agents.map((row) => row.key)).toEqual(["subagent:a"]);
    expect(summary.commands.map((row) => row.title)).toEqual(["vp run dev"]);
  });

  it("shows a server alone once its command has finished", () => {
    expect(
      deriveMatterWhisperSegments({ rows: [], serverCount: 1, runningAutomationCount: 0 }).segments,
    ).toEqual(["servers"]);
  });

  it("counts finished agents for the header's Agents row", () => {
    expect(
      countMatterPreviousAgents([
        subagent("a", { status: "completed" }),
        subagent("b", { status: "failed" }),
        subagent("c"),
      ]),
    ).toBe(2);
  });
});
