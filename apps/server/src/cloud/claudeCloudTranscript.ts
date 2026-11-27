import {
  CLAUDE_CLOUD_THREAD_ID_PREFIX,
  type ClaudeCloudPendingRequest,
  MessageId,
  NodeId,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type OrchestrationV2WebSearchResult,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import {
  dynamicToolTitle,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { mcpToolResultOutput, omitToolOutputImageData } from "@t3tools/shared/toolOutput";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type ClaudeCloudTranscriptActivity = "running" | "idle" | "needs_input" | "failed";

export interface ClaudeCloudTranscriptMapping {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly pendingRequest: ClaudeCloudPendingRequest | null;
  /** From the newest events: running between a user message and its `result`; needs_input while a can_use_tool / question / plan request is unanswered; failed when the last result is an error. null when nothing can be told. */
  readonly activity: ClaudeCloudTranscriptActivity | null;
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

// Transcripts travel whole over HTTP and the websocket, so long bodies keep only both ends.
const TEXT_EDGE_CHARS = 20_000;
const VALUE_STRING_EDGE_CHARS = 8_000;
const VALUE_MAX_JSON_CHARS = 2 * TEXT_EDGE_CHARS;
const WEB_FETCH_SNIPPET_MAX_CHARS = 8_000;
const REQUEST_DETAIL_MAX_CHARS = 400;
const EPOCH = DateTime.makeUnsafe(0);

type Item = OrchestrationV2TurnItem;
interface ItemBase {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly runId: null;
  readonly nodeId: null;
  readonly providerThreadId: null;
  readonly providerTurnId: null;
  readonly nativeItemRef: null;
  readonly parentItemId: null;
  readonly status: OrchestrationV2TurnItemStatus;
  readonly title: string | null;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc | null;
  readonly updatedAt: DateTime.Utc;
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ItemDraft = DistributiveOmit<Item, "ordinal">;

function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function withoutLeadingLowSurrogate(text: string): string {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

function capText(text: string, edge = TEXT_EDGE_CHARS): string {
  if (text.length <= edge * 2 + 200) return text;
  const head = withoutTrailingHighSurrogate(text.slice(0, edge));
  const tail = withoutLeadingLowSurrogate(text.slice(-edge));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n… ${omitted} characters omitted …\n\n${tail}`;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replaceAll(/\s+/g, " ");
  return trimmed.length <= max
    ? trimmed
    : `${withoutTrailingHighSurrogate(trimmed.slice(0, max - 1))}…`;
}

function capStrings(value: unknown, depth: number): unknown {
  if (typeof value === "string") return capText(value, VALUE_STRING_EDGE_CHARS);
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map((entry) => capStrings(entry, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      key === "base64" && typeof entry === "string"
        ? "[image omitted]"
        : capStrings(entry, depth + 1);
  }
  return out;
}

/** Structured outputs keep their shape unless even trimmed strings leave them too large. */
function capValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const capped = capStrings(omitToolOutputImageData(value), 0);
  const json = JSON.stringify(capped);
  if (json === undefined || json.length <= VALUE_MAX_JSON_CHARS) return capped;
  return capText(json);
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function parseTime(value: unknown): DateTime.Utc | undefined {
  if (typeof value !== "string") return undefined;
  return Option.getOrUndefined(DateTime.make(value));
}

function normalizedToolName(name: string): string {
  return name.toLowerCase().replaceAll(/[\s_-]/g, "");
}

type ToolKind = "command_execution" | "file_change" | "web_search" | "subagent" | "dynamic_tool";

const KNOWN_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  agent: "subagent",
  task: "subagent",
  bash: "command_execution",
  edit: "file_change",
  multiedit: "file_change",
  notebookedit: "file_change",
  write: "file_change",
  webfetch: "web_search",
  websearch: "web_search",
};

function toolKind(name: string): ToolKind {
  return KNOWN_TOOL_KINDS[normalizedToolName(name)] ?? "dynamic_tool";
}

function firstStringField(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(get(input, key));
    if (value !== undefined) return value.trim();
  }
  return undefined;
}

interface ToolOutput {
  /** The tool_result block's own content. */
  readonly content: unknown;
  /** The message's `tool_use_result`, present when the message carries exactly one result. */
  readonly structured: unknown;
  readonly isError: boolean;
}

function outputValue(output: ToolOutput): unknown {
  if (output.structured === undefined) return output.content;
  return mcpToolResultOutput({ content: output.content, structuredContent: output.structured });
}

function outputText(output: ToolOutput): string {
  const value = outputValue(output);
  return typeof value === "string" ? value : value === undefined ? "" : jsonText(value);
}

function contentBlocksText(value: unknown): string | undefined {
  const content = Array.isArray(value) ? value : get(value, "content");
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) =>
      get(part, "type") === "text" && typeof get(part, "text") === "string"
        ? [String(get(part, "text"))]
        : [],
    )
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function commandOutputText(output: ToolOutput): string {
  const value = outputValue(output);
  const stdout = get(value, "stdout");
  const stderr = get(value, "stderr");
  if (typeof stdout === "string" || typeof stderr === "string") {
    const out = typeof stdout === "string" && stdout.trim().length > 0 ? stdout : "";
    const err = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : "";
    const text =
      out.length > 0 && err.length > 0 && !out.endsWith("\n") ? `${out}\n${err}` : out + err;
    if (text.length > 0) return text;
    return contentBlocksText(output.content) ?? jsonText(output.content ?? "");
  }
  return outputText(output);
}

interface FileEditResult {
  readonly type: string | undefined;
  readonly filePath: string;
  readonly content: string | undefined;
  readonly hunks: ReadonlyArray<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: Array<string>;
  }>;
}

function fileEditResult(value: unknown): FileEditResult | undefined {
  const filePath = get(value, "filePath");
  const patch = get(value, "structuredPatch");
  if (typeof filePath !== "string" || !Array.isArray(patch)) return undefined;
  const hunks: Array<FileEditResult["hunks"][number]> = [];
  for (const hunk of patch) {
    const oldStart = get(hunk, "oldStart");
    const oldLines = get(hunk, "oldLines");
    const newStart = get(hunk, "newStart");
    const newLines = get(hunk, "newLines");
    const lines = get(hunk, "lines");
    if (
      typeof oldStart !== "number" ||
      typeof oldLines !== "number" ||
      typeof newStart !== "number" ||
      typeof newLines !== "number" ||
      !Array.isArray(lines) ||
      !lines.every((line) => typeof line === "string")
    ) {
      return undefined;
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: lines.map(String) });
  }
  const type = get(value, "type");
  const content = get(value, "content");
  return {
    type: typeof type === "string" ? type : undefined,
    filePath,
    content: typeof content === "string" ? content : undefined,
    hunks,
  };
}

function fileChangeText(output: ToolOutput): string {
  const result = output.structured === undefined ? undefined : fileEditResult(output.structured);
  if (result === undefined) return outputText(output);
  const patch =
    result.hunks.length === 0 && result.type === "create" && result.content !== undefined
      ? structuredPatch("/dev/null", result.filePath, "", result.content)
      : {
          oldFileName: result.filePath,
          newFileName: result.filePath,
          oldHeader: undefined,
          newHeader: undefined,
          hunks: [...result.hunks],
        };
  return patch.hunks.length === 0 ? "" : formatPatch(patch, FILE_HEADERS_ONLY);
}

const TOOLS_USED_NOTE = /^\s*<tools-used-before-summary>[^<]*<\/tools-used-before-summary>\s*/;
const HAND_BACK_FRAME =
  /^\[Subagent hand-back\] The text below is the final report of a subagent [^\n]* The report follows:\n/;
const USAGE_TRAILER = /(?:^|\n)<usage>[^<]*<\/usage>\s*$/;
const AGENT_ID_TRAILER = /(?:^|\n)agentId: ([\w-]+) \(use SendMessage with to: '\1'[^\n]*\)\s*$/;

function subagentResultText(output: ToolOutput): string {
  const raw = contentBlocksText(outputValue(output)) ?? outputText(output);
  const unwrapped = raw
    .replace(TOOLS_USED_NOTE, "")
    .replace(USAGE_TRAILER, "")
    .replace(AGENT_ID_TRAILER, "");
  const report = unwrapped.replace(HAND_BACK_FRAME, "");
  return report === unwrapped ? report : report.replace(/^ {2}/gm, "");
}

function isSubagentAsyncLaunch(output: ToolOutput): boolean {
  const value = outputValue(output);
  if (get(value, "isAsync") === true || get(value, "status") === "async_launched") return true;
  return subagentResultText(output).startsWith("Async agent launched successfully.");
}

function webSearchResults(value: unknown): ReadonlyArray<OrchestrationV2WebSearchResult> {
  const results = get(value, "results");
  if (typeof get(value, "query") !== "string" || !Array.isArray(results)) return [];
  return results.flatMap((result) => {
    const content = get(result, "content");
    if (!Array.isArray(content)) return [];
    return content.flatMap((entry) => {
      const url = nonEmptyString(get(entry, "url"))?.trim();
      const title = get(entry, "title");
      return [
        {
          ...(typeof title === "string" ? { title } : {}),
          ...(url === undefined ? {} : { url }),
        },
      ];
    });
  });
}

function todoSteps(input: unknown): Array<OrchestrationV2PlanStep> {
  const todos = get(input, "todos");
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo, index) => {
    const text = nonEmptyString(get(todo, "content"))?.trim();
    if (text === undefined) return [];
    const status = get(todo, "status");
    return [
      {
        id: `todo-${index}`,
        text,
        status:
          status === "completed" ? "completed" : status === "in_progress" ? "running" : "pending",
      },
    ];
  });
}

type TaskList = Map<string, Omit<OrchestrationV2PlanStep, "id">>;

function taskStatus(value: unknown): OrchestrationV2PlanStep["status"] | undefined {
  return value === "pending"
    ? "pending"
    : value === "in_progress"
      ? "running"
      : value === "completed"
        ? "completed"
        : undefined;
}

/** Applies one TaskCreate / TaskUpdate / TaskList result to the session's task list. */
function applyTaskTool(tasks: TaskList, name: string, input: unknown, result: unknown): boolean {
  const field = (value: unknown, key: string) => nonEmptyString(get(value, key))?.trim();
  if (name === "TaskList") {
    const listed = get(result, "tasks");
    if (!Array.isArray(listed)) return false;
    tasks.clear();
    for (const task of listed) {
      const id = field(task, "id");
      const text = field(task, "subject");
      const status = taskStatus(get(task, "status"));
      if (id !== undefined && text !== undefined && status !== undefined) {
        tasks.set(id, { text, status });
      }
    }
    return true;
  }
  if (name === "TaskCreate") {
    const created = get(result, "task");
    const match =
      typeof result === "string" ? /^Task #(\S+) created successfully: (.+)$/s.exec(result) : null;
    const id = field(created, "id") ?? match?.[1];
    const text = field(created, "subject") ?? match?.[2]?.trim() ?? field(input, "subject");
    if (id === undefined || text === undefined) return false;
    tasks.set(id, { text, status: "pending" });
    return true;
  }
  if (name !== "TaskUpdate" || get(result, "success") === false) return false;
  if (typeof result === "string" && !result.startsWith("Updated task #")) return false;
  const id = field(input, "taskId") ?? field(result, "taskId");
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return false;
  if (get(input, "status") === "deleted") {
    tasks.delete(id);
    return true;
  }
  tasks.set(id, {
    text: field(input, "subject") ?? task.text,
    status: taskStatus(get(input, "status")) ?? task.status,
  });
  return true;
}

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);
const INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const WRAPPER_ONLY =
  /^\s*<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)>[\s\S]*<\/\1>\s*$/;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** What a person typed, or undefined for the CLI's own frames. */
function visibleUserText(raw: string): string | undefined {
  if (INTERRUPT_MARKERS.has(raw.trim())) return undefined;
  if (WRAPPER_ONLY.test(raw)) return undefined;
  const command = COMMAND_NAME.exec(raw);
  if (command !== null) {
    const name = command[1]!.trim();
    const args = COMMAND_ARGS.exec(raw)?.[1]?.trim() ?? "";
    const text = `${name.startsWith("/") ? name : `/${name}`} ${args}`.trim();
    return text.length > 1 ? text : undefined;
  }
  const text = raw.replace(SYSTEM_REMINDER, "").trim();
  return text.length > 0 ? text : undefined;
}

function userMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return visibleUserText(content);
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => get(block, "type") === "tool_result")) return undefined;
  const texts = content.flatMap((block) => {
    const text = get(block, "type") === "text" ? get(block, "text") : undefined;
    const visible = typeof text === "string" ? visibleUserText(text) : undefined;
    return visible === undefined ? [] : [visible];
  });
  const images = content.filter((block) => get(block, "type") === "image").length;
  if (texts.length > 0) return texts.join("\n\n");
  if (images === 0) return undefined;
  return Array.from({ length: images }, (_, index) => `[Image #${index + 1}]`).join(" ");
}

function terminalResultError(reason: unknown): string | undefined {
  switch (reason) {
    case "api_error":
      return "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
    case "prompt_too_long":
      return "Claude stopped: the prompt exceeds the model's context window.";
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

function resultErrors(event: unknown): ReadonlyArray<string> {
  const errors = get(event, "errors");
  return Array.isArray(errors)
    ? errors.filter(
        (error): error is string =>
          typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
      )
    : [];
}

type ResultOutcome = "completed" | "interrupted" | "failed";

function resultOutcome(event: unknown): ResultOutcome {
  const reason = get(event, "terminal_reason");
  if (reason === "aborted_tools" || reason === "aborted_streaming") return "interrupted";
  const apiStatus = get(event, "api_error_status");
  if (get(event, "subtype") === "success") {
    return get(event, "is_error") === true ||
      apiStatus === 429 ||
      apiStatus === 529 ||
      terminalResultError(reason) !== undefined
      ? "failed"
      : "completed";
  }
  const errorText = resultErrors(event).join("\n").toLowerCase();
  return errorText.includes("interrupt") || errorText.includes("cancel") ? "interrupted" : "failed";
}

function resultFailure(event: unknown): OrchestrationV2ProviderFailure {
  const apiStatus = get(event, "api_error_status");
  const reason = nonEmptyString(get(event, "terminal_reason"));
  const message =
    resultErrors(event).find((error) => error.trim().length > 0) ??
    terminalResultError(reason) ??
    nonEmptyString(get(event, "result")) ??
    "The Claude Cloud turn failed.";
  return {
    class: apiStatus === 429 ? "usage_limit" : "provider_error",
    message: truncate(message, 4_000),
    code: (typeof apiStatus === "number"
      ? `api_error_${Math.trunc(apiStatus)}`
      : (reason ?? "sdk_result_error")
    ).slice(0, 128),
    retryable: apiStatus === 429 || apiStatus === 529 ? true : null,
  };
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly kind: ToolKind;
  readonly eventIndex: number;
  readonly startedAt: DateTime.Utc;
  readonly presentation: ReturnType<typeof mcpToolPresentation>;
  output: ToolOutput | null;
  completedAt: DateTime.Utc | null;
  nonExecutionKind: string | undefined;
  backgroundStatus: OrchestrationV2TurnItemStatus | null;
  backgroundSummary: string | undefined;
}

interface PendingControlRequest {
  readonly requestId: string;
  readonly toolUseId: string | undefined;
  readonly eventIndex: number;
  readonly request: ClaudeCloudPendingRequest;
}

function pendingRequestFor(request: unknown): ClaudeCloudPendingRequest {
  const toolName = nonEmptyString(get(request, "tool_name")) ?? "a tool";
  const displayName = nonEmptyString(get(request, "display_name")) ?? toolName;
  const input = get(request, "input");
  if (toolName === "ExitPlanMode") {
    const plan = nonEmptyString(get(input, "plan"));
    const heading = plan
      ?.split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0);
    return {
      kind: "plan",
      title: "Plan ready for review",
      detail: heading === undefined ? null : truncate(heading, REQUEST_DETAIL_MAX_CHARS),
    };
  }
  const questions = get(input, "questions");
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0];
    const question = nonEmptyString(get(first, "question")) ?? nonEmptyString(get(first, "header"));
    const options = get(first, "options");
    const labels = Array.isArray(options)
      ? options.flatMap((option) => {
          const label = nonEmptyString(get(option, "label"));
          return label === undefined ? [] : [label.trim()];
        })
      : [];
    const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    return {
      kind: "question",
      title: `${truncate(question ?? "Claude has a question", 180)}${more}`,
      detail: labels.length === 0 ? null : truncate(labels.join(" · "), REQUEST_DETAIL_MAX_CHARS),
    };
  }
  const subject =
    firstStringField(input, ["command", "cmd", "script"]) ??
    firstStringField(input, ["file_path", "path", "url", "filename", "fileName"]);
  const serialized = input === undefined ? undefined : jsonText(input);
  const detail =
    subject ?? (serialized === undefined || serialized === "{}" ? undefined : serialized);
  return {
    kind: "permission",
    title: truncate(`Allow ${displayName}`, 200),
    detail: detail === undefined ? null : truncate(detail, REQUEST_DETAIL_MAX_CHARS),
  };
}

/**
 * Maps a Claude Cloud session's stream-json events (`GET /v1/sessions/{id}/events`) to Matter turn
 * items shaped like the Claude adapter's, so the transcript renders through the same timeline.
 * Pure and deterministic: ids and ordinals depend only on the events, so a recompute over a longer
 * event list keeps every earlier item's id and ordinal.
 */
export function mapClaudeCloudEvents(input: {
  readonly sessionId: string;
  readonly events: ReadonlyArray<unknown>;
}): ClaudeCloudTranscriptMapping {
  const threadId = ThreadId.make(`${CLAUDE_CLOUD_THREAD_ID_PREFIX}${input.sessionId}`);
  const itemId = (suffix: string) => TurnItemId.make(`${threadId}:${suffix}`);
  const items: Array<Item> = [];
  const indexById = new Map<string, number>();
  const put = (draft: ItemDraft) => {
    const existing = indexById.get(draft.id);
    if (existing === undefined) {
      indexById.set(draft.id, items.length);
      items.push({ ...draft, ordinal: items.length } as Item);
    } else {
      items[existing] = { ...draft, ordinal: items[existing]!.ordinal } as Item;
    }
  };
  const base = (
    id: TurnItemId,
    status: OrchestrationV2TurnItemStatus,
    title: string | null,
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
  ): ItemBase => ({
    id,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status,
    title,
    startedAt,
    completedAt,
    updatedAt: completedAt ?? startedAt,
  });

  const tools = new Map<string, ToolCall>();
  const tasks: TaskList = new Map();
  const controlRequests = new Map<string, PendingControlRequest>();
  let lastTime = EPOCH;
  let turnKey = "start";
  let turnStartIndex = -1;
  let lastResultIndex = -1;
  let lastResultOutcome: ResultOutcome | null = null;

  const putTool = (tool: ToolCall) => {
    const turnOver = tool.output === null && lastResultIndex > tool.eventIndex;
    const status: OrchestrationV2TurnItemStatus =
      tool.backgroundStatus ??
      (tool.output === null
        ? turnOver
          ? "interrupted"
          : "running"
        : tool.nonExecutionKind === "cancelled" || tool.nonExecutionKind === "interrupted"
          ? tool.nonExecutionKind
          : tool.output.isError
            ? "failed"
            : "completed");
    const completedAt =
      tool.output === null && !turnOver ? null : (tool.completedAt ?? tool.startedAt);
    const output = tool.output;
    const normalized = normalizedToolName(tool.name);
    const readPath =
      normalized === "read" ? firstStringField(tool.input, ["file_path", "path"]) : undefined;
    const searchTitle = ["grep", "glob", "ls"].includes(normalized)
      ? formatSearchToolLabel({ input: isRecord(tool.input) ? tool.input : undefined })
      : undefined;
    const title =
      readPath !== undefined
        ? formatReadToolLabel(readPath)
        : (searchTitle ??
          dynamicToolTitle(tool.name, tool.input) ??
          tool.presentation.title ??
          null);
    const common = {
      ...base(itemId(tool.id), status, title, tool.startedAt, completedAt),
      ...(tool.nonExecutionKind === undefined
        ? {}
        : { toolNonExecutionKind: tool.nonExecutionKind }),
    };
    switch (tool.kind) {
      case "command_execution": {
        const text = output === null ? "" : commandOutputText(output);
        put({
          ...common,
          type: "command_execution",
          input: capText(
            firstStringField(tool.input, ["command", "cmd", "script"]) ??
              `${tool.name}: ${jsonText(tool.input)}`,
          ),
          ...(text.length === 0 ? {} : { output: capText(text) }),
        });
        return;
      }
      case "file_change": {
        const text = output === null ? "" : fileChangeText(output);
        put({
          ...common,
          type: "file_change",
          fileName:
            firstStringField(tool.input, [
              "file_path",
              "notebook_path",
              "path",
              "filename",
              "fileName",
            ]) ?? `${tool.name} result`,
          ...(text.length === 0 ? {} : { diffStr: capText(text) }),
        });
        return;
      }
      case "web_search": {
        const value = output === null ? undefined : outputValue(output);
        const pattern =
          firstStringField(tool.input, ["query", "url", "pattern"]) ??
          nonEmptyString(get(value, "query"));
        const results = webSearchResults(value);
        const text = output === null ? "" : outputText(output);
        const url = firstStringField(tool.input, ["url"]);
        put({
          ...common,
          type: "web_search",
          ...(pattern === undefined ? {} : { patterns: [pattern] }),
          ...(results.length > 0
            ? { results: [...results] }
            : normalized === "webfetch" && text.trim().length > 0
              ? {
                  results: [
                    {
                      ...(url === undefined ? {} : { url }),
                      snippet: withoutTrailingHighSurrogate(
                        text.slice(0, WEB_FETCH_SNIPPET_MAX_CHARS),
                      ),
                    },
                  ],
                }
              : {}),
        });
        return;
      }
      case "subagent": {
        const async = output !== null && !output.isError && isSubagentAsyncLaunch(output);
        const result =
          tool.backgroundSummary ??
          (output === null || async ? undefined : subagentResultText(output));
        const prompt = nonEmptyString(get(tool.input, "prompt")) ?? "";
        put({
          ...common,
          status: tool.backgroundStatus ?? (async ? "running" : status),
          completedAt: async && tool.backgroundStatus === null ? null : completedAt,
          title: nonEmptyString(get(tool.input, "description"))?.trim() ?? title,
          type: "subagent",
          subagentId: NodeId.make(`${threadId}:subagent:${tool.id}`),
          origin: "provider_native",
          driver: CLAUDE_DRIVER,
          providerInstanceId: CLAUDE_INSTANCE,
          childThreadId: null,
          prompt: capText(prompt),
          result: result === undefined || result.trim().length === 0 ? null : capText(result),
        });
        return;
      }
      case "dynamic_tool": {
        const value = output === null ? undefined : outputValue(output);
        put({
          ...common,
          ...(tool.presentation.toolIcon === undefined
            ? {}
            : { toolIcon: tool.presentation.toolIcon }),
          ...(tool.presentation.toolSource === undefined
            ? {}
            : { toolSource: tool.presentation.toolSource }),
          type: "dynamic_tool",
          toolName: tool.name,
          input: capValue(tool.input) ?? null,
          ...(value === undefined ? {} : { output: capValue(value) }),
        });
        return;
      }
    }
  };

  const putTaskList = (at: DateTime.Utc) => {
    put({
      ...base(itemId(`tasks:${turnKey}`), "completed", null, at, at),
      type: "todo_list",
      planId: PlanId.make(`${threadId}:tasks:${turnKey}`),
      steps: [...tasks].map(([id, task]) => ({ id: `task-${id}`, ...task })),
    });
  };

  for (const [index, event] of input.events.entries()) {
    const type = get(event, "type");
    const uuid = nonEmptyString(get(event, "uuid")) ?? `event-${index}`;
    const time = parseTime(get(event, "created_at")) ?? lastTime;
    lastTime = time;
    const isSubagentFrame = get(event, "parent_tool_use_id") != null;

    if (type === "system") {
      const subtype = get(event, "subtype");
      if (subtype === "init") {
        turnStartIndex = index;
        turnKey = uuid;
      } else if (subtype === "compact_boundary") {
        const metadata = get(event, "compact_metadata");
        const pre = get(metadata, "pre_tokens");
        const post = get(metadata, "post_tokens");
        const count = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value > 0
            ? Math.round(value)
            : undefined;
        const before = count(pre);
        const after = count(post);
        put({
          ...base(itemId(uuid), "completed", "Context compacted", time, time),
          type: "compaction",
          driver: CLAUDE_DRIVER,
          ...(before === undefined ? {} : { beforeTokenCount: before }),
          ...(after === undefined ? {} : { afterTokenCount: after }),
        });
      } else if (subtype === "informational") {
        const content = nonEmptyString(get(event, "content"));
        const stopHookNotice =
          get(event, "level") === "notice" &&
          content?.startsWith("Stop says: ") === true &&
          get(event, "prevent_continuation") !== true;
        if (content !== undefined && !stopHookNotice) {
          put({
            ...base(itemId(uuid), "completed", truncate(content, 200), time, time),
            type: "system_notice",
            message: capText(content),
          });
        }
      } else if (subtype === "task_notification") {
        const toolUseId = nonEmptyString(get(event, "tool_use_id"));
        const tool = toolUseId === undefined ? undefined : tools.get(toolUseId);
        if (tool !== undefined && tool.kind === "subagent") {
          const status = get(event, "status");
          tool.backgroundStatus =
            status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled";
          tool.backgroundSummary = nonEmptyString(get(event, "summary"));
          tool.completedAt = time;
          putTool(tool);
        }
      }
      continue;
    }

    if (type === "control_request") {
      const request = get(event, "request");
      const subtype = get(request, "subtype");
      const requestId = nonEmptyString(get(event, "request_id"));
      if (subtype === "can_use_tool" && requestId !== undefined) {
        controlRequests.set(requestId, {
          requestId,
          toolUseId: nonEmptyString(get(request, "tool_use_id")),
          eventIndex: index,
          request: pendingRequestFor(request),
        });
      }
      continue;
    }

    if (type === "control_response" || type === "control_cancel_request") {
      const requestId =
        nonEmptyString(get(get(event, "response"), "request_id")) ??
        nonEmptyString(get(event, "request_id"));
      if (requestId !== undefined) controlRequests.delete(requestId);
      continue;
    }

    if (type === "result") {
      lastResultIndex = index;
      lastResultOutcome = resultOutcome(event);
      controlRequests.clear();
      for (const tool of tools.values()) {
        if (tool.output === null && tool.eventIndex < index) putTool(tool);
      }
      if (lastResultOutcome === "failed") {
        put({
          ...base(itemId(uuid), "failed", "Turn failed", time, time),
          type: "error",
          failure: resultFailure(event),
        });
      } else if (lastResultOutcome === "interrupted") {
        put({
          ...base(itemId(uuid), "interrupted", "Interrupted", time, time),
          type: "run_interrupt_result",
          message: "Stopped",
        });
      }
      turnKey = uuid;
      continue;
    }

    if (isSubagentFrame) continue;

    if (type === "assistant") {
      if (turnStartIndex <= lastResultIndex) turnStartIndex = index;
      const content = get(get(event, "message"), "content");
      if (!Array.isArray(content)) continue;
      const toolMeta = get(event, "tool_use_meta");
      for (const [blockIndex, block] of content.entries()) {
        const blockType = get(block, "type");
        if (blockType === "text") {
          const text = nonEmptyString(get(block, "text"));
          if (text === undefined) continue;
          const id = itemId(`${uuid}:${blockIndex}`);
          put({
            ...base(id, "completed", null, time, time),
            type: "assistant_message",
            messageId: MessageId.make(id),
            text: capText(text),
            streaming: false,
          });
        } else if (blockType === "thinking") {
          const text = nonEmptyString(get(block, "thinking"));
          if (text === undefined) continue;
          put({
            ...base(itemId(`${uuid}:${blockIndex}`), "completed", null, time, time),
            type: "reasoning",
            text: capText(text),
            streaming: false,
          });
        } else if (blockType === "tool_use") {
          const id = nonEmptyString(get(block, "id"));
          const name = nonEmptyString(get(block, "name"));
          if (id === undefined || name === undefined || tools.has(id)) continue;
          const toolInput = get(block, "input") ?? {};
          const meta = Array.isArray(toolMeta)
            ? toolMeta.find((entry) => get(entry, "id") === id)
            : undefined;
          const mcpName = name.replace(/^mcp__claude_ai_/u, "mcp__");
          const tool: ToolCall = {
            id,
            name,
            input: toolInput,
            kind: toolKind(name),
            eventIndex: index,
            startedAt: time,
            presentation: mcpToolPresentation({
              toolName: mcpName,
              ...(meta === undefined
                ? {}
                : {
                    title: get(meta, "display_name"),
                    serverDisplayName: get(meta, "server_display_name"),
                    iconUrl: get(meta, "icon_url"),
                  }),
            }),
            output: null,
            completedAt: null,
            nonExecutionKind: undefined,
            backgroundStatus: null,
            backgroundSummary: undefined,
          };
          tools.set(id, tool);
          if (name === "TodoWrite") {
            put({
              ...base(itemId(`todo:${id}`), "completed", null, time, time),
              type: "todo_list",
              planId: PlanId.make(`${threadId}:todo:${id}`),
              steps: todoSteps(toolInput),
            });
          }
          putTool(tool);
          const plan = name === "ExitPlanMode" ? nonEmptyString(get(toolInput, "plan")) : undefined;
          if (plan !== undefined) {
            put({
              ...base(itemId(`plan:${id}`), "completed", null, time, time),
              type: "proposed_plan",
              planId: PlanId.make(`${threadId}:plan:${id}`),
              markdown: capText(plan.trim()),
              streaming: false,
            });
          }
        }
      }
      continue;
    }

    if (type === "user") {
      const message = get(event, "message");
      const content = get(message, "content");
      if (Array.isArray(content)) {
        const results = content.filter((block) => get(block, "type") === "tool_result");
        const resultMeta = get(event, "tool_result_meta");
        for (const block of results) {
          const toolUseId = nonEmptyString(get(block, "tool_use_id"));
          const tool = toolUseId === undefined ? undefined : tools.get(toolUseId);
          if (toolUseId === undefined || tool === undefined) continue;
          tool.output = {
            content: get(block, "content"),
            structured: results.length === 1 ? get(event, "tool_use_result") : undefined,
            isError: get(block, "is_error") === true,
          };
          tool.completedAt = time;
          const meta = Array.isArray(resultMeta)
            ? resultMeta.find((entry) => get(entry, "id") === toolUseId)
            : undefined;
          tool.nonExecutionKind = nonEmptyString(get(meta, "non_execution_kind"));
          putTool(tool);
          for (const [requestId, request] of controlRequests) {
            if (request.toolUseId === toolUseId) controlRequests.delete(requestId);
          }
          if (
            TASK_TOOL_NAMES.has(tool.name) &&
            !tool.output.isError &&
            tool.nonExecutionKind === undefined &&
            applyTaskTool(tasks, tool.name, tool.input, outputValue(tool.output))
          ) {
            putTaskList(time);
          }
        }
        if (results.length > 0) continue;
      }
      if (
        get(event, "isMeta") === true ||
        get(event, "isSynthetic") === true ||
        get(event, "isReplay") === true ||
        get(event, "isCompactSummary") === true
      ) {
        continue;
      }
      const text = userMessageText(content);
      if (text === undefined) continue;
      if (turnStartIndex <= lastResultIndex) {
        turnStartIndex = index;
        turnKey = uuid;
      }
      const id = itemId(uuid);
      put({
        ...base(id, "completed", null, time, time),
        type: "user_message",
        createdBy: "user",
        creationSource: "server",
        messageId: MessageId.make(id),
        inputIntent: "turn_start",
        text: capText(text),
        attachments: [],
      });
    }
  }

  const pending =
    [...controlRequests.values()].filter((request) => request.eventIndex > lastResultIndex).at(-1)
      ?.request ?? null;
  const running = turnStartIndex > lastResultIndex;
  const activity: ClaudeCloudTranscriptActivity | null =
    pending !== null
      ? "needs_input"
      : running
        ? "running"
        : lastResultOutcome === "failed"
          ? "failed"
          : lastResultOutcome !== null
            ? "idle"
            : null;

  return { turnItems: items, pendingRequest: pending, activity };
}
