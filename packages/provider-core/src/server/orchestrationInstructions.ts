import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: if a \`<mattr_delegation>\` block is present, follow it; otherwise use your native tool when the child uses your provider, a model it offers and no settings beyond yours (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), or \`delegate_task\` by name. A native type on another provider's model counts too. Background agent: \`delegate_task\`, never a background \`Agent\`. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked or fall back to native tools, Workflow or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Don't poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- As a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`. Honor a requested base. Otherwise independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. Required unpublished commits and dependent work use their local base. Shell worktrees don't bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it. Asked to settle a thread, this one too: \`t3_thread_organize\`.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` and that machine's \`threadId\` to T3 tools.
- Unlinked ("delegate this to my vps"): \`t3_environment_link\` with a \`hint\` from the user's words, never a pairing code in chat. No link tools: say to enable Settings → Labs → Linked environments.
- In your reply, mention a thread by its \`link\`, verbatim, never a plain title or bare id.
- A login, token, PIN, pairing code or sudo password only the user can give: call \`request_secret\`, not a chat ask or a handoff. Not for access you have. Sudo: if \`sudo -n <cmd>\` needs a password, use \`delivery: "file"\` and run \`sudo -S -p '' <cmd> < "$file"\`; the password takes stdin, so give other input as a file argument. Asked only to schedule: \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart and show any visual the user asks for here: pass an HTML file path or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description doesn't show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Don't repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device another way (ssh, simctl, a project script), skip these tools or close another session only when the user explicitly asks, and then do it. A recipe in a task you were delegated is not that ask. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session unless the user explicitly asked; if it still fails, tell the user and stop, unless they explicitly asked for another route. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. On Windows, run \`T3_ACP_MCP_CALL\` instead and pipe the JSON to stdin, as in PowerShell \`'{}' | & $env:T3_ACP_MCP_CALL orchestrator_capabilities -\`, writing non-ASCII characters as \`\\uXXXX\` escapes.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  /** False when T3 MCP is connected directly over HTTP, so the shell fallback is inapplicable. */
  readonly includeMcpFallback?: boolean;
}

/** ACP agents only know Plan and Default; mattr's Goal runs in the agent's Default mode. */
export const acpEffectiveInteractionMode = (mode: ProviderInteractionMode): "plan" | "default" =>
  mode === "plan" ? "plan" : "default";

const acpInstructionStatesEqual = (
  left: T3AcpInstructionState | undefined,
  right: T3AcpInstructionState,
): boolean =>
  left !== undefined &&
  acpEffectiveInteractionMode(left.interactionMode) ===
    acpEffectiveInteractionMode(right.interactionMode) &&
  left.hasT3Mcp === right.hasT3Mcp &&
  left.hasDeviceTools === right.hasDeviceTools &&
  (left.includeMcpFallback ?? true) === (right.includeMcpFallback ?? true);

export function buildT3AcpInstructions(state: T3AcpInstructionState): string {
  const instructions = [
    state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          ...(state.includeMcpFallback === false ? [] : [T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS]),
        ]
      : []),
  ];
  return instructions.join("\n\n");
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
  /** Session-invariant state already delivered in the agent's native system prompt. */
  readonly systemPromptState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (acpInstructionStatesEqual(input.previousState, input.state)) {
    return input.prompt;
  }
  if (input.systemPromptState !== undefined) {
    const baseline = input.previousState ?? input.systemPromptState;
    const delta: Array<string> = [];
    if (
      acpEffectiveInteractionMode(baseline.interactionMode) !==
      acpEffectiveInteractionMode(input.state.interactionMode)
    ) {
      delta.push(
        input.state.interactionMode === "plan"
          ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
          : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
      );
    }
    const mcpAlreadyDelivered =
      input.systemPromptState.hasT3Mcp || input.previousState?.hasT3Mcp === true;
    const devicesAlreadyDelivered =
      (input.systemPromptState.hasT3Mcp && input.systemPromptState.hasDeviceTools) ||
      (input.previousState?.hasT3Mcp === true && input.previousState.hasDeviceTools);
    if (input.state.hasT3Mcp && !mcpAlreadyDelivered) {
      delta.push(
        T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
        ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
        T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
        ...(input.state.includeMcpFallback === false
          ? []
          : [T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS]),
      );
    } else if (input.state.hasT3Mcp && input.state.hasDeviceTools && !devicesAlreadyDelivered) {
      delta.push(T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    }
    if (delta.length === 0) return input.prompt;
    return `<t3_code_instructions>\n${delta.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
  }
  return `<t3_code_instructions>\n${buildT3AcpInstructions(input.state)}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
  /** Guidance for this provider's own tools, sent until `providerInstructionsDelivered`. */
  readonly providerInstructions?: string;
  readonly providerInstructionsDelivered?: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  const instructions = [
    !input.orchestrationDelivered
      ? orchestrationInstructions(input.hasDeviceTools)
      : input.hasDeviceTools && !input.deviceInstructionsDelivered
        ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS
        : undefined,
    input.providerInstructionsDelivered === true ? undefined : input.providerInstructions,
  ].flatMap((part) => (part === undefined ? [] : [part.trim()]));
  return instructions.length === 0
    ? input.prompt
    : prependT3OrchestrationInstructions(input.prompt, instructions.join("\n\n"));
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}

// mattr: providers without a native `/goal` get Goal mode as a block after the user's words, so
// compaction cannot drop it. Plan, and Goal on native-goal providers, add nothing to the prompt.
const MATTR_GOAL_MODE_INSTRUCTIONS = `Treat this request as a goal to finish end to end, not a single step.
- Break it into milestones and keep a \`- [ ]\` checklist current as you work.
- Keep going through implementation, edge cases, tests, verification and a self-review. Don't stop for check-ins you can resolve yourself.
- Run independent pieces in parallel with subagents when that is faster.
- Stop only when the goal is verified complete or you are blocked on a user decision, secret or credential. Then say what is done and what is left.`;

/** Appends mattr's fallback Goal block for a provider without native `/goal`; anything else passes through. */
export function withMattrGoalModeInstructions(
  text: string,
  mode: ProviderInteractionMode,
  nativeGoals: boolean,
): string {
  return mode !== "goal" || nativeGoals || text.trim() === ""
    ? text
    : `${text}\n\n<mattr_goal_mode>\n${MATTR_GOAL_MODE_INSTRUCTIONS}\n</mattr_goal_mode>`;
}
