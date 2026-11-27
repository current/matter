import type { ClaudeCloudPendingRequest, OrchestrationV2TurnItem } from "@t3tools/contracts";

export type ClaudeCloudTranscriptActivity = "running" | "idle" | "needs_input" | "failed";

export interface MapClaudeCloudEventsInput {
  readonly sessionId: string;
  readonly events: ReadonlyArray<unknown>;
}

export interface MapClaudeCloudEventsResult {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly pendingRequest: ClaudeCloudPendingRequest | null;
  readonly activity: ClaudeCloudTranscriptActivity | null;
}

export function mapClaudeCloudEvents(
  _input: MapClaudeCloudEventsInput,
): MapClaudeCloudEventsResult {
  return {
    turnItems: [],
    pendingRequest: null,
    activity: null,
  };
}
