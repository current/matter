import { NodeId, ThreadId, type OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  canStopMattrSubagent,
  closeMattrLineagePopover,
  countMattrPreviousAgents,
  deriveMattrWhisperRows,
  isMattrWhisperActive,
  mattrRibbonOverflows,
  oldestMattrWhisperStart,
  openMattrLineagePopover,
  readMattrLineagePopover,
  resolveMattrRibbonDensity,
  setMattrLineageView,
  stackMattrWhisperAvatars,
  toggleMattrLineagePopover,
} from "./mattrThreadRibbon.logic";

const PARENT = ThreadId.make("parent");

function subagent(
  id: string,
  overrides: Partial<Parameters<typeof canStopMattrSubagent>[0]> = {},
): Parameters<typeof canStopMattrSubagent>[0] {
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

describe("deriveMattrWhisperRows", () => {
  it("lists active subagents newest first and leaves finished ones out", () => {
    const rows = deriveMattrWhisperRows({
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
    const rows = deriveMattrWhisperRows({
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
    const rows = deriveMattrWhisperRows({
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
    expect(canStopMattrSubagent(subagent("app"))).toBe(true);
    expect(canStopMattrSubagent(subagent("unstarted", { startedAt: null }))).toBe(false);
    expect(
      canStopMattrSubagent(subagent("native", { origin: "provider_native", runId: null })),
    ).toBe(false);
    expect(
      canStopMattrSubagent(
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
  const rows = deriveMattrWhisperRows({
    subagents: ["a", "b", "c", "d"].map((id, index) =>
      subagent(id, { startedAt: DateTime.makeUnsafe(`2026-11-26T1${index}:00:00.000Z`) }),
    ),
    backgroundTasks: [],
    fallbackTitle: "Subagent",
  });

  it("times the pill from the oldest start", () => {
    expect(oldestMattrWhisperStart(rows)).toBe(Date.parse("2026-11-26T10:00:00.000Z"));
    expect(oldestMattrWhisperStart([])).toBeNull();
  });

  it("stacks at most three avatars, earlier ones drawn on top", () => {
    const avatars = stackMattrWhisperAvatars(rows);
    expect(avatars.map(({ zIndex }) => zIndex)).toEqual([3, 2, 1]);
  });

  it("is idle with nothing running", () => {
    expect(isMattrWhisperActive({ rowCount: 0, serverCount: 0, runningAutomationCount: 0 })).toBe(
      false,
    );
    expect(isMattrWhisperActive({ rowCount: 0, serverCount: 1, runningAutomationCount: 0 })).toBe(
      true,
    );
  });

  it("counts finished agents as previous", () => {
    expect(
      countMattrPreviousAgents([
        { status: "completed" },
        { status: "failed" },
        { status: "running" },
        { status: "interrupted" },
      ]),
    ).toBe(3);
  });
});

describe("ribbon density", () => {
  it("collapses chips as the available header content width narrows", () => {
    expect(resolveMattrRibbonDensity(820)).toBe("full");
    expect(resolveMattrRibbonDensity(819)).toBe("compact");
    expect(resolveMattrRibbonDensity(660)).toBe("compact");
    expect(resolveMattrRibbonDensity(659)).toBe("condensed");
    expect(resolveMattrRibbonDensity(480)).toBe("condensed");
    expect(resolveMattrRibbonDensity(479)).toBe("minimal");
  });

  it("moves secondary chips into More before the diff", () => {
    expect(mattrRibbonOverflows("compact", "openIn")).toBe(false);
    expect(mattrRibbonOverflows("condensed", "openIn")).toBe(true);
    expect(mattrRibbonOverflows("condensed", "diff")).toBe(false);
    expect(mattrRibbonOverflows("minimal", "diff")).toBe(true);
  });
});

describe("lineage popover store", () => {
  it("toggles per thread and anchors to the pill only while it shows", () => {
    toggleMattrLineagePopover("env:thread", false);
    expect(readMattrLineagePopover()).toMatchObject({ threadKey: "env:thread", anchor: "ribbon" });
    setMattrLineageView("previous");
    expect(readMattrLineagePopover().view).toBe("previous");
    toggleMattrLineagePopover("env:thread", true);
    expect(readMattrLineagePopover().threadKey).toBeNull();
    openMattrLineagePopover("env:thread", "pill");
    expect(readMattrLineagePopover()).toMatchObject({ anchor: "pill", view: "main" });
    closeMattrLineagePopover();
    expect(readMattrLineagePopover().threadKey).toBeNull();
  });
});
