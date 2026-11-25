import type { OrchestrationV2NativeChildStep } from "@t3tools/contracts";

export type NativeChildToolVerb =
  | "read"
  | "edit"
  | "write"
  | "command"
  | "search"
  | "message"
  | "subagent"
  | "tool";

export type NativeChildActivityItem =
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly stepIndex: number;
      readonly toolName: string;
      readonly verb: NativeChildToolVerb;
      readonly target: string | null;
      readonly running: boolean;
      readonly failed: boolean;
      readonly inputText: string;
      readonly outputText: string | null;
      readonly outputPreview: string | null;
    }
  | {
      readonly kind: "message";
      readonly id: string;
      readonly stepIndex: number;
      readonly text: string;
    }
  | {
      readonly kind: "output";
      readonly id: string;
      readonly stepIndex: number;
      readonly stepType: string;
      readonly running: boolean;
      readonly failed: boolean;
      readonly preview: string;
      readonly text: string;
    };

const TIMESTAMP_HEADER_LINE = /^(?:Created At|Completed At):\s+\d{4}-\d{2}-\d{2}T.+$/;
const SYSTEM_MESSAGE_PREAMBLE =
  /^The following is a <SYSTEM_MESSAGE>[^\n]*\n+(?:<SYSTEM_MESSAGE>\n?)?/;
const HARNESS_REMINDER_MARKER = "Reminder: work efficiently.";
const TRUNCATED_OUTPUT_PREVIEW_LIMIT = 140;
const TOOL_TARGET_LIMIT = 110;

function truncateInline(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

/** Strips repeated Antigravity `Created At:` / `Completed At:` headers from tool output text. */
export function cleanNativeStepText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start]?.trim() ?? "";
    if (line === "" || TIMESTAMP_HEADER_LINE.test(line)) {
      start += 1;
      continue;
    }
    break;
  }
  const cleaned = lines.slice(start).join("\n").trim();
  return cleaned.length > 0 ? cleaned : text.trim();
}

function cleanSystemMessageText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(SYSTEM_MESSAGE_PREAMBLE, "")
    .replace(/\n?<\/SYSTEM_MESSAGE>\s*$/, "")
    .trim();
}

function firstMeaningfulLine(text: string): string {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length > 0) return truncateInline(line, TRUNCATED_OUTPUT_PREVIEW_LIMIT);
  }
  return "";
}

