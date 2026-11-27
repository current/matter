import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settle: vi.fn(async (_ref: unknown) => ({ _tag: "Success" as const })),
}));

const MERGED_AT = "2026-11-26T11:00:00.000Z";

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadShell: (() => ({
    projectId: ProjectId.make("project-1"),
    settledOverride: null,
    archivedAt: null,
    latestRun: null,
    pullRequests: [
      {
        host: "github.com",
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        source: "manual",
        linkedAt: MERGED_AT,
        snapshot: {
          state: "merged",
          title: "Change",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: MERGED_AT,
          syncedAt: MERGED_AT,
          mergedAt: MERGED_AT,
        },
        stack: null,
      },
    ],
  })) as never,
}));

vi.mock(import("../../hooks/useThreadActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadActions: (() => ({ settleThread: state.settle })) as never,
}));

vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentSettings: ((_environmentId: unknown, selector: (settings: unknown) => unknown) =>
    selector(DEFAULT_SERVER_SETTINGS)) as never,
}));

vi.mock(import("../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-26T12:00",
}));

import { render } from "../../../test/render";
import { MatterMergeSettlePrompt } from "./MatterMergeSettlePrompt.matter";
import { MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY } from "./matterMergeSettlePrompt.logic";

const environmentId = EnvironmentId.make("environment:test");

it("settles the thread, and Keep hides the prompt for this pull request", async () => {
  localStorage.removeItem(MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY);
  await using screen = await render(
    <MatterMergeSettlePrompt environmentId={environmentId} threadId={ThreadId.make("thread-1")} />,
  );
  await expect.element(screen.getByText("Pull request #42 merged")).toBeVisible();

  await screen.getByRole("button", { name: "Settle", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.settle).toHaveBeenCalledWith({
      environmentId,
      threadId: ThreadId.make("thread-1"),
    }),
  );

  await screen.getByRole("button", { name: "Keep", exact: true }).click();
  await expect.element(screen.getByText("Pull request #42 merged")).not.toBeInTheDocument();
  const stored = JSON.parse(localStorage.getItem(MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY) ?? "[]");
  expect(stored).toEqual([[expect.stringContaining("thread-1"), 42]]);
});
