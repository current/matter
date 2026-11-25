import { PlanId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "../test-fixtures";
import { describeToolItem, summarizeThreadProjection } from "./islandThreadActivity";

function projectionWith(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
  };
}

describe("describeToolItem", () => {
  const { base, runId } = makeStreamingTimelineFixture();

  it("prefers the provider title and classifies read tools", () => {
    expect(
      describeToolItem({
        ...base("read", runId, 1),
        type: "dynamic_tool",
        toolName: "read_file",
        title: "Read ship-local.mjs",
        input: {},
      }),
    ).toEqual({ kind: "read", label: "Read ship-local.mjs", running: false });
  });

  it("falls back to the first command line and a file basename", () => {
    expect(
      describeToolItem({
        ...base("cmd", runId, 2),
        type: "command_execution",
        status: "running",
        input: "vp test run\n--watch",
      }),
    ).toEqual({ kind: "command", label: "vp test run", running: true });
    expect(
      describeToolItem({
        ...base("edit", runId, 3),
        type: "file_change",
        fileName: "/repo/src/a.ts",
      }),
    ).toEqual({ kind: "edit", label: "a.ts", running: false });
  });

  it("ignores non-tool items", () => {
    expect(
      describeToolItem({
        ...base("think", runId, 4),
        type: "reasoning",
        text: "",
        streaming: false,
      }),
    ).toBeNull();
  });
});

describe("summarizeThreadProjection", () => {
  const { base, runId } = makeStreamingTimelineFixture();

  it("splits the running tool from the newest three finished ones and reads plan progress", () => {
    const finished = ["one.ts", "two.ts", "three.ts", "four.ts"].map(
      (fileName, i): OrchestrationV2TurnItem => ({
        ...base(`edit-${i}`, runId, i),
        type: "file_change",
        fileName,
      }),
    );
    const summary = summarizeThreadProjection(
      projectionWith([
        ...finished,
        {
          ...base("plan", runId, 10),
          type: "todo_list",
          planId: PlanId.make("plan"),
          steps: [
            { id: "a", text: "Springs", status: "completed" },
            { id: "b", text: "Carousel", status: "running" },
            { id: "c", text: "Tests", status: "pending" },
          ],
        },
        {
          ...base("run-tests", runId, 11),
          type: "command_execution",
          status: "running",
          input: "vp test run",
        },
      ]),
    );

    expect(summary.toolCallCount).toBe(5);
    expect(summary.currentActivity).toEqual({
      kind: "command",
      label: "vp test run",
      running: true,
    });
    expect(summary.recentActivities.map((a) => a.label)).toEqual(["four.ts", "three.ts", "two.ts"]);
    expect(summary.plan).toEqual({ completed: 1, total: 3, currentStep: "Carousel" });
  });

  it("returns an empty preview without a projection", () => {
    const summary = summarizeThreadProjection(null);
    expect(summary.currentActivity).toBeNull();
    expect(summary.recentActivities).toEqual([]);
    expect(summary.plan).toBeNull();
  });
});
