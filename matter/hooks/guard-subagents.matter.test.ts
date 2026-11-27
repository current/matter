import { describe, expect, it } from "vite-plus/test";

import { evaluateGuard } from "./guard-subagents.mjs";

describe("matter/hooks/guard-subagents", () => {
  it("blocks Codex and stale provider IDs in delegate_task", () => {
    for (const providerInstanceId of ["codex", "codex-max", "codex-alt", "claude-alt-2"]) {
      const res = evaluateGuard({
        tool_name: "mcp__t3-code__delegate_task",
        tool_input: { target: { providerInstanceId }, role: "implementation" },
      });
      expect(res.allow).toBe(false);
    }
  });

  it("blocks Sonnet and Haiku coding subagents in delegate_task and Agent", () => {
    expect(
      evaluateGuard({
        tool_name: "mcp__t3-code__delegate_task",
        tool_input: {
          target: { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" },
          role: "implementation",
        },
      }).allow,
    ).toBe(false);

    expect(
      evaluateGuard({
        tool_name: "Agent",
        tool_input: { model: "sonnet", prompt: "edit files" },
      }).allow,
    ).toBe(false);

    expect(
      evaluateGuard({
        tool_name: "Agent",
        tool_input: { model: "haiku", subagent_type: "general-purpose", prompt: "edit files" },
      }).allow,
    ).toBe(false);
  });

  it("allows Opus, Antigravity, and read-only research/Explore subagents", () => {
    expect(
      evaluateGuard({
        tool_name: "mcp__t3-code__delegate_task",
        tool_input: {
          target: { providerInstanceId: "claude-alt", model: "claude-opus-5-5" },
          role: "implementation",
        },
      }).allow,
    ).toBe(true);

    expect(
      evaluateGuard({
        tool_name: "mcp__t3-code__delegate_task",
        tool_input: {
          target: { providerInstanceId: "antigravity", model: "gemini-4-neon" },
          role: "implementation",
        },
      }).allow,
    ).toBe(true);

    expect(
      evaluateGuard({
        tool_name: "mcp__t3-code__delegate_task",
        tool_input: {
          target: { providerInstanceId: "claudeAgent", model: "claude-sonnet-5-5" },
          role: "research",
        },
      }).allow,
    ).toBe(true);

    expect(
      evaluateGuard({
        tool_name: "Agent",
        tool_input: { model: "sonnet", subagent_type: "Explore", prompt: "search files" },
      }).allow,
    ).toBe(true);
  });
});
