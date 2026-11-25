import type { OrchestrationV2NativeChildWork } from "@t3tools/contracts";
import type {
  AcpNativeSubagentActivity,
  AcpNativeSubagentWatcher,
} from "@t3tools/provider-acp/server/adapter";
import * as Effect from "effect/Effect";

import {
  areAntigravityChildrenIdle,
  readAntigravityChildWork,
  statAntigravityChildIdleInputs,
  statAntigravityChildTranscripts,
} from "./AntigravityChildWork.ts";

type ChildStep = NonNullable<OrchestrationV2NativeChildWork["steps"]>[number];

const TITLE_TARGET_LIMIT = 80;
const HARNESS_REMINDER_MARKER = "Reminder: work efficiently.";
const TIMESTAMP_HEADER_LINE = /^(?:Created At|Completed At):\s+\d{4}-\d{2}-\d{2}T.+$/;

const inline = (value: string) => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= TITLE_TARGET_LIMIT
    ? collapsed
    : `${collapsed.slice(0, TITLE_TARGET_LIMIT - 1)}…`;
};

const parseInput = (input: string): unknown => {
  try {
    return JSON.parse(input);
  } catch {
    // Inputs are capped, so a long one is no longer valid JSON.
    return input;
  }
};

const stringField = (input: unknown, keys: ReadonlyArray<string>) => {
  if (input === null || typeof input !== "object") return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

const baseName = (path: string) => path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;

const PATH_KEYS = ["AbsolutePath", "Path", "path", "TargetFile", "file_path"];

/** A short human title for a transcript tool call, such as `Read README.md`. */
export function antigravityChildToolTitle(name: string, input: unknown): string {
  const tool = name.toLowerCase();
  const path = stringField(input, PATH_KEYS);
  const withTarget = (verb: string, target: string | undefined) =>
    target === undefined ? verb : `${verb} ${inline(target)}`;
  if (tool === "view_file" || tool === "read_file" || tool === "read") {
    return withTarget("Read", path && baseName(path));
  }
  if (tool.includes("replace_file_content") || tool === "edit_file" || tool === "edit") {
    return withTarget("Edit", path && baseName(path));
  }
  if (tool === "write_to_file" || tool === "write_file" || tool === "write") {
    return withTarget("Write", path && baseName(path));
  }
  if (tool === "run_command" || tool === "bash" || tool === "shell") {
    return withTarget("Run", stringField(input, ["toolSummary", "CommandLine", "command"]));
  }
  if (
    tool === "grep_search" ||
    tool === "find_by_name" ||
    tool === "search_web" ||
    tool === "glob"
  ) {
    return withTarget("Search", stringField(input, ["Query", "query", "Pattern", "pattern"]));
  }
  if (tool === "list_dir") {
    return withTarget("List", stringField(input, ["DirectoryPath", "path"]));
  }
  return withTarget(name, stringField(input, ["toolSummary", ...PATH_KEYS]));
}

const RUNNING = new Set(["RUNNING", "PENDING", "IN_PROGRESS", "GENERATING"]);
const FAILED = new Set(["ERROR", "FAILED", "CANCELLED", "CANCELED"]);

const stepStatus = (status: string | null) =>
  status !== null && FAILED.has(status)
    ? ("failed" as const)
    : status !== null && RUNNING.has(status)
      ? ("inProgress" as const)
      : ("completed" as const);

/** Strips the runtime's repeated `Created At:` headers from tool output. */
const cleanOutput = (text: string) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start]?.trim() ?? "";
    if (line !== "" && !TIMESTAMP_HEADER_LINE.test(line)) break;
    start += 1;
  }
  return lines.slice(start).join("\n").trim();
};

const isResultStep = (step: ChildStep) =>
  step.toolCalls.length === 0 &&
  step.type !== "PLANNER_RESPONSE" &&
  step.type !== "SYSTEM_MESSAGE" &&
  step.type !== "USER_INPUT";

/**
 * Pairs each planner tool call with the result steps right after it. Ids name the child
 * conversation, step and call, so re-reading a transcript never yields a new item.
 */
