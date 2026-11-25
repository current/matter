import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2GetNativeChildWorkResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";

const mockState = vi.hoisted(() => ({
  data: null as OrchestrationV2GetNativeChildWorkResult | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
}));

vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    nativeChildWork: () => ({}),
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mockState.data,
    dataUpdatedAt: 0,
    error: mockState.error,
    failure: null,
    isPending: mockState.isPending,
    isSuccess: mockState.data !== null,
    refresh: mockState.refresh,
  }),
}));

import { NativeChildWorkTimeline } from "./NativeChildWorkTimeline";

function setupMock(data: OrchestrationV2GetNativeChildWorkResult | null) {
  mockState.data = data;
  mockState.error = null;
  mockState.isPending = false;
  mockState.refresh.mockReset();
}

describe("NativeChildWorkTimeline", () => {
  it("renders paired tool calls, assistant updates, and expands tool details on click", async () => {
    setupMock({
      children: [
        {
          conversationId: "child-1",
          role: "Voice Mode Builder",
          prompt: "Build voice mode",
          truncated: false,
          steps: [
            {
              index: 1,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              text: null,
              toolCalls: [
                {
                  name: "read_file",
                  input: JSON.stringify({ Path: "/repo/apps/web/src/ChatView.tsx" }),
                },
                {
                  name: "edit_file",
                  input: JSON.stringify({ Path: "/repo/apps/web/src/ChatView.tsx" }),
                },
              ],
            },
            {
              index: 2,
              type: "GENERIC",
              status: "DONE",
              text: "Created At: 2026-11-25T11:40:00-06:00\nShowing lines 1-40",
              toolCalls: [],
            },
            {
              index: 3,
              type: "GENERIC",
              status: "DONE",
              text: "Created At: 2026-11-25T11:40:01-06:00\nMade 1 replacement",
              toolCalls: [],
            },
            {
              index: 4,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              text: "All tests pass and ready for review.",
              toolCalls: [],
            },
          ],
        },
      ],
    });

    await using screen = await render(
      <NativeChildWorkTimeline
        environmentId={EnvironmentId.make("env-1")}
        threadId={ThreadId.make("thread-subagent-1")}
        isLive={false}
        workspaceRoot="/repo"
      />,
    );

    await expect.element(screen.getByText("Subagent work")).toBeVisible();
    await expect.element(screen.getByText("All tests pass and ready for review.")).toBeVisible();

    const readRow = screen.getByRole("button", { name: /Read/ });
    await readRow.click();
    await expect.element(screen.getByText("Showing lines 1-40")).toBeVisible();

    const editRow = screen.getByRole("button", { name: /Edit/ });
    await editRow.click();
    await expect.element(screen.getByText("Made 1 replacement")).toBeVisible();
  });

  it("polls while live and refreshes once when transitioning to settled", async () => {
    using _timers = fakeTimers();
    setupMock({
      children: [
        {
          conversationId: "child-1",
          role: "Worker",
          prompt: "Investigate bug",
          truncated: false,
          steps: [
            {
              index: 1,
              type: "PLANNER_RESPONSE",
              status: "RUNNING",
              text: null,
              toolCalls: [
                {
                  name: "run_command",
                  input: JSON.stringify({ toolSummary: "Run typecheck" }),
                },
              ],
            },
          ],
        },
      ],
    });

    await using screen = await render(
      <NativeChildWorkTimeline
        environmentId={EnvironmentId.make("env-1")}
        threadId={ThreadId.make("thread-subagent-1")}
        isLive
      />,
    );

    await expect.element(screen.getByText("Run typecheck")).toBeVisible();
    expect(mockState.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_600);
    expect(mockState.refresh).toHaveBeenCalledTimes(1);

    await screen.rerender(
      <NativeChildWorkTimeline
        environmentId={EnvironmentId.make("env-1")}
        threadId={ThreadId.make("thread-subagent-1")}
        isLive={false}
      />,
    );
    expect(mockState.refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockState.refresh).toHaveBeenCalledTimes(2);
  });
});
