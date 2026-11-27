import { NodeId, ThreadId, type OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  canStopMatterSubagent,
  closeMatterLineagePopover,
  countMatterPreviousAgents,
  deriveMatterWhisperRows,
  isMatterWhisperActive,
  matterRibbonOverflows,
  oldestMatterWhisperStart,
  openMatterLineagePopover,
  readMatterLineagePopover,
  resolveMatterRibbonDensity,
  setMatterLineageView,
  stackMatterWhisperAvatars,
  uniqueMatterWhisperAgents,
  toggleMatterLineagePopover,
} from "./matterThreadRibbon.logic";

const PARENT = ThreadId.make("parent");

function subagent(
  id: string,
  overrides: Partial<Parameters<typeof canStopMatterSubagent>[0]> = {},
): Parameters<typeof canStopMatterSubagent>[0] {
  return {
    id: NodeId.make(id),
    threadId: PARENT,
    runId: null,
    origin: "app_owned",
    driver: "claudeAgent" as never,
    providerInstanceId: "claudeAgent" as never,
    childThreadId: ThreadId.make(`child-${id}`),
    nativeTaskRef: null,
    title: `Agent ${id}`,
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-11-26T10:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveMatterWhisperRows", () => {
  it("lists active subagents newest first and leaves finished ones out", () => {
    const rows = deriveMatterWhisperRows({
      subagents: [
        subagent("old", { startedAt: DateTime.makeUnsafe("2026-11-26T09:00:00.000Z") }),
        subagent("new", { startedAt: DateTime.makeUnsafe("2026-11-26T10:30:00.000Z") }),
        subagent("done", { status: "completed" }),
        subagent("waiting", { status: "waiting" }),
      ],
      backgroundTasks: [],
      fallbackTitle: "Subagent",
    });
    expect(rows.map((row) => row.key)).toEqual([
      "subagent:new",
      "subagent:waiting",
      "subagent:old",
    ]);
  });

  it("adds background commands and skips a task its subagent row already shows", () => {
    const tasks: OrchestrationV2PendingBackgroundTask[] = [
      { taskId: "t1", kind: "subagent", childThreadId: ThreadId.make("child-a") } as never,
      { taskId: "t2", kind: "command", description: "vp run dev\n--port 5173" } as never,
    ];
    const rows = deriveMatterWhisperRows({
      subagents: [subagent("a")],
      backgroundTasks: tasks,
      fallbackTitle: "Subagent",
    });
    expect(rows.map((row) => [row.kind, row.title])).toEqual([
      ["subagent", "Agent a"],
      ["command", "vp run dev"],
    ]);
  });

  it("deduplicates provider-native subagents with null childThreadId by nativeId or taskId", () => {
    const tasks: OrchestrationV2PendingBackgroundTask[] = [
      {
        taskId: "bg-1",
        nativeItemId: "toolu_native_a",
        kind: "subagent",
        description: "Duplicate by nativeItemId",
      } as never,
      {
        taskId: "toolu_native_b",
        kind: "subagent",
        description: "Duplicate by taskId",
      } as never,
      {
        taskId: "bg-other",
        kind: "subagent",
        description: "Distinct background subagent",
      } as never,
    ];
    const rows = deriveMatterWhisperRows({
      subagents: [
        subagent("native-a", {
          origin: "provider_native",
          childThreadId: null,
          nativeTaskRef: { strength: "strong", nativeId: "toolu_native_a" } as never,
        }),
        subagent("native-b", {
          origin: "provider_native",
          childThreadId: null,
          nativeTaskRef: { strength: "strong", nativeId: "toolu_native_b" } as never,
        }),
      ],
      backgroundTasks: tasks,
      fallbackTitle: "Subagent",
    });
    expect(rows.map((row) => [row.key, row.title])).toEqual([
      ["subagent:native-a", "Agent native-a"],
      ["subagent:native-b", "Agent native-b"],
      ["task:bg-other", "Distinct background subagent"],
    ]);
  });

  it("stops only agents the lineage panel could stop", () => {
    expect(canStopMatterSubagent(subagent("app"))).toBe(true);
    expect(canStopMatterSubagent(subagent("unstarted", { startedAt: null }))).toBe(false);
    expect(
      canStopMatterSubagent(subagent("native", { origin: "provider_native", runId: null })),
    ).toBe(false);
    expect(
      canStopMatterSubagent(
        subagent("strong", {
          origin: "provider_native",
          runId: "run" as never,
          nativeTaskRef: { strength: "strong", nativeId: "task" } as never,
        }),
      ),
    ).toBe(true);
  });
});

