#!/usr/bin/env node
// PreToolUse guard for Matter's subagent & delegation rules (matter/CONTEXT.md).
// Deterministic, 0 context tokens: blocks disallowed Codex delegation and Sonnet/Haiku coding subagents.

import * as NodeFS from "node:fs";

const DISALLOWED_PROVIDERS = new Set(["codex", "codex-max", "codex-alt", "claude-alt-2"]);
const READ_ONLY_AGENT_TYPES = new Set(["Explore", "Plan", "statusline-setup"]);
const CHEAP_CLAUDE_RE = /\b(sonnet|haiku)\b/i;

export function evaluateGuard(payload) {
  const toolName = String(payload?.tool_name ?? "");
  const input = payload?.tool_input ?? {};

  if (toolName === "delegate_task" || toolName.endsWith("__delegate_task")) {
    const provider = String(input?.target?.providerInstanceId ?? "").trim();
    const model = String(input?.target?.model ?? "").trim();
    const role = String(input?.role ?? "")
      .trim()
      .toLowerCase();

    if (
      provider &&
      (DISALLOWED_PROVIDERS.has(provider.toLowerCase()) || /^codex\b/i.test(provider))
    ) {
      return {
        allow: false,
        reason: `Matter workflow guard: "${provider}" is disallowed for delegation in Matter (matter/CONTEXT.md). Balance across claudeAgent, claude-alt (claude-opus-5-5), and antigravity (gemini-4-neon, high).`,
      };
    }

    if (model && CHEAP_CLAUDE_RE.test(model) && role !== "research") {
      return {
        allow: false,
        reason: `Matter workflow guard: Claude coding subagents must use claude-opus-5-5, never "${model}" (matter/CONTEXT.md).`,
      };
    }
    return { allow: true };
  }

  if (toolName === "Agent") {
    const model = String(input?.model ?? "").trim();
    const subagentType = String(input?.subagent_type ?? "").trim();
    if (model && CHEAP_CLAUDE_RE.test(model) && !READ_ONLY_AGENT_TYPES.has(subagentType)) {
      return {
        allow: false,
        reason: `Matter workflow guard: Claude coding subagents must use opus (claude-opus-5-5), never "${model}" (matter/CONTEXT.md). Use subagent_type="Explore" for read-only lookups.`,
      };
    }
    return { allow: true };
  }

  return { allow: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  try {
    raw = NodeFS.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  if (!raw.trim()) process.exit(0);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const decision = evaluateGuard(payload);
  if (!decision.allow) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      }),
    );
  }
  process.exit(0);
}
