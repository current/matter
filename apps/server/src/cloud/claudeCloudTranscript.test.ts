import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { mapClaudeCloudEvents } from "./claudeCloudTranscript.ts";

const SESSION = "session_test0001";
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

let clock = 0;
const at = () => DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1) + 1_000 * clock++));

const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid,
  created_at: at(),
  parent_tool_use_id: null,
  message: { role: "user", content },
  ...extra,
});

const assistant = (uuid: string, block: unknown) => ({
  type: "assistant",
  uuid,
  created_at: at(),
  parent_tool_use_id: null,
  message: { id: `msg_${uuid}`, role: "assistant", content: [block] },
});

const toolResult = (
  uuid: string,
  toolUseId: string,
  content: unknown,
  structured?: unknown,
  isError = false,
) =>
  user(
    uuid,
    [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    structured === undefined ? {} : { tool_use_result: structured },
  );

const init = (uuid: string) => ({ type: "system", subtype: "init", uuid, created_at: at() });

const result = (uuid: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
  result: "done",
  uuid,
  created_at: at(),
  ...extra,
});

const noise = [
  { type: "env_manager_log", uuid: "n1", created_at: at(), data: { message: "boot" } },
  { type: "system", subtype: "status", status: "requesting", uuid: "n2", created_at: at() },
  { type: "system", subtype: "hook_started", uuid: "n3", created_at: at() },
  { type: "rate_limit_event", uuid: "n4", created_at: at() },
  { type: "prompt_suggestion", uuid: "n5", created_at: at(), suggestion: "next" },
  { type: "autocompact_state", uuid: "n6", created_at: at() },
  { type: "tool_progress", uuid: "n7", created_at: at(), tool_use_id: "toolu_bash" },
  {
    type: "control_request",
    uuid: "n8",
    created_at: at(),
    request_id: "init-1",
    request: { subtype: "initialize" },
  },
  {
    type: "control_response",
    uuid: "n9",
    created_at: at(),
    response: { subtype: "success", request_id: "init-1" },
  },
];

function basicTurn() {
  return [
    user("u1", "List the files"),
    init("i1"),
    ...noise,
    assistant("a1", { type: "thinking", thinking: "I should run ls.", signature: "sig" }),
    assistant("a2", { type: "thinking", thinking: "", signature: "sig" }),
    assistant("a3", {
      type: "tool_use",
      id: "toolu_bash",
      name: "Bash",
      input: { command: "ls", description: "List files" },
    }),
    toolResult("u2", "toolu_bash", "a.txt\nb.txt", {
      stdout: "a.txt\nb.txt",
      stderr: "",
      interrupted: false,
      isImage: false,
    }),
    assistant("a4", { type: "text", text: "There are two files." }),
    result("r1"),
  ];
}

