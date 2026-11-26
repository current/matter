import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ThreadId,
  type ProjectScript,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  pullRequests: [] as unknown[],
  subagents: [] as unknown[],
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "project",
          environmentId: "environment",
          title: "mattr",
          workspaceRoot: "/repo",
          scripts: [],
        }) as never,
  useProjects: (() => []) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "thread",
          environmentId: "environment",
          projectId: "project",
          worktreePath: null,
          branch: "main",
          pullRequests: state.pullRequests,
        }) as never,
  useQuietThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: { subagents: state.subagents } }) as never,
  useThreadRelationshipShells: (() => []) as never,
  useServerConfigs: (() =>
    new Map([
      [
        EnvironmentId.make("environment"),
        {
          scratchWorkspaceRoot: "/home/user/.t3/scratch",
          environment: { capabilities: { pullRequests: true } },
        },
      ],
    ])) as never,
}));
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const repoWithChanges = Atom.make(
    AsyncResult.success({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "a.ts", insertions: 5, deletions: 0 }],
        insertions: 5,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => repoWithChanges) as never },
  };
});
vi.mock(import("./MattrWhisperPill.mattr"), async (importOriginal) => ({
  ...(await importOriginal()),
  useMattrThreadAutomationCounts: (() => ({ bound: 0, running: 0 })) as never,
}));

import { useRef, useState, type CSSProperties } from "react";
import shellCss from "../../../../../antimatter/shell.css?inline";
import indexCss from "../../index.css?inline";
import { act, render } from "../../../test/render";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { createChatCanvasStore } from "./canvasStore";
import { ChatCanvas } from "./ChatCanvas";
import { MattrThreadRibbon } from "./MattrThreadRibbon.mattr";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { closeMattrLineagePopover, writeMattrThreadRibbon } from "./mattrThreadRibbon.logic";

const ENVIRONMENT = EnvironmentId.make("environment");
const THREAD = ThreadId.make("thread");
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 142,
  url: "https://github.com/pingdotgg/t3code/pull/142",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};
const devScript: ProjectScript = {
  id: "dev",
  name: "dev",
  command: "vp run dev",
  icon: "play",
  runOnWorktreeCreate: false,
};

function finishedAgent(id: string) {
  return {
    id: NodeId.make(id),
    threadId: THREAD,
    status: "completed",
    childThreadId: ThreadId.make(`child-${id}`),
  };
}

/** The fork's styles and empty fixtures, undone when the test ends. */
function withStyles() {
  const style = document.createElement("style");
  style.textContent = `${indexCss}\n${shellCss}`;
  document.head.append(style);
  return {
    [Symbol.dispose]: () => {
      style.remove();
      closeMattrLineagePopover();
      writeMattrThreadRibbon(false);
      state.pullRequests = [];
      state.subagents = [];
      useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
      document.documentElement.classList.remove("dark");
    },
  };
}

function Ribbon({
  width,
  paddingLeft = 0,
  controlsWidth = 0,
  rightPanelOpen = false,
  onToggleChanges,
}: {
  width: number;
  paddingLeft?: number;
  controlsWidth?: number;
  rightPanelOpen?: boolean;
  onToggleChanges?: () => void;
}) {
  const result = async () => ({ ok: true }) as never;
  return (
    <div style={{ position: "relative", width }}>
      {controlsWidth > 0 ? (
        <div
          data-workspace-titlebar-controls
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: controlsWidth,
            height: 38,
          }}
        />
      ) : null}
      <header
        data-chat-header
        style={{
          display: "flex",
          alignItems: "center",
          boxSizing: "border-box",
          width,
          height: 38,
          paddingLeft,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>Verify Shipped mattr</div>
        <MattrThreadRibbon
          environmentId={ENVIRONMENT}
          threadId={THREAD}
          projectId={ProjectId.make("project")}
          worktreePath={null}
          isServerThread
          composerDraftTarget={{ environmentId: ENVIRONMENT, threadId: THREAD }}
          activeProjectName="mattr"
          activeProjectScripts={[devScript]}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={["cursor"]}
          showOpenInPicker
          openInShortcutEnabled={false}
          gitCwd="/repo"
          workspaceMutationId={null}
          isGitRepo
          onRunProjectScript={() => {}}
          onAddProjectScript={result}
          onUpdateProjectScript={result}
          onDeleteProjectScript={result}
          {...(onToggleChanges ? { onToggleChanges } : {})}
          backgroundWork={{ tasks: [], onStop: null, stopping: false }}
          rightPanelOpen={rightPanelOpen}
        />
      </header>
    </div>
  );
}