function parseToolInput(input: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStringField(
  parsed: Record<string, unknown> | null,
  rawInput: string,
  keys: ReadonlyArray<string>,
): string | null {
  if (parsed !== null) {
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  // Capped tool arguments end with `…`, so JSON.parse may fail; recover top-level string fields.
  for (const key of keys) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
    const match = pattern.exec(rawInput);
    if (match?.[1] !== undefined) {
      try {
        const decoded: unknown = JSON.parse(`"${match[1]}"`);
        if (typeof decoded === "string" && decoded.trim().length > 0) {
          return decoded.trim();
        }
      } catch {
        if (match[1].trim().length > 0) return match[1].trim();
      }
    }
  }
  return null;
}

function readNumberField(
  parsed: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): number | null {
  if (parsed === null) return null;
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function formatFilePathTarget(
  filePath: string,
  workspaceRoot: string | null | undefined,
  startLine: number | null,
  endLine: number | null,
): string {
  let display = filePath;
  if (workspaceRoot) {
    const normalizedRoot = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
    if (display.startsWith(normalizedRoot)) {
      display = display.slice(normalizedRoot.length);
    }
  }
  if (startLine !== null && endLine !== null) {
    return `${display}:${startLine}-${endLine}`;
  }
  if (startLine !== null) {
    return `${display}:${startLine}`;
  }
  return display;
}

function classifyToolCall(
  name: string,
  rawInput: string,
  workspaceRoot: string | null | undefined,
): { readonly verb: NativeChildToolVerb; readonly target: string | null } {
  const parsed = parseToolInput(rawInput);
  const normalized = name.toLowerCase();

  if (normalized === "read_file" || normalized === "view_file" || normalized === "read") {
    const path = readStringField(parsed, rawInput, ["Path", "path", "AbsolutePath", "file_path"]);
    const startLine = readNumberField(parsed, ["StartLine", "startLine", "offset"]);
    const endLine = readNumberField(parsed, ["EndLine", "endLine"]);
    return {
      verb: "read",
      target: path ? formatFilePathTarget(path, workspaceRoot, startLine, endLine) : null,
    };
  }

  if (
    normalized === "edit_file" ||
    normalized === "replace_file_content" ||
    normalized === "multi_replace_file_content" ||
    normalized === "edit"
  ) {
    const path = readStringField(parsed, rawInput, ["Path", "path", "TargetFile", "file_path"]);
    return {
      verb: "edit",
      target: path ? formatFilePathTarget(path, workspaceRoot, null, null) : null,
    };
  }

  if (normalized === "write_file" || normalized === "write_to_file" || normalized === "write") {
    const path = readStringField(parsed, rawInput, ["Path", "path", "TargetFile", "file_path"]);
    return {
      verb: "write",
      target: path ? formatFilePathTarget(path, workspaceRoot, null, null) : null,
    };
  }

  if (normalized === "run_command" || normalized === "bash" || normalized === "shell") {
    const summary = readStringField(parsed, rawInput, ["toolSummary", "description"]);
    const command = readStringField(parsed, rawInput, ["CommandLine", "command"]);
    const rawTarget = summary ?? command;
    return {
      verb: "command",
      target: rawTarget ? truncateInline(rawTarget, TOOL_TARGET_LIMIT) : null,
    };
  }

  if (
    normalized === "search_web" ||
    normalized === "grep_search" ||
    normalized === "find_by_name" ||
    normalized === "glob" ||
    normalized === "grep"
  ) {
    const query = readStringField(parsed, rawInput, ["query", "Query", "Pattern", "pattern"]);
    return {
      verb: "search",
      target: query ? truncateInline(query, TOOL_TARGET_LIMIT) : null,
    };
  }

  if (normalized === "send_message") {
    const message = readStringField(parsed, rawInput, ["Message", "message"]);
    return {
      verb: "message",
      target: message ? truncateInline(message, TOOL_TARGET_LIMIT) : null,
    };
  }

  if (normalized === "invoke_subagent" || normalized === "manage_subagents") {
    const detail = readStringField(parsed, rawInput, ["Role", "Action", "TypeName"]);
    return {
      verb: "subagent",
      target: detail ? truncateInline(detail, TOOL_TARGET_LIMIT) : null,
    };
  }

  const fallback =
    readStringField(parsed, rawInput, [
      "toolSummary",
      "Path",
      "path",
      "query",
      "title",
      "action",
    ]) ??
    (rawInput.trim() === "{}" || rawInput.trim() === ""
      ? null
      : truncateInline(rawInput, TOOL_TARGET_LIMIT));
  return {
    verb: "tool",
    target: fallback,
  };
}

function isRunningStatus(status: string | null): boolean {
  return status === "RUNNING" || status === "PENDING" || status === "IN_PROGRESS";
}

function isFailedStatus(status: string | null): boolean {
  return status === "ERROR" || status === "FAILED" || status === "CANCELLED";
}

function isSkippedSystemStep(step: OrchestrationV2NativeChildStep): boolean {
  if (step.type !== "SYSTEM_MESSAGE") return false;
  if (step.index === 0) return true;
  if (step.text !== null && step.text.includes(HARNESS_REMINDER_MARKER)) return true;
  return false;
}

/**
 * Turns raw Antigravity transcript steps into scannable timeline items by pairing
 * `PLANNER_RESPONSE` tool calls with their immediately following `GENERIC` results.
 */
export function buildNativeChildActivityItems(
  steps: ReadonlyArray<OrchestrationV2NativeChildStep>,
  options?: { readonly workspaceRoot?: string | null | undefined },
): ReadonlyArray<NativeChildActivityItem> {
  const workspaceRoot = options?.workspaceRoot;
  const items: Array<NativeChildActivityItem> = [];
  let cursor = 0;

  while (cursor < steps.length) {
    const step = steps[cursor];
    if (step === undefined) break;

    if (isSkippedSystemStep(step)) {
      cursor += 1;
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      const trimmedText = step.text?.trim() ?? "";
      if (trimmedText.length > 0) {
        items.push({
          kind: "message",
          id: `step:${step.index}:message`,
          stepIndex: step.index,
          text: trimmedText,
        });
      }

      if (step.toolCalls.length > 0) {
        const pairedResults: Array<OrchestrationV2NativeChildStep> = [];
        let lookahead = cursor + 1;
        while (
          pairedResults.length < step.toolCalls.length &&
          lookahead < steps.length &&
          steps[lookahead]?.type === "GENERIC" &&
          steps[lookahead]?.toolCalls.length === 0
        ) {
          const resultStep = steps[lookahead];
          if (resultStep !== undefined) {
            pairedResults.push(resultStep);
          }
          lookahead += 1;
        }

        for (const [callIndex, call] of step.toolCalls.entries()) {
          const resultStep = pairedResults[callIndex];
          const classified = classifyToolCall(call.name, call.input, workspaceRoot);
          const cleanedOutput =
            resultStep?.text !== null && resultStep?.text !== undefined
              ? cleanNativeStepText(resultStep.text)
              : null;
          const outputPreview =
            cleanedOutput !== null && cleanedOutput.length > 0
              ? firstMeaningfulLine(cleanedOutput)
              : null;
          const running =
            resultStep !== undefined
              ? isRunningStatus(resultStep.status)
              : isRunningStatus(step.status);
          const failed =
            resultStep !== undefined
              ? isFailedStatus(resultStep.status)
              : isFailedStatus(step.status);

          items.push({
            kind: "tool",
            id: `step:${step.index}:tool:${callIndex}`,
            stepIndex: resultStep?.index ?? step.index,
            toolName: call.name,
            verb: classified.verb,
            target: classified.target,
            running,
            failed,
            inputText: call.input,
            outputText: cleanedOutput,
            outputPreview,
          });
        }

        cursor = lookahead;
        continue;
      }

      cursor += 1;
      continue;
    }

    const rawText = step.text ?? "";
    const cleaned =
      step.type === "SYSTEM_MESSAGE"
        ? cleanSystemMessageText(rawText)
        : cleanNativeStepText(rawText);
    if (cleaned.length > 0) {
      items.push({
        kind: "output",
        id: `step:${step.index}:output`,
        stepIndex: step.index,
        stepType: step.type,
        running: isRunningStatus(step.status),
        failed: isFailedStatus(step.status),
        preview: firstMeaningfulLine(cleaned),
        text: cleaned,
      });
    }

    cursor += 1;
  }

  return items;
}
