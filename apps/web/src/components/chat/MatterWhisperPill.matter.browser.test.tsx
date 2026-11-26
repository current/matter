import { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  subagents: [] as unknown[],
  shells: [] as unknown[],
  servers: [] as unknown[],
  providers: [] as unknown[],
  interrupts: [] as unknown[],
}));

vi.mock(import("~/state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentProviders: (() => new Map([["environment", state.providers]])) as never,
}));
vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: { subagents: state.subagents } }) as never,
  useThreadRelationshipShells: (() => state.shells) as never,
}));
vi.mock(import("~/portDiscoveryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadDiscoveredPorts: (() => state.servers) as never,
}));
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: { tasks: [] }, error: null })) as never,
}));
vi.mock(import("~/state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async (input: unknown) => {
    state.interrupts.push(input);
    return { _tag: "Success", value: undefined };
  }) as never,
}));

// The drilldowns reuse the details card's own panel; its behavior has its own tests.
vi.mock(import("./ThreadRelationshipsControl"), () => ({
  ThreadRelationshipsPanel: ((props: { showLineage: boolean; showSideChats: boolean }) => (
    <p>{props.showLineage ? "Lineage panel" : "Side chats panel"}</p>
  )) as never,
}));

import shellCss from "../../../../../antimatter/shell.css?inline";
import indexCss from "../../index.css?inline";
import { render } from "../../../test/render";
import { MattrWhisperPill, type MattrBackgroundWork } from "./MattrWhisperPill.mattr";
import { closeMattrLineagePopover, readMattrLineagePopover } from "./mattrThreadRibbon.logic";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const ENVIRONMENT = EnvironmentId.make("environment");
const THREAD = ThreadId.make("thread");

function agent(id: string, minutesAgo: number, status = "running") {
  return {
    id: NodeId.make(id),
    threadId: THREAD,
    runId: null,
    origin: "app_owned",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    childThreadId: ThreadId.make(`child-${id}`),
    nativeTaskRef: null,
    title: `Build ${id}`,
    status,
    startedAt: DateTime.makeUnsafe(NOW - minutesAgo * 60_000),
  };
}

/** The fork's styles, a fixed clock and empty fixtures, all undone when the test ends. */
function withStyles() {
  const style = document.createElement("style");
  style.textContent = `${indexCss}\n${shellCss}`;
  document.head.append(style);
  vi.setSystemTime(NOW);
  return {
    [Symbol.dispose]: () => {
      style.remove();
      vi.useRealTimers();
      closeMattrLineagePopover();
      state.subagents = [];
      state.shells = [];
      state.servers = [];
      state.providers = [];
      state.interrupts = [];
      document.documentElement.classList.remove("dark");
    },
  };
}

const idleWork: MattrBackgroundWork = { tasks: [], onStop: null, stopping: false };

