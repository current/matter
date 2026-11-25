import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  antigravityChildActivity,
  antigravityChildToolTitle,
  watchAntigravityChildActivity,
} from "./AntigravityChildActivity.ts";
import {
  autoApproved,
  CHILD,
  LAUNCH,
  makeProfile,
  ROOT,
  transcriptLines,
} from "./AntigravityChildWork.testkit.ts";

const child = (
  steps: ReadonlyArray<{
    readonly index: number;
    readonly type: string;
    readonly status?: string;
    readonly text?: string;
    readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly input: string }>;
  }>,
) => ({
  conversationId: CHILD,
  role: LAUNCH.role,
  prompt: LAUNCH.prompt,
  truncated: false,
  steps: steps.map((step) => ({
    index: step.index,
    type: step.type,
    status: step.status ?? "DONE",
    text: step.text ?? null,
    toolCalls: step.toolCalls ?? [],
  })),
});

describe("antigravityChildToolTitle", () => {
  it("names the verb and target of common tools", () => {
    expect(antigravityChildToolTitle("view_file", { AbsolutePath: "/repo/ship-local.mjs" })).toBe(
      "Read ship-local.mjs",
    );
    expect(antigravityChildToolTitle("replace_file_content", { TargetFile: "/repo/a.ts" })).toBe(
      "Edit a.ts",
    );
    expect(antigravityChildToolTitle("run_command", { CommandLine: "vp test run" })).toBe(
      "Run vp test run",
    );
    expect(antigravityChildToolTitle("grep_search", { Query: "subagent" })).toBe("Search subagent");
    expect(antigravityChildToolTitle("mystery_tool", {})).toBe("mystery_tool");
    expect(antigravityChildToolTitle("view_file", '{"AbsolutePath": "/cut…')).toBe("Read");
  });
});

describe("antigravityChildActivity", () => {
  it("pairs planner tool calls with their results and keeps replies", () => {
    const activity = antigravityChildActivity([
      child([
        { index: 0, type: "SYSTEM_MESSAGE", text: "launch envelope" },
        {
          index: 1,
          type: "PLANNER_RESPONSE",
          text: "Reading both files.",
          toolCalls: [
            { name: "view_file", input: '{"AbsolutePath":"/p/README.md"}' },
            { name: "run_command", input: '{"CommandLine":"ls"}' },
          ],
        },
        { index: 2, type: "VIEW_FILE", text: "Created At: 2026-11-25T10:00:00Z\nmarker 4242" },
        { index: 3, type: "GENERIC", status: "ERROR", text: "ls: denied" },
        { index: 4, type: "PLANNER_RESPONSE", text: "marker 4242 found" },
      ]),
    ]);
    expect(activity).toEqual([
      { kind: "message", id: `${CHILD}:1`, text: "Reading both files." },
      {
        kind: "tool",
        id: `${CHILD}:1:0`,
        title: "Read README.md",
        toolName: "view_file",
        status: "completed",
        input: { AbsolutePath: "/p/README.md" },
        output: "marker 4242",
      },
      {
        kind: "tool",
        id: `${CHILD}:1:1`,
        title: "Run ls",
        toolName: "run_command",
        status: "failed",
        input: { CommandLine: "ls" },
        output: "ls: denied",
      },
      { kind: "message", id: `${CHILD}:4`, text: "marker 4242 found" },
    ]);
  });

  it("keeps a call without a result running and ids stable as the transcript grows", () => {
    const planner = {
      index: 5,
      type: "PLANNER_RESPONSE",
      toolCalls: [{ name: "run_command", input: '{"CommandLine":"vp test"}' }],
    };
    const [running] = antigravityChildActivity([child([planner])]);
    expect(running).toMatchObject({ id: `${CHILD}:5:0`, status: "inProgress", output: null });
    const [done] = antigravityChildActivity([
      child([planner, { index: 6, type: "RUN_COMMAND", text: "ok" }]),
    ]);
    expect(done).toMatchObject({ id: `${CHILD}:5:0`, status: "completed", output: "ok" });
  });

  it("drops a result whose planner step fell outside the read tail", () => {
    expect(
      antigravityChildActivity([child([{ index: 9, type: "GENERIC", text: "orphan" }])]),
    ).toEqual([]);
  });
});

it.layer(NodeServices.layer)("watchAntigravityChildActivity", (it) => {
  it.effect("reads the transcript, then only again after it changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { profile, transcriptPath } = yield* makeProfile({ steps: autoApproved });
      const watcher = watchAntigravityChildActivity({
        profileDirectory: profile,
        rootSessionId: ROOT,
        nativeTaskId: `${ROOT}:1`,
        title: null,
        prompt: "Readme check",
        siblings: () => [],
      });
      const first = yield* watcher.poll;
      expect(first?.map((item) => item.id)).toEqual([`${CHILD}:1:0`, `${CHILD}:3`]);
      expect(first?.[0]).toMatchObject({ title: "Read README.md", status: "completed" });
      // The first read cannot prove its stamp predates the read, so it reads once more.
      expect(yield* watcher.poll).toBeDefined();
      expect(yield* watcher.poll).toBeUndefined();

      yield* fs.writeFileString(
        transcriptPath,
        [
          ...transcriptLines,
          {
            step_index: 4,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            tool_calls: [{ name: "run_command", args: { CommandLine: '"vp test"' } }],
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
      const grown = yield* watcher.poll;
      expect(grown?.at(-1)).toMatchObject({
        id: `${CHILD}:4:0`,
        title: "Run vp test",
        status: "inProgress",
      });
      expect(yield* watcher.isIdle!).toBe(false);

      // Once the child completes its final reply, isIdle flips to true without needing a kill record.
      yield* fs.writeFileString(
        transcriptPath,
        [
          ...transcriptLines,
          {
            step_index: 4,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "Report sent to parent agent.",
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
      expect(yield* watcher.isIdle!).toBe(true);
    }),
  );

  it.effect("reports nothing until the parent's record proves the children", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({ steps: () => [] });
      const watcher = watchAntigravityChildActivity({
        profileDirectory: profile,
        rootSessionId: ROOT,
        nativeTaskId: `${ROOT}:1`,
        title: null,
        prompt: "Readme check",
        siblings: () => [],
      });
      expect(yield* watcher.poll).toBeUndefined();
    }),
  );
});
