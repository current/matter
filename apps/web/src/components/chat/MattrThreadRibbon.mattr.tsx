import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { T, useGT, Var } from "gt-react";
import {
  BotIcon,
  CircleDotIcon,
  EllipsisIcon,
  FileDiffIcon,
  PanelRightIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { useClientSettings } from "../../hooks/useSettings";
import { observeResize } from "../../lib/observeResize";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProject, useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl from "../ProjectScriptsControl";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useThreadDisplayedPullRequest } from "../ThreadStatusIndicators";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { OpenInPicker } from "./OpenInPicker";
import type { ThreadDetailsPanelProps } from "./ThreadDetailsPanel";
import { ThreadDetailsIssueRows } from "./ThreadDetailsIssueRows";
import { ThreadDetailsItemsMenuItems } from "./ThreadDetailsItemsMenu";
import { ThreadDetailsThreadPrRows } from "./ThreadDetailsPrRows";
import { resolveThreadDetailsVisibility } from "./threadDetailsItems";
import {
  MattrLineagePopover,
  type MattrBackgroundWork,
  useMattrLineageModel,
  useMattrThreadAutomationCounts,
} from "./MattrWhisperPill.mattr";
import {
  closeMattrLineagePopover,
  type MattrRibbonDensity,
  mattrRibbonOverflows,
  resolveMattrRibbonDensity,
  useMattrLineagePopover,
  writeMattrThreadRibbon,
} from "./mattrThreadRibbon.logic";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";

export type MattrThreadRibbonProps = Pick<
  ThreadDetailsPanelProps,
  | "environmentId"
  | "threadId"
  | "projectId"
  | "worktreePath"
  | "isServerThread"
  | "draftId"
  | "composerDraftTarget"
  | "activeProjectName"
  | "activeProjectScripts"
  | "preferredScriptId"
  | "keybindings"
  | "availableEditors"
  | "showOpenInPicker"
  | "openInShortcutEnabled"
  | "gitCwd"
  | "workspaceMutationId"
  | "isGitRepo"
  | "onRunProjectScript"
  | "onAddProjectScript"
  | "onUpdateProjectScript"
  | "onDeleteProjectScript"
> & {
  /** Toggles the Diff / Review panel; absent where there is no diff to show. */
  readonly onToggleChanges?: (() => void) | undefined;
  readonly backgroundWork: MattrBackgroundWork;
  /** The inline right panel covers the header's right side, so the window controls sit over it. */
  readonly rightPanelOpen: boolean;
};

/** Marks <html> while the git chip's menu is open, so CSS can widen that one menu. */
function flagOpenGitMenu(slot: HTMLDivElement | null) {
  if (!slot) return;
  const root = slot.ownerDocument.documentElement;
  const sync = () =>
    root.toggleAttribute(
      "data-mattr-ribbon-git-menu",
      slot.querySelector("[data-popup-open]") !== null,
    );
  const observer = new MutationObserver(sync);
  observer.observe(slot, { subtree: true, attributeFilter: ["data-popup-open"] });
  return () => {
    observer.disconnect();
    root.removeAttribute("data-mattr-ribbon-git-menu");
  };
}

/**
 * The Topbar Ribbon: the thread's diff, pull request, editor, project actions, git and agents as
 * chips in the 38pt shell topbar, in place of the docked Thread Details card. Every chip reuses the
 * card's own control, so nothing the card did is lost; the full card stays one click away in the
 * More menu.
 */
