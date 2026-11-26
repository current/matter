import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Tool } from "effect/ai";

import * as McpToolExposure from "./McpToolExposure.ts";
import { ToolSearchToolkit } from "./toolkits/toolSearch/tools.ts";

it("lists every delegation tool before a search, so a child can always be stopped", () => {
  const exposure = McpToolExposure.make(
    () => [],
    () => Effect.void,
  );

  for (const tool of [
    "orchestrator_capabilities",
    "delegate_task",
    "task_status",
    "task_cancel",
    McpToolExposure.TOOL_SEARCH,
  ]) {
    expect(exposure.isListed("session", tool)).toBe(true);
  }
  expect(exposure.isListed("session", "schedule_task")).toBe(false);
});

it("asks Antigravity to load tool_search up front", () => {
  const meta = Context.getOption(ToolSearchToolkit.tools.tool_search.annotations, Tool.Meta);
  expect(meta._tag === "Some" && meta.value).toEqual(McpToolExposure.ANTIGRAVITY_ALWAYS_LOAD);
});