export function antigravityChildActivity(
  children: ReadonlyArray<OrchestrationV2NativeChildWork>,
): ReadonlyArray<AcpNativeSubagentActivity> {
  return children.flatMap((child) => {
    const steps = child.steps ?? [];
    const items: Array<AcpNativeSubagentActivity> = [];
    for (let cursor = 0; cursor < steps.length; cursor += 1) {
      const step = steps[cursor];
      if (step === undefined || step.type !== "PLANNER_RESPONSE") continue;
      const text = step.text?.trim() ?? "";
      if (text.length > 0 && !text.includes(HARNESS_REMINDER_MARKER)) {
        items.push({ kind: "message", id: `${child.conversationId}:${step.index}`, text });
      }
      const results: Array<ChildStep> = [];
      for (
        let next = cursor + 1;
        results.length < step.toolCalls.length && next < steps.length;
        next += 1
      ) {
        const candidate = steps[next];
        if (candidate === undefined || !isResultStep(candidate)) break;
        results.push(candidate);
      }
      for (const [callIndex, call] of step.toolCalls.entries()) {
        const input = parseInput(call.input);
        const result = results[callIndex];
        const output = result?.text == null ? null : cleanOutput(result.text);
        items.push({
          kind: "tool",
          id: `${child.conversationId}:${step.index}:${callIndex}`,
          title: antigravityChildToolTitle(call.name, input),
          toolName: call.name,
          status: result === undefined ? "inProgress" : stepStatus(result.status),
          input,
          output: output === null || output.length === 0 ? null : output,
        });
      }
    }
    return items;
  });
}

/**
 * Re-reads a native subagent's transcripts only after one of them changed, so a poll of an
 * idle child costs a few `lstat`s.
 */
export function watchAntigravityChildActivity(input: {
  readonly profileDirectory: string;
  readonly rootSessionId: string;
  readonly nativeTaskId: string;
  readonly title: string | null;
  readonly prompt: string;
  /** The session's other subagent batches, which a launch-text match must rule out. */
  readonly siblings: () => ReadonlyArray<{
    readonly nativeTaskId: string;
    readonly title: string | null;
    readonly prompt: string;
  }>;
}): AcpNativeSubagentWatcher {
  let conversationIds: ReadonlyArray<string> = [];
  let lastStamp: string | undefined;
  let lastIdleStamp: string | undefined;
  let lastIdle = false;
  const stat = (ids: ReadonlyArray<string>) =>
    statAntigravityChildTranscripts({
      profileDirectory: input.profileDirectory,
      conversationIds: ids,
    });
  return {
    poll: Effect.gen(function* () {
      // Stamped before the read: a write racing the read changes the next stamp and is re-read.
      const stamp = conversationIds.length === 0 ? undefined : yield* stat(conversationIds);
      if (stamp !== undefined && stamp === lastStamp) return undefined;
      const children = yield* readAntigravityChildWork({
        profileDirectory: input.profileDirectory,
        rootSessionId: input.rootSessionId,
        nativeTaskId: input.nativeTaskId,
        launch: { title: input.title, prompt: input.prompt },
        siblings: input.siblings(),
      });
      if (children.length === 0) return undefined;
      const ids = children.map((child) => child.conversationId);
      const sameIds = ids.join("\0") === conversationIds.join("\0");
      lastStamp = sameIds ? stamp : undefined;
      if (!sameIds) {
        lastIdleStamp = undefined;
        lastIdle = false;
      }
      conversationIds = ids;
      return antigravityChildActivity(children);
    }).pipe(Effect.orElseSucceed(() => undefined)),
    isIdle: Effect.gen(function* () {
      if (conversationIds.length === 0) return false;
      const idleStamp = yield* statAntigravityChildIdleInputs({
        profileDirectory: input.profileDirectory,
        rootSessionId: input.rootSessionId,
        conversationIds,
      });
      if (idleStamp.length > 0 && idleStamp === lastIdleStamp) return lastIdle;
      const idle = yield* areAntigravityChildrenIdle({
        profileDirectory: input.profileDirectory,
        rootSessionId: input.rootSessionId,
        conversationIds,
      });
      lastIdleStamp = idleStamp.length > 0 ? idleStamp : undefined;
      lastIdle = idle;
      return idle;
    }).pipe(Effect.orElseSucceed(() => false)),
  };
}