function DesktopCanvasHarness() {
  const [store] = useState(createChatCanvasStore);
  const [handle] = useState(PopoverCreateHandle);
  const headerRef = useRef<HTMLElement | null>(null);
  const threadRef = { environmentId: ENVIRONMENT, threadId: THREAD };
  const result = async () => ({ ok: true }) as never;
  return (
    <div
      style={
        {
          "--chat-content-max-width": "48rem",
          "--html-preview-max-width": "48rem",
          display: "flex",
          flexDirection: "column",
          width: 1440,
          height: 820,
        } as CSSProperties
      }
    >
      <header
        ref={headerRef}
        data-chat-header
        style={{ display: "flex", alignItems: "center", width: 1440, height: 38, flexShrink: 0 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>Wide desktop thread</div>
        <MattrThreadRibbon
          environmentId={ENVIRONMENT}
          threadId={THREAD}
          projectId={ProjectId.make("project")}
          worktreePath={null}
          isServerThread
          composerDraftTarget={{ environmentId: ENVIRONMENT, threadId: THREAD }}
          activeProjectName="mattr"
          activeProjectScripts={[devScript]}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={["cursor"]}
          showOpenInPicker
          openInShortcutEnabled={false}
          gitCwd="/repo"
          workspaceMutationId={null}
          isGitRepo
          onRunProjectScript={() => {}}
          onAddProjectScript={result}
          onUpdateProjectScript={result}
          onDeleteProjectScript={result}
          backgroundWork={{ tasks: [], onStop: null, stopping: false }}
          rightPanelOpen={false}
        />
      </header>
      <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0 }}>
        <ChatCanvas
          store={store}
          rightPanelOpen={false}
          threadRef={threadRef}
          preview={null}
          composerOverlayElement={null}
        >
          <div style={{ flex: 1 }}>Messages</div>
          <ThreadDetailsCard
            threadRef={threadRef}
            anchor={headerRef}
            handle={handle}
            contentKey="details"
          >
            {() => <div style={{ height: 240 }}>Full thread details content</div>}
          </ThreadDetailsCard>
        </ChatCanvas>
      </div>
    </div>
  );
}

