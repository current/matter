import { assert, describe, it } from "@effect/vitest";

import {
  buildT3AcpInstructions,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");

    // A provider's own guidance reaches a conversation that already had the rest.
    const providerRun = (providerInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        providerInstructions: "Mark awaited shells.",
        providerInstructionsDelivered,
      });
    assert.include(providerRun(false), "Mark awaited shells.");
    assert.notInclude(providerRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(providerRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });

  it("omits ACP shell fallback when HTTP MCP is active and keeps prompts clean when system prompt carries instructions", () => {
    const httpState = {
      interactionMode: "default",
      hasT3Mcp: true,
      hasDeviceTools: false,
      includeMcpFallback: false,
    } as const;
    const stdioState = {
      interactionMode: "default",
      hasT3Mcp: true,
      hasDeviceTools: false,
      includeMcpFallback: true,
    } as const;

    assert.notInclude(buildT3AcpInstructions(httpState), "acp-mcp-call");
    assert.include(buildT3AcpInstructions(httpState), "## T3 Code orchestration");
    assert.include(buildT3AcpInstructions(stdioState), "acp-mcp-call");
    assert.notInclude(
      t3AcpPromptWithInstructions({ prompt: "Hello.", state: httpState }),
      "acp-mcp-call",
    );

    // When systemPromptState already matches, the prompt stays unwrapped (including after compaction).
    assert.equal(
      t3AcpPromptWithInstructions({
        prompt: "Hello.",
        state: httpState,
        systemPromptState: httpState,
      }),
      "Hello.",
    );

    // Switching interaction mode mid-session injects only the mode delta, not browser/orchestration.
    const switchedToPlan = t3AcpPromptWithInstructions({
      prompt: "Make a plan.",
      state: { ...httpState, interactionMode: "plan" },
      systemPromptState: httpState,
    });
    assert.include(switchedToPlan, "## T3 Code interaction mode: Plan");
    assert.notInclude(switchedToPlan, "## T3 Code orchestration");
    assert.notInclude(switchedToPlan, "## T3 Code browser");

    // Enabling device tools mid-session injects only the device section.
    const gainedDevices = t3AcpPromptWithInstructions({
      prompt: "Boot iOS.",
      state: { ...httpState, hasDeviceTools: true },
      systemPromptState: httpState,
    });
    assert.include(gainedDevices, "## T3 Code devices");
    assert.notInclude(gainedDevices, "## T3 Code orchestration");
  });
});