describe("mapClaudeCloudEvents", () => {
  it("maps a prompt, thinking, a Bash call with its output, the reply and the result", () => {
    const mapped = mapClaudeCloudEvents({ sessionId: SESSION, events: basicTurn() });
    expect(mapped.turnItems.map((item) => item.type)).toEqual([
      "user_message",
      "reasoning",
      "command_execution",
      "assistant_message",
    ]);
    const [prompt, reasoning, command, reply] = mapped.turnItems;
    expect(prompt).toMatchObject({ type: "user_message", text: "List the files", attachments: [] });
    expect(reasoning).toMatchObject({ text: "I should run ls.", streaming: false });
    expect(command).toMatchObject({
      type: "command_execution",
      input: "ls",
      output: "a.txt\nb.txt",
      status: "completed",
    });
    expect(reply).toMatchObject({ text: "There are two files.", streaming: false });
    for (const item of mapped.turnItems) {
      expect(item.threadId).toBe(`claude-cloud:${SESSION}`);
      expect(item.runId).toBeNull();
      expect(item.nativeItemRef).toBeNull();
    }
    expect(mapped.turnItems.map((item) => item.ordinal)).toEqual([0, 1, 2, 3]);
    expect(mapped.activity).toBe("idle");
    expect(mapped.pendingRequest).toBeNull();
  });

  it("decodes every item with the turn item schema", () => {
    const events = [
      ...basicTurn(),
      user("u3", "Edit and look things up"),
      init("i2"),
      assistant("b1", {
        type: "tool_use",
        id: "toolu_write",
        name: "Write",
        input: { file_path: "/repo/new.txt", content: "hello\n" },
      }),
      toolResult("u4", "toolu_write", "File created", {
        type: "create",
        filePath: "/repo/new.txt",
        content: "hello\n",
        structuredPatch: [],
      }),
      assistant("b2", {
        type: "tool_use",
        id: "toolu_read",
        name: "Read",
        input: { file_path: "/repo/new.txt" },
      }),
      toolResult("u5", "toolu_read", "1\thello"),
      assistant("b3", {
        type: "tool_use",
        id: "toolu_fetch",
        name: "WebFetch",
        input: { url: "https://example.com", prompt: "summarize" },
      }),
      toolResult("u6", "toolu_fetch", "Example page"),
      assistant("b4", {
        type: "tool_use",
        id: "toolu_todo",
        name: "TodoWrite",
        input: { todos: [{ content: "Write file", status: "completed" }] },
      }),
      toolResult("u7", "toolu_todo", "ok"),
      assistant("b5", {
        type: "tool_use",
        id: "toolu_task",
        name: "TaskCreate",
        input: { subject: "Ship it" },
      }),
      toolResult("u8", "toolu_task", "Task #1 created successfully: Ship it", {
        task: { id: "1", subject: "Ship it" },
      }),
      assistant("b6", {
        type: "tool_use",
        id: "toolu_agent",
        name: "Agent",
        input: { description: "Explore", prompt: "Look around" },
      }),
      toolResult("u9", "toolu_agent", [{ type: "text", text: "Found nothing." }]),
      assistant("b7", {
        type: "tool_use",
        id: "toolu_mcp",
        name: "mcp__github__list_pull_requests",
        input: { state: "open" },
      }),
      toolResult("u10", "toolu_mcp", [{ type: "text", text: "[]" }]),
      assistant("b8", {
        type: "tool_use",
        id: "toolu_plan",
        name: "ExitPlanMode",
        input: { plan: "# Plan\n\n- step" },
      }),
      toolResult("u11", "toolu_plan", "Denied", undefined, true),
      result("r2", { subtype: "error_during_execution", is_error: true, errors: ["Boom"] }),
    ];
    const mapped = mapClaudeCloudEvents({ sessionId: SESSION, events });
    for (const item of mapped.turnItems) expect(() => decodeItem(item)).not.toThrow();
    const byType = (type: string) => mapped.turnItems.filter((item) => item.type === type);
    expect(byType("file_change")[0]).toMatchObject({ fileName: "/repo/new.txt" });
    expect(byType("web_search")[0]).toMatchObject({ patterns: ["https://example.com"] });
    expect(byType("subagent")[0]).toMatchObject({
      title: "Explore",
      prompt: "Look around",
      result: "Found nothing.",
      status: "completed",
    });
    expect(byType("todo_list").map((item) => item.type === "todo_list" && item.steps)).toEqual([
      [{ id: "todo-0", text: "Write file", status: "completed" }],
      [{ id: "task-1", text: "Ship it", status: "pending" }],
    ]);
    expect(byType("proposed_plan")[0]).toMatchObject({ markdown: "# Plan\n\n- step" });
    const mcp = byType("dynamic_tool").find(
      (item) => item.type === "dynamic_tool" && item.toolName?.startsWith("mcp__"),
    );
    expect(mcp).toMatchObject({ toolSource: { key: "mcp:github" } });
    expect(byType("error")[0]).toMatchObject({ failure: { message: "Boom" } });
    expect(mapped.activity).toBe("failed");
  });

  it("reports a pending can_use_tool request until its control_response arrives", () => {
    const pending = [
      user("u1", "Delete the build folder"),
      init("i1"),
      assistant("a1", {
        type: "tool_use",
        id: "toolu_rm",
        name: "Bash",
        input: { command: "rm -rf build" },
      }),
      {
        type: "control_request",
        uuid: "c1",
        created_at: at(),
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          display_name: "Bash",
          tool_use_id: "toolu_rm",
          input: { command: "rm -rf build" },
        },
      },
    ];
    const waiting = mapClaudeCloudEvents({ sessionId: SESSION, events: pending });
    expect(waiting.pendingRequest).toEqual({
      kind: "permission",
      title: "Allow Bash",
      detail: "rm -rf build",
    });
    expect(waiting.activity).toBe("needs_input");
    expect(waiting.turnItems.at(-1)).toMatchObject({
      type: "command_execution",
      status: "running",
    });

    const answered = mapClaudeCloudEvents({
      sessionId: SESSION,
      events: [
        ...pending,
        {
          type: "control_response",
          uuid: "c2",
          created_at: at(),
          response: { subtype: "success", request_id: "req-1", response: { behavior: "allow" } },
        },
      ],
    });
    expect(answered.pendingRequest).toBeNull();
    expect(answered.activity).toBe("running");
  });

  it("names plan and question requests by their kind", () => {
    const request = (requestId: string, toolName: string, input: unknown) => ({
      type: "control_request",
      uuid: `c-${requestId}`,
      created_at: at(),
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: toolName, input },
    });
    const plan = mapClaudeCloudEvents({
      sessionId: SESSION,
      events: [user("u1", "Plan it"), request("p", "ExitPlanMode", { plan: "# Rollout\n- a" })],
    });
    expect(plan.pendingRequest).toEqual({
      kind: "plan",
      title: "Plan ready for review",
      detail: "Rollout",
    });
    const question = mapClaudeCloudEvents({
      sessionId: SESSION,
      events: [
        user("u1", "Ask me"),
        request("q", "AskUserQuestion", {
          questions: [
            {
              question: "Which color?",
              header: "Color",
              options: [{ label: "Red" }, { label: "Blue" }],
            },
            { question: "Which size?", header: "Size", options: [] },
          ],
        }),
      ],
    });
    expect(question.pendingRequest).toEqual({
      kind: "question",
      title: "Which color? (+1 more)",
      detail: "Red · Blue",
    });
  });

  it("hides synthetic user messages", () => {
    const mapped = mapClaudeCloudEvents({
      sessionId: SESSION,
      events: [
        user("u1", "Real prompt"),
        user("u2", [{ type: "text", text: "Stop hook feedback: x" }], { isSynthetic: true }),
        user("u3", "<task-notification><task-id>t</task-id></task-notification>", {
          isReplay: true,
        }),
        user("u4", "meta", { isMeta: true }),
        user("u5", [{ type: "text", text: "[Request interrupted by user]" }]),
        user("u6", "<system-reminder>be brief</system-reminder>"),
        user("u7", "<local-command-stdout>ok</local-command-stdout>"),
        user(
          "u8",
          "<command-name>/review</command-name><command-message>review</command-message><command-args>main</command-args>",
        ),
        user("u9", [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
        ]),
        user("u10", "child frame", { parent_tool_use_id: "toolu_agent" }),
      ],
    });
    expect(
      mapped.turnItems.map((item) => (item.type === "user_message" ? item.text : item.type)),
    ).toEqual(["Real prompt", "/review main", "[Image #1]"]);
    expect(mapped.activity).toBe("running");
  });

  it("keeps ids and ordinals stable across recomputes and appended events", () => {
    const events = basicTurn();
    const first = mapClaudeCloudEvents({ sessionId: SESSION, events });
    const second = mapClaudeCloudEvents({ sessionId: SESSION, events });
    expect(second.turnItems).toEqual(first.turnItems);

    const extended = mapClaudeCloudEvents({
      sessionId: SESSION,
      events: [...events, user("u9", "Thanks"), init("i9")],
    });
    expect(extended.turnItems.slice(0, first.turnItems.length)).toEqual(first.turnItems);
    expect(extended.turnItems.at(-1)).toMatchObject({ type: "user_message", ordinal: 4 });
    expect(extended.activity).toBe("running");
    expect(new Set(extended.turnItems.map((item) => item.id)).size).toBe(extended.turnItems.length);
  });

  it("caps very large tool output and keeps both ends", () => {
    const big = `${"a".repeat(30_000)}MIDDLE${"z".repeat(30_000)}`;
    const mapped = mapClaudeCloudEvents({
      sessionId: SESSION,
      events: [
        user("u1", "Print a lot"),
        assistant("a1", {
          type: "tool_use",
          id: "toolu_big",
          name: "Bash",
          input: { command: "cat" },
        }),
        toolResult("u2", "toolu_big", big, { stdout: big, stderr: "" }),
      ],
    });
    const command = mapped.turnItems.find((item) => item.type === "command_execution");
    const output = command?.type === "command_execution" ? (command.output ?? "") : "";
    expect(output.length).toBeLessThan(41_000);
    expect(output.startsWith("aaaa")).toBe(true);
    expect(output.endsWith("zzzz")).toBe(true);
    expect(output).not.toContain("MIDDLE");
    expect(output).toContain("characters omitted");
  });

  it("marks an interrupted turn and the tool it cut off", () => {
    const mapped = mapClaudeCloudEvents({
      sessionId: SESSION,
      events: [
        user("u1", "Run tests"),
        assistant("a1", {
          type: "tool_use",
          id: "toolu_test",
          name: "Bash",
          input: { command: "npm test" },
        }),
        result("r1", {
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_tools",
          errors: [],
        }),
      ],
    });
    expect(mapped.turnItems.map((item) => [item.type, item.status])).toEqual([
      ["user_message", "completed"],
      ["command_execution", "interrupted"],
      ["run_interrupt_result", "interrupted"],
    ]);
    expect(mapped.activity).toBe("idle");
  });

  it("knows nothing about an empty transcript", () => {
    expect(mapClaudeCloudEvents({ sessionId: SESSION, events: [] })).toEqual({
      turnItems: [],
      pendingRequest: null,
      activity: null,
    });
  });
});