export function MattrThreadRibbon(props: MattrThreadRibbonProps) {
  const gt = useGT();
  const visible = useClientSettings(resolveThreadDetailsVisibility);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<MattrRibbonDensity>("full");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const t3File = useT3ProjectFileState(
    props.environmentId,
    props.activeProjectScripts && visible.scripts ? props.gitCwd : null,
  );
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const serverConfig = useServerConfigs().get(props.environmentId);
  const thread = useQuietThreadShell(threadRef);
  const displayedPr = useThreadDisplayedPullRequest(props.environmentId, thread ?? null);
  const lineage = useMattrLineageModel({
    environmentId: props.environmentId,
    threadId: props.threadId,
    backgroundWork: props.backgroundWork,
  });
  const servers = useThreadDiscoveredPorts(threadRef);
  const automations = useMattrThreadAutomationCounts(props.environmentId, props.threadId);
  const tracksFolders = (project?.trackedFolders?.length ?? 0) > 0;
  const taskFolderQuery = useEnvironmentQuery(
    props.isServerThread && props.worktreePath !== null
      ? filesystemEnvironment.taskFolder({
          environmentId: props.environmentId,
          input: { worktreePath: props.worktreePath },
        })
      : null,
  );
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  // Same rules as the details card: a task folder's plain directory and No project threads get no git.
  const folderIsRepo = props.isGitRepo && taskFolder?.projectIsWorktree !== false;
  const offersGit =
    props.gitCwd !== null &&
    serverConfig !== undefined &&
    project !== null &&
    !isScratchProject(project, serverConfig.scratchWorkspaceRoot);
  const showGit =
    offersGit &&
    props.activeProjectName !== undefined &&
    (folderIsRepo || (!tracksFolders && taskFolder === null));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the header and titlebar controls through ResizeObserver to size the ribbon from available content width and keep it clear of the controls
  useLayoutEffect(() => {
    const root = rootRef.current;
    const header = root?.closest<HTMLElement>("[data-chat-header]");
    if (!root || !header) return;
    const controls = header.ownerDocument.querySelector<HTMLElement>(
      "[data-workspace-titlebar-controls]",
    );
    const measure = () => {
      const style = getComputedStyle(header);
      const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(style.paddingRight) || 0;
      // The window's panel toggles are fixed over the header's right end; keep the chips clear of them.
      const activeControls =
        controls?.isConnected === true
          ? controls
          : header.ownerDocument.querySelector<HTMLElement>("[data-workspace-titlebar-controls]");
      const controlsRect = activeControls?.getBoundingClientRect();
      const controlsVisible =
        !props.rightPanelOpen &&
        controlsRect !== undefined &&
        controlsRect.width > 0 &&
        controlsRect.height > 0;
      const headerRect = header.getBoundingClientRect();
      const contentRight = headerRect.right - paddingRight;
      const controlsInset = controlsVisible ? Math.max(0, contentRight - controlsRect.left + 8) : 0;
      root.style.setProperty("--mattr-ribbon-controls-inset", `${controlsInset}px`);
      const availableWidth = Math.max(
        0,
        header.clientWidth - paddingLeft - paddingRight - controlsInset,
      );
      setDensity(resolveMattrRibbonDensity(availableWidth));
    };
    measure();
    const observed: Element[] = controls ? [header, controls] : [header];
    return observeResize(observed, measure);
  }, [props.rightPanelOpen]);

  const issues = thread?.issues ?? [];
  const showPr = visible.branch && (displayedPr.number !== undefined || issues.length > 0);
  const showDiff = visible.changes && showGit && folderIsRepo;
  const showOpenIn = visible.openIn && props.showOpenInPicker;
  const showScripts = visible.scripts && props.activeProjectScripts !== undefined;
  const showGitActions = visible.gitActions && showGit;
  const showAgents =
    !props.draftId &&
    (visible.lineage || visible.sideChats) &&
    (lineage.previousCount > 0 || lineage.sideChatCount > 0 || lineage.rows.length > 0);
  const lineagePopover = useMattrLineagePopover();
  const ribbonLineageOpen =
    lineagePopover.threadKey === lineage.threadKey && lineagePopover.anchor === "ribbon";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the external lineage popover store if the ribbon's agents chip disappears while open
  useLayoutEffect(() => {
    if (!showAgents && ribbonLineageOpen) closeMattrLineagePopover();
  }, [showAgents, ribbonLineageOpen]);
  const overflowOpenIn = showOpenIn && mattrRibbonOverflows(density, "openIn");
  const overflowScripts = showScripts && mattrRibbonOverflows(density, "scripts");
  const overflowPr = showPr && mattrRibbonOverflows(density, "pr");
  const overflowDiff = showDiff && mattrRibbonOverflows(density, "diff");
  const activeThreadRef = threadRef;
  const openAllDetails = () =>
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", true);
  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("input, textarea, a[href]")) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const prPopup = (
    <PopoverPopup
      data-mattr-frosted=""
      data-mattr-ribbon-popup="pr"
      side="bottom"
      align="end"
      sideOffset={6}
      padding="none"
    >
      <div data-mattr-ribbon-panel>
        <ThreadDetailsThreadPrRows
          threadRef={threadRef}
          project={project}
          composerTarget={props.composerDraftTarget}
        />
        {issues.length > 0 ? <ThreadDetailsIssueRows links={issues} threadRef={threadRef} /> : null}
      </div>
    </PopoverPopup>
  );
  const PrStatusIcon = displayedPr.status?.Icon;

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={gt("Thread actions")}
      data-mattr-ribbon=""
      data-density={density}
      data-right-panel-open={props.rightPanelOpen || undefined}
      onContextMenu={openContextMenu}
    >
      {showDiff && !overflowDiff && props.gitCwd ? (
        <div data-mattr-ribbon-slot="diff">
          <GitActionsControl
            showActions={false}
            showChanges
            gitCwd={props.gitCwd}
            name={props.activeProjectName ?? ""}
            workspaceMutationId={props.workspaceMutationId}
            activeThreadRef={activeThreadRef}
            {...(props.draftId ? { draftId: props.draftId } : {})}
            {...(props.onToggleChanges ? { onOpenChanges: props.onToggleChanges } : {})}
          />
        </div>
      ) : null}

      {showPr && !overflowPr ? (
        <div data-mattr-ribbon-slot="pr">
          <Popover>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        data-mattr-ribbon-chip="pr"
                        aria-label={
                          displayedPr.number !== undefined
                            ? gt("Pull request #{number}", { number: displayedPr.number })
                            : gt("Linked issues")
                        }
                      />
                    }
                  />
                }
              >
                {displayedPr.number !== undefined ? (
                  <>
                    <PullRequestGlyph.pullRequest aria-hidden data-mattr-ribbon-icon />
                    <span data-mattr-ribbon-num>#{displayedPr.number}</span>
                    {PrStatusIcon ? (
                      <PrStatusIcon
                        aria-hidden
                        data-mattr-ribbon-status
                        className={displayedPr.status?.colorClass}
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    <CircleDotIcon aria-hidden data-mattr-ribbon-icon />
                    <span data-mattr-ribbon-num>{issues.length}</span>
                  </>
                )}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {displayedPr.status?.tooltip ?? gt("Pull requests and issues")}
              </TooltipPopup>
            </Tooltip>
            {prPopup}
          </Popover>
        </div>
      ) : null}

      {showOpenIn && !overflowOpenIn ? (
        <div data-mattr-ribbon-slot="openIn">
          <OpenInPicker
            keybindings={props.keybindings}
            environmentId={props.environmentId}
            availableEditors={props.availableEditors}
            openInCwd={props.gitCwd}
            enableShortcut={props.openInShortcutEnabled}
            compact={density !== "full"}
          />
        </div>
      ) : null}

      {showScripts && !overflowScripts && props.activeProjectScripts ? (
        <div data-mattr-ribbon-slot="scripts">
          <ProjectScriptsControl
            environmentId={props.environmentId}
            scripts={props.activeProjectScripts}
            fileScripts={t3File.scripts}
            onActionsMenuOpen={t3File.refresh}
            preferredScriptId={props.preferredScriptId}
            onRunScript={props.onRunProjectScript}
            onAddScript={props.onAddProjectScript}
            onUpdateScript={props.onUpdateProjectScript}
            onDeleteScript={props.onDeleteProjectScript}
          />
        </div>
      ) : null}

      {showGitActions && props.gitCwd ? (
        <div data-mattr-ribbon-slot="git" ref={flagOpenGitMenu}>
          <GitActionsControl
            showActions
            showChanges={false}
            gitCwd={props.gitCwd}
            name={props.activeProjectName ?? ""}
            workspaceMutationId={props.workspaceMutationId}
            activeThreadRef={activeThreadRef}
            {...(props.draftId ? { draftId: props.draftId } : {})}
            {...(props.onToggleChanges ? { onOpenChanges: props.onToggleChanges } : {})}
          />
        </div>
      ) : null}

      {showAgents || ribbonLineageOpen ? (
        <div data-mattr-ribbon-slot="agents">
          <MattrLineagePopover
            environmentId={props.environmentId}
            threadId={props.threadId}
            backgroundWork={props.backgroundWork}
            anchor="ribbon"
            closed={!showAgents}
            model={lineage}
            serverCount={servers.length}
            automationCount={automations.bound}
            trigger={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger
                      render={
                        <button
                          type="button"
                          data-mattr-ribbon-chip="agents"
                          aria-label={gt("Agents: {count} previous", {
                            count: lineage.previousCount,
                          })}
                        />
                      }
                    />
                  }
                >
                  <BotIcon aria-hidden data-mattr-ribbon-icon />
                  {lineage.previousCount > 0 ? (
                    <span data-mattr-ribbon-num>{lineage.previousCount}</span>
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <T>Lineage: running and previous agents, side chats</T>
                </TooltipPopup>
              </Tooltip>
            }
          />
        </div>
      ) : null}

      <div data-mattr-ribbon-slot="more">
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      data-mattr-ribbon-chip="more"
                      aria-label={gt("More thread actions")}
                    />
                  }
                />
              }
            >
              <EllipsisIcon aria-hidden data-mattr-ribbon-icon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>More thread actions</T>
            </TooltipPopup>
          </Tooltip>
          <MenuPopup align="end" data-mattr-frosted="">
            {overflowDiff && props.onToggleChanges ? (
              <MenuItem onClick={props.onToggleChanges}>
                <FileDiffIcon aria-hidden />
                <MenuItemLabel>
                  <T>View changes</T>
                </MenuItemLabel>
              </MenuItem>
            ) : null}
            {overflowPr ? (
              <MenuItem onClick={openAllDetails}>
                <PullRequestGlyph.pullRequest aria-hidden />
                <MenuItemLabel>
                  {displayedPr.number !== undefined ? (
                    <T>
                      Pull request #<Var>{displayedPr.number}</Var>
                    </T>
                  ) : (
                    <T>Linked issues</T>
                  )}
                </MenuItemLabel>
              </MenuItem>
            ) : null}
            {overflowOpenIn ? (
              <OpenInPicker
                keybindings={props.keybindings}
                environmentId={props.environmentId}
                availableEditors={props.availableEditors}
                openInCwd={props.gitCwd}
                enableShortcut={false}
                presentation="menu"
              />
            ) : null}
            {overflowScripts && props.activeProjectScripts ? (
              <ProjectScriptsControl
                presentation="menu"
                environmentId={props.environmentId}
                scripts={props.activeProjectScripts}
                fileScripts={t3File.scripts}
                onActionsMenuOpen={t3File.refresh}
                preferredScriptId={props.preferredScriptId}
                onRunScript={props.onRunProjectScript}
                onAddScript={props.onAddProjectScript}
                onUpdateScript={props.onUpdateProjectScript}
                onDeleteScript={props.onDeleteProjectScript}
              />
            ) : null}
            {overflowDiff || overflowPr || overflowOpenIn || overflowScripts ? (
              <MenuSeparator />
            ) : null}
            <MenuItem onClick={openAllDetails}>
              <PanelRightIcon aria-hidden />
              <MenuItemLabel>
                <T>All thread details</T>
              </MenuItemLabel>
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <SlidersHorizontalIcon aria-hidden />
                <MenuItemLabel>
                  <T>Choose what to show</T>
                </MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>
                <ThreadDetailsItemsMenuItems />
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
            <MenuItem onClick={() => writeMattrThreadRibbon(false)}>
              <MenuItemLabel>
                <T>Use the classic details card</T>
              </MenuItemLabel>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <Menu open={contextMenu !== null} onOpenChange={(open) => !open && setContextMenu(null)}>
        <MenuPopup
          anchor={
            contextMenu
              ? { getBoundingClientRect: () => new DOMRect(contextMenu.x, contextMenu.y, 0, 0) }
              : undefined
          }
          align="start"
          side="bottom"
        >
          <ThreadDetailsItemsMenuItems />
          <MenuSeparator />
          <MenuItem onClick={openAllDetails}>
            <T>All thread details</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
