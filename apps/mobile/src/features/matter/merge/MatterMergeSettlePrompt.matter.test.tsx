import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const mocks = vi.hoisted(() => ({
  settleThread: vi.fn(async (_thread: unknown) => true),
  written: [] as string[],
}));

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: Children & { onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => (
    <button
      type="button"
      disabled={disabled}
      aria-label={accessibilityLabel}
      onClick={disabled ? undefined : onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: Children) => <div>{children}</div> },
  FadeInDown: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
}));
vi.mock("../../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-symbol={name} />,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../../lib/clock", () => ({ useNowMinuteMs: () => NOW }));
vi.mock("../../home/useThreadListActions", () => ({
  useThreadListActions: () => ({ settleThread: mocks.settleThread }),
}));
vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  File: class {
    exists = false;
    async text() {
      return "";
    }
  },
}));
vi.mock("../../../lib/atomic-file", () => ({
  writeFileAtomically: async (_file: unknown, contents: string) => {
    mocks.written.push(contents);
  },
}));

import { MatterMergeSettlePrompt } from "./MatterMergeSettlePrompt.matter";

function mergedThread(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: "env-1",
    id: "thread-1",
    projectId: "project-1",
    settledOverride: null,
    unsettledAt: null,
    archivedAt: null,
    latestRun: null,
    pullRequests: [
      {
        host: "github.com",
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        source: "manual",
        linkedAt: isoAt(NOW - 10 * HOUR),
        snapshot: {
          state: "merged",
          title: "Change",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: isoAt(NOW - HOUR),
          syncedAt: isoAt(NOW),
          mergedAt: isoAt(NOW - HOUR),
        },
        stack: null,
      },
    ],
    ...overrides,
  } as never;
}

const serverConfig = { settings: DEFAULT_SERVER_SETTINGS } as unknown as ServerConfig;

async function render(thread = mergedThread(), canOperateThread = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MatterMergeSettlePrompt
        thread={thread}
        serverConfig={serverConfig}
        canOperateThread={canOperateThread}
      />,
    );
  });
  return { container, root };
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);

describe("MatterMergeSettlePrompt", () => {
  it("asks once the thread's pull request merged and settles on Settle", async () => {
    const { container, root } = await render();
    expect(container.textContent).toContain("Pull request #42 merged");
    await act(async () => button(container, "Settle")?.click());
    expect(mocks.settleThread).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("stays quiet for a thread the viewer can't operate or that is still running", async () => {
    const readOnly = await render(mergedThread(), false);
    expect(readOnly.container.textContent).toBe("");
    const running = await render(
      mergedThread({ latestRun: { runId: "run-1", status: "running", startedAt: null } }),
    );
    expect(running.container.textContent).toBe("");
    act(() => {
      readOnly.root.unmount();
      running.root.unmount();
    });
  });

  it("remembers Keep for this thread and pull request", async () => {
    const { container, root } = await render();
    await act(async () => button(container, "Keep")?.click());
    expect(container.textContent).toBe("");
    expect(mocks.written.at(-1)).toBe(JSON.stringify([["env-1:thread-1", 42]]));
    act(() => root.unmount());

    const again = await render();
    expect(again.container.textContent).toBe("");
    act(() => again.root.unmount());
  });
});