describe("pill summary", () => {
  const rows = deriveMatterWhisperRows({
    subagents: ["a", "b", "c", "d"].map((id, index) =>
      subagent(id, { startedAt: DateTime.makeUnsafe(`2026-11-26T1${index}:00:00.000Z`) }),
    ),
    backgroundTasks: [],
    fallbackTitle: "Subagent",
  });

  it("times the pill from the oldest start", () => {
    expect(oldestMatterWhisperStart(rows)).toBe(Date.parse("2026-11-26T10:00:00.000Z"));
    expect(oldestMatterWhisperStart([])).toBeNull();
  });

  it("stacks at most three avatars, earlier ones drawn on top", () => {
    const avatars = stackMatterWhisperAvatars(rows);
    expect(avatars.map(({ zIndex }) => zIndex)).toEqual([3, 2, 1]);
  });

  it("keeps the first row of each agent for the avatars", () => {
    const agents = ["claude", "codex", "claude", "command"];
    const unique = uniqueMatterWhisperAgents(rows, (row) => agents[rows.indexOf(row)]!);
    expect(unique).toEqual([rows[0], rows[1], rows[3]]);
  });

  it("is idle with nothing running", () => {
    expect(isMatterWhisperActive({ rowCount: 0, serverCount: 0, runningAutomationCount: 0 })).toBe(
      false,
    );
    expect(isMatterWhisperActive({ rowCount: 0, serverCount: 1, runningAutomationCount: 0 })).toBe(
      true,
    );
  });

  it("counts finished agents as previous", () => {
    expect(
      countMatterPreviousAgents([
        { status: "completed" },
        { status: "failed" },
        { status: "running" },
        { status: "interrupted" },
      ]),
    ).toBe(3);
  });
});

describe("ribbon density", () => {
  it("collapses primary chips as the available header content width narrows", () => {
    expect(resolveMatterRibbonDensity(560)).toBe("full");
    expect(resolveMatterRibbonDensity(559)).toBe("condensed");
    expect(resolveMatterRibbonDensity(420)).toBe("condensed");
    expect(resolveMatterRibbonDensity(419)).toBe("minimal");
  });

  it("moves PR into More before the diff", () => {
    expect(matterRibbonOverflows("full", "pr")).toBe(false);
    expect(matterRibbonOverflows("full", "diff")).toBe(false);
    expect(matterRibbonOverflows("condensed", "pr")).toBe(true);
    expect(matterRibbonOverflows("condensed", "diff")).toBe(false);
    expect(matterRibbonOverflows("minimal", "pr")).toBe(true);
    expect(matterRibbonOverflows("minimal", "diff")).toBe(true);
  });
});

describe("lineage popover store", () => {
  it("toggles per thread and anchors to the pill only while it shows", () => {
    toggleMatterLineagePopover("env:thread", false);
    expect(readMatterLineagePopover()).toMatchObject({ threadKey: "env:thread", anchor: "ribbon" });
    setMatterLineageView("previous");
    expect(readMatterLineagePopover().view).toBe("previous");
    toggleMatterLineagePopover("env:thread", true);
    expect(readMatterLineagePopover().threadKey).toBeNull();
    openMatterLineagePopover("env:thread", "pill");
    expect(readMatterLineagePopover()).toMatchObject({ anchor: "pill", view: "main" });
    closeMatterLineagePopover();
    expect(readMatterLineagePopover().threadKey).toBeNull();
  });
});
