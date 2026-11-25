import type { OrchestrationV2NativeChildStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildNativeChildActivityItems, cleanNativeStepText } from "./nativeChildWork.logic";

describe("cleanNativeStepText", () => {
  it("strips duplicated Created At / Completed At headers", () => {
    const raw = [
      "Created At: 2026-11-25T11:42:09-06:00",
      "Completed At: 2026-11-25T11:42:25-06:00",
      "Created At: 2026-11-25T11:42:09-06:00",
      "Completed At: 2026-11-25T11:42:25-06:00",
      "Made 1 replacement in /repo/src/index.ts",
    ].join("\n");
    expect(cleanNativeStepText(raw)).toBe("Made 1 replacement in /repo/src/index.ts");
  });
});

describe("buildNativeChildActivityItems", () => {
  it("skips step 0 launch system envelopes and efficiency reminders", () => {
    const steps: ReadonlyArray<OrchestrationV2NativeChildStep> = [
      {
        index: 0,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        text: "The following is a <SYSTEM_MESSAGE>\nInitial task prompt",
        toolCalls: [],
      },
      {
        index: 5,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        text: "The following is a <SYSTEM_MESSAGE>\nReminder: work efficiently. Batch calls.",
        toolCalls: [],
      },
      {
        index: 6,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        text: "Found the root cause and applied the fix.",
        toolCalls: [],
      },
    ];

    expect(buildNativeChildActivityItems(steps)).toEqual([
      {
        kind: "message",
        id: "step:6:message",
        stepIndex: 6,
        text: "Found the root cause and applied the fix.",
      },
    ]);
  });

  it("pairs PLANNER_RESPONSE tool calls 1:1 with following GENERIC results", () => {
    const steps: ReadonlyArray<OrchestrationV2NativeChildStep> = [
      {
        index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        text: null,
        toolCalls: [
          {
            name: "read_file",
            input: JSON.stringify({
              Path: "/Users/dev/repo/apps/web/src/ChatView.tsx",
              StartLine: 10,
              EndLine: 40,
            }),
          },
          {
            name: "run_command",
            input: JSON.stringify({
              CommandLine: "vp test run foo.test.ts",
              toolSummary: "Run unit tests",
            }),
          },
        ],
      },
      {
        index: 2,
        type: "GENERIC",
        status: "DONE",
        text: "Created At: 2026-11-25T11:34:20-06:00\nCompleted At: 2026-11-25T11:34:21-06:00\nShowing lines 10-40",
        toolCalls: [],
      },
      {
        index: 3,
        type: "GENERIC",
        status: "RUNNING",
        text: "Created At: 2026-11-25T11:34:22-06:00\nTool is running as a background task",
        toolCalls: [],
      },
    ];

    const items = buildNativeChildActivityItems(steps, { workspaceRoot: "/Users/dev/repo" });
    expect(items).toEqual([
      {
        kind: "tool",
        id: "step:1:tool:0",
        stepIndex: 2,
        toolName: "read_file",
        verb: "read",
        target: "apps/web/src/ChatView.tsx:10-40",
        running: false,
        failed: false,
        inputText: steps[0]!.toolCalls[0]!.input,
        outputText: "Showing lines 10-40",
        outputPreview: "Showing lines 10-40",
      },
      {
        kind: "tool",
        id: "step:1:tool:1",
        stepIndex: 3,
        toolName: "run_command",
        verb: "command",
        target: "Run unit tests",
        running: true,
        failed: false,
        inputText: steps[0]!.toolCalls[1]!.input,
        outputText: "Tool is running as a background task",
        outputPreview: "Tool is running as a background task",
      },
    ]);
  });

  it("recovers path targets from capped tool inputs whose JSON was truncated", () => {
    const truncatedInput =
      '{"Path":"/Users/dev/repo/antimatter/shell.ts","Replacement":"very long text that got cut off…';
    const steps: ReadonlyArray<OrchestrationV2NativeChildStep> = [
      {
        index: 13,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        text: null,
        toolCalls: [{ name: "edit_file", input: truncatedInput }],
      },
    ];

    const items = buildNativeChildActivityItems(steps, { workspaceRoot: "/Users/dev/repo" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool",
      verb: "edit",
      target: "antimatter/shell.ts",
    });
  });

  it("preserves unpaired GENERIC steps when the transcript head was truncated", () => {
    const steps: ReadonlyArray<OrchestrationV2NativeChildStep> = [
      {
        index: 42,
        type: "GENERIC",
        status: "DONE",
        text: "Created At: 2026-11-25T11:40:00-06:00\nCommand exited with code 0.",
        toolCalls: [],
      },
    ];

    expect(buildNativeChildActivityItems(steps)).toEqual([
      {
        kind: "output",
        id: "step:42:output",
        stepIndex: 42,
        stepType: "GENERIC",
        running: false,
        failed: false,
        preview: "Command exited with code 0.",
        text: "Command exited with code 0.",
      },
    ]);
  });
});
