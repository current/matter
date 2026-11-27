import {
  NodeId,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };

const navigate = vi.fn();
const queries = vi.hoisted(() => ({
  servers: [] as Array<{ port: number; terminal: { threadId: string } | null }>,
  tasks: [] as Array<{ threadId: string; lastRunStatus: string }>,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Keyboard: { dismiss: () => {} },
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
vi.mock("react-native-reanimated", () => {
  const animation = { duration: () => animation, reduceMotion: () => animation };
  return {
    default: { View: ({ children }: Children) => <div>{children}</div> },
    FadeInDown: animation,
    FadeOut: animation,
    ReduceMotion: { System: "system" },
  };
});
vi.mock("../../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-symbol={name} />,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../../components/ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-provider={provider} />,
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: "servers" | "tasks" } | null) => ({
    data:
      atom === null
        ? undefined
        : atom.kind === "servers"
          ? { servers: queries.servers }
          : { tasks: queries.tasks },
  }),
}));
vi.mock("../../../state/preview", () => ({
  previewEnvironment: { discoveredServers: () => ({ kind: "servers" }) },
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { scheduledTasksLive: () => ({ kind: "tasks" }) },
}));
vi.mock("../../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../settings/settings-navigation", () => ({ openSettings: vi.fn() }));
vi.mock("../../threads/use-visible-second-clock", () => ({
  useVisibleSecondClock: () => Date.parse("2026-11-26T10:02:05.000Z"),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate }) }));

import { MatterWhisperPill } from "./MatterWhisperPill.matter";

const THREAD = ThreadId.make("thread-1");

function subagent(status: OrchestrationV2Subagent["status"]): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`agent-${status}`),
    threadId: THREAD,
    runId: null,
    origin: "app_owned",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    childThreadId: ThreadId.make(`child-${status}`),
    remoteChild: null,
    nativeTaskRef: null,
    title: "Review the diff",
    status,
    startedAt: DateTime.makeUnsafe("2026-11-26T10:00:00.000Z"),
  } as unknown as OrchestrationV2Subagent;
}

const COMMAND = {
  taskId: "dev",
  kind: "command",
  description: "vp run dev",
} as unknown as OrchestrationV2PendingBackgroundTask;

function renderPill(props: {
  subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  backgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  stop?: () => void;
}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  navigate.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <MatterWhisperPill
        environmentId={"env-1" as EnvironmentId}
        threadId={THREAD}
        subagents={props.subagents ?? []}
        backgroundTasks={props.backgroundTasks ?? []}
        providers={undefined}
        stop={{ enabled: true, pending: false, run: props.stop ?? (() => {}) }}
      />,
    ),
  );
  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (found === null) throw new Error(`No button labelled ${label}`);
    return found;
  };
  return {
    container,
    press: (label: string) => act(() => button(label).click()),
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

describe("MatterWhisperPill", () => {
  it("renders nothing while nothing runs, even with finished agents", () => {
    queries.servers = [];
    queries.tasks = [];
    using screen = renderPill({ subagents: [subagent("completed")] });
    expect(screen.container.innerHTML).toBe("");
  });

  it("opens the agents and background work sheets, and stops background work", () => {
    queries.servers = [];
    queries.tasks = [];
    const stop = vi.fn();
    using screen = renderPill({
      subagents: [subagent("running")],
      backgroundTasks: [COMMAND],
      stop,
    });
    expect(screen.container.textContent).toContain("1 running");
    expect(screen.container.textContent).toContain("2m 5s");
    expect(screen.container.querySelector('[data-provider="claudeAgent"]')).not.toBeNull();

    screen.press("1 agent running");
    expect(navigate).toHaveBeenLastCalledWith("ThreadAgents", {
      environmentId: "env-1",
      threadId: THREAD,
    });
    screen.press("1 background command");
    expect(navigate).toHaveBeenLastCalledWith("ThreadBackgroundWork", {
      environmentId: "env-1",
      threadId: THREAD,
    });
    screen.press("Stop background work");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps showing a server the thread started, with no Stop", () => {
    queries.servers = [
      { port: 5173, terminal: { threadId: THREAD } },
      { port: 3000, terminal: { threadId: "another" } },
    ];
    queries.tasks = [];
    using screen = renderPill({});
    expect(screen.container.textContent).toContain("1 server");
    expect(screen.container.querySelector('button[aria-label="Stop background work"]')).toBeNull();
    screen.press("Servers on ports 5173");
    expect(navigate).toHaveBeenLastCalledWith("ThreadBrowserPreview", {
      environmentId: "env-1",
      threadId: THREAD,
    });
  });
});