describe("MattrThreadRibbon", () => {
  it("shows diff, editor, actions and git chips, 26px tall, with the quiet agents button", async () => {
    using _styles = withStyles();
    state.subagents = [finishedAgent("a"), finishedAgent("b"), finishedAgent("c")];
    const onToggleChanges = vi.fn();
    await using screen = await render(<Ribbon width={1200} onToggleChanges={onToggleChanges} />);
    const ribbon = screen.container.querySelector<HTMLElement>("[data-mattr-ribbon]")!;
    await expect.element(page.getByRole("group", { name: /Git actions/ })).toBeVisible();
    await expect.element(page.getByRole("group", { name: "Open in editor" })).toBeVisible();
    await expect.element(page.getByRole("group", { name: "Project scripts" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Agents: 3 previous" })).toBeVisible();
    expect(ribbon.dataset.density).toBe("full");

    const diff = ribbon.querySelector<HTMLElement>("[data-mattr-ribbon-slot='diff'] > button")!;
    expect(diff.textContent).toContain("+5");
    expect(diff.getBoundingClientRect().height).toBe(26);
    diff.click();
    expect(onToggleChanges).toHaveBeenCalledTimes(1);

    const git = ribbon.querySelector<HTMLElement>(
      "[data-mattr-ribbon-slot='git'] > [role='group']",
    )!;
    expect(git.getBoundingClientRect().height).toBe(26);
    expect(getComputedStyle(git).borderRadius).toBe("7px");
    expect(getComputedStyle(ribbon).fontStyle).toBe("normal");
  });

  it("shows a linked pull request chip that opens its rows in a frosted popover", async () => {
    using _styles = withStyles();
    state.pullRequests = [linkedPullRequest];
    await using _screen = await render(<Ribbon width={1200} />);
    const chip = page.getByRole("button", { name: "Pull request #142" });
    await expect.element(chip).toBeVisible();
    await chip.click();
    const popup = document.querySelector<HTMLElement>("[data-mattr-ribbon-popup='pr']")!;
    await expect.element(page.getByText(/#142/).last()).toBeVisible();
    expect(popup.hasAttribute("data-mattr-frosted")).toBe(true);
  });

  it("opens the Lineage popover from the agents button", async () => {
    using _styles = withStyles();
    state.subagents = [finishedAgent("a")];
    await using _screen = await render(<Ribbon width={1200} />);
    await page.getByRole("button", { name: "Agents: 1 previous" }).click();
    await expect.element(page.getByText("Lineage", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Previous agents/ })).toBeVisible();
  });

  it("keeps the full card one click away and the classic card a setting away", async () => {
    using _styles = withStyles();
    await using _screen = await render(<Ribbon width={1200} />);
    await page.getByRole("button", { name: "More thread actions" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Choose what to show" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Use the classic details card" }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: "All thread details" }).click();
    expect(
      selectThreadPanelOpen(
        useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
        { environmentId: ENVIRONMENT, threadId: THREAD },
        "popover",
      ),
    ).toBe(true);
  });

  it("moves secondary chips into More as the header narrows", async () => {
    using _styles = withStyles();
    state.pullRequests = [linkedPullRequest];
    await using screen = await render(<Ribbon width={620} />);
    const ribbon = screen.container.querySelector<HTMLElement>("[data-mattr-ribbon]")!;
    await expect.poll(() => ribbon.dataset.density).toBe("condensed");
    await expect
      .element(page.getByRole("group", { name: "Open in editor" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Pull request #142" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("group", { name: /Git actions/ })).toBeVisible();
    await page.getByRole("button", { name: "More thread actions" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Open in…" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /Pull request #142/ })).toBeVisible();
  });

  it("stays upright in dark mode", async () => {
    using _styles = withStyles();
    document.documentElement.classList.add("dark");
    await using screen = await render(<Ribbon width={1200} />);
    await expect.element(page.getByRole("group", { name: /Git actions/ })).toBeVisible();
    for (const element of screen.container.querySelectorAll<HTMLElement>("[data-mattr-ribbon] *")) {
      expect(getComputedStyle(element).fontStyle).toBe("normal");
    }
  });

  it("suppresses the docked inline card on wide desktop viewports and opens All thread details as a popover", async () => {
    using _styles = withStyles();
    await page.viewport(1440, 900);
    writeMattrThreadRibbon(true);
    await using screen = await render(<DesktopCanvasHarness />);

    await expect.element(page.getByRole("button", { name: "More thread actions" })).toBeVisible();
    expect(document.querySelector('[data-thread-details-panel="inline"]')).toBeNull();
    expect(document.querySelector('[data-thread-details-panel="popover"]')).toBeNull();

    // Open via More menu -> All thread details.
    await page.getByRole("button", { name: "More thread actions" }).click();
    await page.getByRole("menuitem", { name: "All thread details" }).click();
    await expect.element(page.getByText("Full thread details content")).toBeVisible();
    expect(document.querySelector('[data-thread-details-panel="popover"]')).not.toBeNull();
    expect(document.querySelector('[data-thread-details-panel="inline"]')).toBeNull();

    // Close and reopen via right-click context menu -> All thread details.
    await act(() =>
      useRightPanelStore
        .getState()
        .setThreadPanelOpen({ environmentId: ENVIRONMENT, threadId: THREAD }, "popover", false),
    );
    await expect.element(page.getByText("Full thread details content")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "All thread details" }))
      .not.toBeInTheDocument();

    const ribbon = screen.container.querySelector<HTMLElement>("[data-mattr-ribbon]")!;
    ribbon.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 600, clientY: 20 }),
    );
    await page.getByRole("menuitem", { name: "All thread details" }).click();
    await expect.element(page.getByText("Full thread details content")).toBeVisible();
    expect(document.querySelector('[data-thread-details-panel="popover"]')).not.toBeNull();
    expect(document.querySelector('[data-thread-details-panel="inline"]')).toBeNull();
  });

  it("measures available width minus collapsed-sidebar padding and titlebar controls, and tracks control resizes", async () => {
    using _styles = withStyles();
    await using screen = await render(
      <Ribbon width={960} paddingLeft={204} controlsWidth={100} rightPanelOpen={false} />,
    );
    const ribbon = screen.container.querySelector<HTMLElement>("[data-mattr-ribbon]")!;
    // 960 - 204 - (100 + 8) = 648px available -> condensed (not full).
    await expect.poll(() => ribbon.dataset.density).toBe("condensed");
    expect(ribbon.style.getPropertyValue("--mattr-ribbon-controls-inset")).toBe("108px");

    // Resizing the controls updates the inset and available width without a header resize.
    const controls = screen.container.querySelector<HTMLElement>(
      "[data-workspace-titlebar-controls]",
    )!;
    controls.style.width = "180px";
    await expect
      .poll(() => ribbon.style.getPropertyValue("--mattr-ribbon-controls-inset"))
      .toBe("188px");

    // Opening the right panel moves the controls off the header, clearing the inset.
    await screen.rerender(
      <Ribbon width={960} paddingLeft={204} controlsWidth={180} rightPanelOpen />,
    );
    await expect
      .poll(() => ribbon.style.getPropertyValue("--mattr-ribbon-controls-inset"))
      .toBe("0px");
    // 960 - 204 = 756px available -> compact.
    await expect.poll(() => ribbon.dataset.density).toBe("compact");
  });
});
