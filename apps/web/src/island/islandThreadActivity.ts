import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";

import type { IslandActivity, IslandPlanProgress } from "../../../../matter/island/types";

const MAX_RECENT_ACTIVITIES = 3;
const MAX_LABEL_LENGTH = 72;

export interface IslandThreadPreview {
  readonly latestUserMessage: string | null;
  readonly latestAssistantMessage: string | null;
  readonly toolCallCount: number;
  readonly isStreaming: boolean;
  readonly currentActivity: IslandActivity | null;
  readonly recentActivities: ReadonlyArray<IslandActivity>;
  readonly plan: IslandPlanProgress | null;
}

export const EMPTY_ISLAND_THREAD_PREVIEW: IslandThreadPreview = {
  latestUserMessage: null,
  latestAssistantMessage: null,
  toolCallCount: 0,
  isStreaming: false,
  currentActivity: null,
  recentActivities: [],
  plan: null,
};

function truncateText(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function isRunningStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return status === "running" || status === "pending" || status === "waiting";
}

/** Short, provider-titled label for a tool turn item; null for non-tool items. */
export function describeToolItem(item: OrchestrationV2TurnItem): IslandActivity | null {
  const running = isRunningStatus(item.status);
  const titled = (kind: IslandActivity["kind"], fallback: string): IslandActivity | null => {
    const label = truncateText(item.title?.trim() || fallback, MAX_LABEL_LENGTH);
    return label ? { kind, label, running } : null;
  };
  switch (item.type) {
    case "command_execution":
      return titled("command", item.input.split("\n")[0] ?? "");
    case "file_change":
      return titled("edit", basename(item.fileName));
    case "file_search":
      return titled("search", item.pattern ?? "");
    case "web_search":
      return titled("web", item.patterns?.[0] ?? "");
    case "subagent":
      return titled("agent", item.progress ?? item.prompt.split("\n")[0] ?? "");
    case "dynamic_tool": {
      const name = item.toolName ?? "";
      const kind = /read|view|open/i.test(name) ? "read" : "tool";
      return titled(kind, name);
    }
    default:
      return null;
  }
}

function summarizePlan(item: OrchestrationV2TurnItem): IslandPlanProgress | null {
  if (item.type !== "todo_list" || item.steps.length === 0) return null;
  let completed = 0;
  let currentStep: string | null = null;
  for (const step of item.steps) {
    if (step.status === "completed") completed += 1;
    else if (currentStep === null && step.status === "running") currentStep = step.text;
  }
  return {
    completed,
    total: item.steps.length,
    currentStep: currentStep === null ? null : truncateText(currentStep, MAX_LABEL_LENGTH),
  };
}

export function summarizeThreadProjection(
  projection: OrchestrationV2ThreadProjection | null,
): IslandThreadPreview {
  if (!projection) return EMPTY_ISLAND_THREAD_PREVIEW;

  let latestUserMessage: string | null = null;
  let latestAssistantMessage: string | null = null;
  let isStreaming = false;
  let latestRunId: string | null = null;

  for (let i = projection.messages.length - 1; i >= 0; i -= 1) {
    const message = projection.messages[i];
    if (!message) continue;
    if (latestAssistantMessage === null && message.role === "assistant" && message.text.trim()) {
      latestAssistantMessage = truncateText(message.text, 520);
      isStreaming = message.streaming;
      if (latestRunId === null && message.runId) latestRunId = message.runId;
    }
    if (latestUserMessage === null && message.role === "user" && message.text.trim()) {
      latestUserMessage = truncateText(message.text, 240);
      if (latestRunId === null && message.runId) latestRunId = message.runId;
    }
    if (latestUserMessage !== null && latestAssistantMessage !== null) break;
  }

  const targetRunId = projection.runs.at(-1)?.id ?? latestRunId;
  let toolCallCount = 0;
  let plan: IslandPlanProgress | null = null;
  const activities: IslandActivity[] = [];
  for (const visible of projection.visibleTurnItems) {
    const item = visible.item;
    if (targetRunId && item.runId && item.runId !== targetRunId) {
      // Plans outlive the run that wrote them, so keep the newest one from any run.
      if (item.type === "todo_list") plan = summarizePlan(item) ?? plan;
      continue;
    }
    if (item.type === "todo_list") {
      plan = summarizePlan(item) ?? plan;
      continue;
    }
    const activity = describeToolItem(item);
    if (!activity) continue;
    toolCallCount += 1;
    activities.push(activity);
  }

  let currentActivity: IslandActivity | null = null;
  for (let i = activities.length - 1; i >= 0; i -= 1) {
    if (activities[i]?.running) {
      currentActivity = activities[i] ?? null;
      activities.splice(i, 1);
      break;
    }
  }
  const recentActivities = activities.slice(-MAX_RECENT_ACTIVITIES).toReversed();

  return {
    latestUserMessage,
    latestAssistantMessage,
    toolCallCount,
    isStreaming,
    currentActivity,
    recentActivities,
    plan,
  };
}