describe("MattrWhisperPill", () => {
  it("renders nothing while idle", async () => {
    using _styles = withStyles();
    state.subagents = [agent("done", 30, "completed")];
    await using screen = await render(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    expect(screen.container.querySelector("[data-mattr-whisper-pill-row]")).toBeNull();
  });

  it("shows stacked avatars, the running count and the oldest timer as a 28px pill", async () => {
    using _styles = withStyles();
    state.subagents = [agent("a", 2), agent("b", 18), agent("c", 26), agent("d", 29)];
    await using screen = await render(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    const pill = page.getByRole("button", { name: "Lineage: 4 running" });
    await expect.element(pill).toBeVisible();
    await expect.element(screen.getByText("29m")).toBeVisible();
    const element = screen.container.querySelector<HTMLElement>("[data-mattr-whisper-pill]")!;
    expect(element.getBoundingClientRect().height).toBe(28);
    expect(getComputedStyle(element).borderRadius).toBe("10px");
    expect(getComputedStyle(element).fontStyle).toBe("normal");
    const avatars = screen.container.querySelectorAll<HTMLElement>("[data-mattr-whisper-avatar]");
    expect(Array.from(avatars, (avatar) => avatar.style.zIndex)).toEqual(["3", "2", "1"]);
  });

  it("opens the frosted Lineage popover with rows, Stop and Stop all", async () => {
    using _styles = withStyles();
    state.subagents = [agent("a", 2), agent("b", 18)];
    await using _screen = await render(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    await page.getByRole("button", { name: "Lineage: 2 running" }).click();
    await expect.element(page.getByText("Lineage · 2 running")).toBeVisible();
    const popup = document.querySelector<HTMLElement>("[data-mattr-lineage-popup='pill']")!;
    expect(popup.hasAttribute("data-mattr-frosted")).toBe(true);
    expect(getComputedStyle(popup).borderRadius).toBe("12px");
    await expect.element(page.getByText("Build a")).toBeVisible();
    await expect.element(page.getByText("Build b")).toBeVisible();

    // Stop appears on hover, as in the details card.
    await page.getByText("Build a").hover();
    await page.getByRole("button", { name: "Stop Build a" }).click();
    expect(state.interrupts).toEqual([
      {
        environmentId: ENVIRONMENT,
        input: { threadId: THREAD, subagentId: NodeId.make("a") },
      },
    ]);

    state.interrupts = [];
    await page.getByRole("button", { name: "Stop all" }).click();
    expect(state.interrupts).toHaveLength(2);
  });

  it("drills into previous agents and back", async () => {
    using _styles = withStyles();
    state.subagents = [agent("a", 2), agent("old", 90, "completed")];
    await using _screen = await render(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    await page.getByRole("button", { name: "Lineage: 1 running" }).click();
    await page.getByRole("button", { name: /Previous agents/ }).click();
    await expect.element(page.getByText("Lineage panel")).toBeVisible();
    await page.getByRole("button", { name: "Back to lineage" }).click();
    await expect.element(page.getByText("Lineage · 1 running")).toBeVisible();
  });

  it("lists background commands too, and Stop all stops the background work", async () => {
    using _styles = withStyles();
    const onStop = vi.fn(async () => {});
    await using _screen = await render(
      <MattrWhisperPill
        environmentId={ENVIRONMENT}
        threadId={THREAD}
        backgroundWork={{
          tasks: [{ taskId: "t", kind: "command", description: "vp run dev" } as never],
          onStop,
          stopping: false,
        }}
      />,
    );
    await page.getByRole("button", { name: "Lineage: 1 running" }).click();
    await expect.element(page.getByText("vp run dev")).toBeVisible();
    await page.getByRole("button", { name: "Stop all" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows a running dev server's port, in dark mode too", async () => {
    using _styles = withStyles();
    document.documentElement.classList.add("dark");
    state.servers = [{ pid: 1, port: 5173, terminal: null, processName: "node" }];
    await using screen = await render(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    await expect.element(screen.getByText(":5173")).toBeVisible();
    const pill = screen.container.querySelector<HTMLElement>("[data-mattr-whisper-pill]")!;
    expect(getComputedStyle(pill).backgroundColor).toBe("rgb(28, 28, 28)");
  });

  it("clears popover state when transitioning from active to idle so future runs stay closed", async () => {
    using _styles = withStyles();
    state.subagents = [agent("a", 2)];
    await using screen = await render(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    await page.getByRole("button", { name: "Lineage: 1 running" }).click();
    await expect.element(page.getByText("Lineage · 1 running")).toBeVisible();
    expect(readMattrLineagePopover().threadKey).not.toBeNull();

    // Transition active -> idle while the popover is open.
    state.subagents = [agent("a", 2, "completed")];
    await screen.rerender(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    await expect.poll(() => readMattrLineagePopover().threadKey).toBeNull();
    expect(screen.container.querySelector("[data-mattr-whisper-pill-row]")).toBeNull();
    expect(document.querySelector("[data-mattr-lineage-popup='pill']")).toBeNull();

    // Starting a new subagent later must mount the pill closed, not spontaneously open the popover.
    state.subagents = [agent("b", 1)];
    await screen.rerender(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    await expect.element(page.getByRole("button", { name: "Lineage: 1 running" })).toBeVisible();
    expect(readMattrLineagePopover().threadKey).toBeNull();
    expect(document.querySelector("[data-mattr-lineage-popup='pill']")).toBeNull();
  });

  it("shows multi-instance provider badges in both the collapsed avatars and expanded Lineage rows", async () => {
    using _styles = withStyles();
    state.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [],
      },
      {
        instanceId: "claude-alt",
        driver: "claudeAgent",
        displayName: "Claude Alt",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [],
      },
    ];
    state.subagents = [agent("main", 2), { ...agent("alt", 5), providerInstanceId: "claude-alt" }];
    await using screen = await render(
      <MattrWhisperPill environmentId={ENVIRONMENT} threadId={THREAD} backgroundWork={idleWork} />,
    );
    const pill = screen.container.querySelector<HTMLElement>("[data-mattr-whisper-pill]")!;
    expect(pill.textContent).toContain("CL");
    expect(pill.textContent).toContain("CA");

    await page.getByRole("button", { name: "Lineage: 2 running" }).click();
    await expect.element(page.getByText("Lineage · 2 running")).toBeVisible();
    const popup = document.querySelector<HTMLElement>("[data-mattr-lineage-popup='pill']")!;
    expect(popup.textContent).toContain("CL");
    expect(popup.textContent).toContain("CA");
  });
});
