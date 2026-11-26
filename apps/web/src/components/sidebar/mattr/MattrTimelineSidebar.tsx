/* oxlint-disable shadcn/no-unknown-classes -- the `mts-*` and `mfs-*` classes come from the fork stylesheets antimatter/timeline-sidebar.css and antimatter/sidebar.css, which load outside Tailwind. */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { contextMenuSourceOf } from "../../../contextMenuSource";
import { shortcutLabelForCommand } from "../../../keybindings";
import { observeResize } from "../../../lib/observeResize";
import { readLocalApi } from "../../../localApi";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../../state/environments";
import { providerLogoColor } from "../../chat/ProviderInstanceIcon";
import { readIssueListPreferences } from "../../issue/issueListPreferences";
import { readPullRequestListPreferences } from "../../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../../ui/sidebar";
import { SidebarProviderUpdatePill } from "../SidebarProviderUpdatePill";
import { SidebarThreadUndoNotice } from "../SidebarThreadUndoNotice";
import { SidebarUpdateArchitectureWarning } from "../SidebarUpdatePill";
import { useNavigateToMainApp } from "../mainAppLocation";
import { useActiveRowReveal, type SidebarRouteReveal } from "../routeReveal";
import {
  MattrBrandMenu,
  MattrCrew,
  MattrMenuItem,
  MattrMenuPopup,
  MattrMenuRadioItem,
  MattrProviderMark,
  MattrUpdateNotice,
  useCrewBots,
} from "./MattrDefaultSidebarParts";
import {
  compactAge,
  countNeedsYou,
  formatResetLabel,
  indexChildrenByParent,
  parentsWithNeedsChild,
  pickUsageMeters,
  summarizeProjects,
  type MattrChildItem,
  type MattrListFilter,
  type MattrUsageMeter,
} from "./mattrFinalSidebar.logic";
import type { MattrPullRequestState, MattrThreadItem } from "./mattrSidebar.logic";
import { MattrTip } from "./MattrSidebarParts";
import {
  useMattrInboxProjectFilter,
  useMattrTimelineEarlierExpanded,
  useMattrTimelineSort,
  useMattrTimelineSubagents,
} from "./mattrSidebarStore";
import {
  BoardGlyph,
  BranchGlyph,
  ChevronDownGlyph,
  ChevronGlyph,
  ClockGlyph,
  CloseGlyph,
  ComposeGlyph,
  FolderGlyph,
  GearGlyph,
  HelpGlyph,
  InboxGlyph,
  MoreGlyph,
  PinGlyph,
  PullRequestClosedGlyph,
  PullRequestMergedGlyph,
  PullRequestOpenGlyph,
  SearchGlyph,
  SortGlyph,
  SpinnerGlyph,
  WorktreeGlyph,
} from "./MattrTimelineIcons";
import {
  activeSubagentsByParent,
  buildTimelineBuckets,
  compactWindowLabel,
  formatTimelineBranchLabel,
  subagentElapsed,
  usageMeterTone,
  workspaceKind,
  type MattrTimelineSort,
} from "./mattrTimelineSidebar.logic";
import type { MattrSidebarModel, MattrThreadMenuAction } from "./useMattrSidebarModel";

const ALL_ACTIVITY = "__all__";

const PR_GLYPH: Record<MattrPullRequestState, typeof PullRequestOpenGlyph> = {
  open: PullRequestOpenGlyph,
  draft: PullRequestOpenGlyph,
  merged: PullRequestMergedGlyph,
  closed: PullRequestClosedGlyph,
};

interface WebThreadMenuState {
  readonly item: MattrThreadItem;
  readonly anchor: MenuPrimitive.Positioner.Props["anchor"];
}

function pointAnchor(x: number, y: number): MenuPrimitive.Positioner.Props["anchor"] {
  return {
    getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
  };
}

/** Syncs top/bottom scroll fade data attributes without React state updates during scroll. */
function observeScrollFade(element: HTMLDivElement | null) {
  if (element === null) return;
  const sync = () => {
    const scrolledTop = element.scrollTop > 1;
    const scrolledBottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    element.toggleAttribute("data-scrolled-top", scrolledTop);
    element.toggleAttribute("data-scrolled-bottom", scrolledBottom);
  };
  sync();
  element.addEventListener("scroll", sync, { passive: true });
  const stopResize = observeResize(element, sync);
  const mutation =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          sync();
        });
  mutation?.observe(element, { childList: true, subtree: true });
  return () => {
    element.removeEventListener("scroll", sync);
    stopResize();
    mutation?.disconnect();
  };
}

interface TimelineRowContext {
  readonly subagents: ReadonlyMap<string, ReadonlyArray<MattrChildItem>>;
  readonly needsChildParents: ReadonlySet<string>;
  /** The row to highlight when the open thread is a subagent the list doesn't show. */
  readonly hiddenActiveParent: string | null;
  readonly sort: MattrTimelineSort;
  readonly hideProjectName: boolean;
  readonly showRowMenuButton: boolean;
  readonly openWebMenu: (
    item: MattrThreadItem,
    anchor: MenuPrimitive.Positioner.Props["anchor"],
  ) => void;
  readonly revealActiveRow: (row: HTMLElement | null, rowKey: string) => (() => void) | undefined;
}

function hasNativeContextMenu(): boolean {
  return (
    typeof window !== "undefined" && window.desktopBridge !== undefined && readLocalApi() != null
  );
}

function openRowContextMenu(
  event: ReactMouseEvent,
  model: MattrSidebarModel,
  item: MattrThreadItem,
  openWebMenu: TimelineRowContext["openWebMenu"],
) {
  event.preventDefault();
  if (hasNativeContextMenu()) {
    model.actions.openThreadMenu(
      item,
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
    return;
  }
  openWebMenu(item, pointAnchor(event.clientX, event.clientY));
}

function TimelineRow({
  model,
  item,
  childNeedsYou,
  holdsActive,
  context,
}: {
  model: MattrSidebarModel;
  item: MattrThreadItem;
  childNeedsYou: boolean;
  /** The open thread is a subagent of this row that the list doesn't show. */
  holdsActive: boolean;
  context: TimelineRowContext;
}) {
  const gt = useGT();
  const active = item.key === model.activeThreadKey;
  const kind = workspaceKind(item);
  const pr = item.pullRequest;
  const PrGlyph = pr === null ? null : PR_GLYPH[pr.state];
  const needs = item.attention === "needs" || childNeedsYou;
  const running = !needs && item.attention === "running";
  const failed = !needs && !running && item.failed;
  const idle = !needs && !running && !failed;
  const age = idle
    ? compactAge(context.sort === "created" ? item.createdAt : item.activityAt, model.nowMs)
    : "";
  const revealKey = active ? item.key : holdsActive ? model.activeThreadKey : null;
  return (
    <div
      ref={revealKey !== null ? (row) => context.revealActiveRow(row, revealKey) : undefined}
      className="mts-row"
      data-mattr-timeline-row={item.key}
      data-active={active || holdsActive ? "" : undefined}
      data-unread={item.unread ? "" : undefined}
      data-pinned={item.pinned ? "" : undefined}
      onContextMenu={(event) => openRowContextMenu(event, model, item, context.openWebMenu)}
    >
      <button
        type="button"
        className="mts-hit"
        aria-label={item.title}
        aria-current={active ? "page" : undefined}
        onClick={() => model.actions.openThread(item)}
      />
      <span className="mts-l1">
        <span className="mts-pi">
          <MattrProviderMark driver={item.driver} />
        </span>
        <span className="mts-t">{item.title}</span>
        {item.pinned ? <PinGlyph className="mts-pin" role="img" aria-label={gt("Pinned")} /> : null}
        {needs ? (
          <span className="mts-need" role="img" aria-label={gt("Needs you")} />
        ) : running ? (
          <SpinnerGlyph className="mts-spin" role="img" aria-label={gt("Running")} />
        ) : failed ? (
          <MattrTip label={gt("Failed")}>
            <span
              className="mts-fail"
              role="img"
              aria-label={gt("Failed")}
              onClick={() => model.actions.openThread(item)}
            />
          </MattrTip>
        ) : (
          <>
            {age !== "" ? <span className="mts-age">{age}</span> : null}
            {item.unread ? (
              <span className="mts-unread" role="img" aria-label={gt("Unread")} />
            ) : null}
          </>
        )}
        {context.showRowMenuButton ? (
          <button
            type="button"
            className="mts-more"
            aria-label={gt("Thread actions")}
            aria-haspopup="menu"
            onClick={(event) => {
              event.stopPropagation();
              context.openWebMenu(item, event.currentTarget);
            }}
          >
            <MoreGlyph />
          </button>
        ) : null}
      </span>
      <span className="mts-l2">
        {kind === "worktree" ? (
          <WorktreeGlyph className="mts-mi" data-mattr-workspace="worktree" />
        ) : kind === "local" ? (
          <FolderGlyph className="mts-mi" data-mattr-workspace="local" />
        ) : null}
        {!context.hideProjectName ? (
          <span className="mts-proj">{item.projectName ?? gt("No project")}</span>
        ) : null}
        {pr !== null && PrGlyph !== null ? (
          <span className="mts-pr" data-state={pr.state}>
            <PrGlyph />
            {`#${pr.number}`}
          </span>
        ) : null}
        {item.branch !== null ? (
          <MattrTip label={item.branch} side="top">
            <span className="mts-br" onClick={() => model.actions.openThread(item)}>
              <BranchGlyph />
              <span>{formatTimelineBranchLabel(item.branch, item.projectName)}</span>
            </span>
          </MattrTip>
        ) : null}
      </span>
    </div>
  );
}

function TimelineSubagent({
  model,
  item,
  context,
}: {
  model: MattrSidebarModel;
  item: MattrChildItem;
  context: TimelineRowContext;
}) {
  const gt = useGT();
  const active = item.key === model.activeThreadKey;
  const needs = item.attention === "needs";
  return (
    <div
      ref={active ? (row) => context.revealActiveRow(row, item.key) : undefined}
      className="mts-sub"
      data-mattr-timeline-subagent={item.key}
      data-active={active ? "" : undefined}
      onContextMenu={(event) => openRowContextMenu(event, model, item, context.openWebMenu)}
    >
      <button
        type="button"
        className="mts-hit"
        aria-label={item.title}
        aria-current={active ? "page" : undefined}
        onClick={() => model.actions.openThread(item)}
      />
      <span className="mts-conn" aria-hidden />
      <span className="mts-pi">
        <MattrProviderMark driver={item.driver} />
      </span>
      <span className="mts-st">{item.title}</span>
      <span className="mts-sm" data-tone={needs ? "needs" : "running"}>
        {needs ? (
          gt("Needs you")
        ) : (
          <>
            <span className="mts-sub-dot" aria-hidden />
            {subagentElapsed(item, model.nowMs)}
          </>
        )}
      </span>
    </div>
  );
}

function TimelineRows({
  model,
  items,
  context,
}: {
  model: MattrSidebarModel;
  items: ReadonlyArray<MattrThreadItem>;
  context: TimelineRowContext;
}) {
  const { subagents } = context;
  const gt = useGT();
  return (
    <ul className="mts-rows">
      {items.map((item) => {
        const active = subagents.get(item.key) ?? [];
        return (
          <li key={item.key}>
            <TimelineRow
              model={model}
              item={item}
              childNeedsYou={context.needsChildParents.has(item.key)}
              holdsActive={context.hiddenActiveParent === item.key}
              context={context}
            />
            {active.length > 0 ? (
              <div role="group" aria-label={gt("Subagents of {title}", { title: item.title })}>
                {active.map((child) => (
                  <TimelineSubagent key={child.key} model={model} item={child} context={context} />
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function TimelineBucket({
  model,
  label,
  items,
  context,
}: {
  model: MattrSidebarModel;
  label: string;
  items: ReadonlyArray<MattrThreadItem>;
  context: TimelineRowContext;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={label}>
      <h3 className="mts-sec">{label}</h3>
      <TimelineRows model={model} items={items} context={context} />
    </section>
  );
}

function TimelineMeters({
  meters,
  nowMs,
  onOpen,
}: {
  meters: ReadonlyArray<MattrUsageMeter>;
  nowMs: number;
  onOpen: () => void;
}) {
  const gt = useGT();
  if (meters.length === 0) return null;
  return (
    <div
      className="mts-use"
      role="group"
      aria-label={gt("Usage limits")}
      data-count={meters.length}
    >
      {meters.map((meter) => {
        const label = `${meter.providerName} · ${compactWindowLabel(meter.windowLabel)}`;
        const tone = usageMeterTone(meter.usedPercent);
        const monochrome = providerLogoColor(meter.driver) === null;
        const soon = formatResetLabel(meter.resetsAt, nowMs);
        const tip =
          soon === null
            ? `${meter.accountName} · ${gt("{percent}% used", { percent: meter.usedPercent })} · ${gt("{percent}% left", { percent: 100 - meter.usedPercent })}`
            : `${meter.accountName} · ${gt("{percent}% used", { percent: meter.usedPercent })} · ${gt("Resets in {duration}", { duration: soon })}`;
        return (
          <MattrTip key={meter.key} label={tip} side="top">
            <button
              type="button"
              className="mts-m"
              data-tone={tone}
              aria-label={gt("{label}: {percent}% used", { label, percent: meter.usedPercent })}
              onClick={onOpen}
            >
              <span className="mts-mh">
                <span className="mts-pi" data-monochrome={monochrome ? "" : undefined}>
                  <MattrProviderMark driver={meter.driver} />
                </span>
                <span className="mts-ml">{label}</span>
                <span className="mts-v">{`${meter.usedPercent}%`}</span>
              </span>
              <span className="mts-tr" aria-hidden>
                <i style={{ width: `${meter.usedPercent}%` }} />
              </span>
            </button>
          </MattrTip>
        );
      })}
    </div>
  );
}

function TimelineWebContextMenu({
  menu,
  onClose,
  onAction,
}: {
  menu: WebThreadMenuState | null;
  onClose: () => void;
  onAction: (item: MattrThreadItem, action: MattrThreadMenuAction) => void;
}) {
  const gt = useGT();
  const item = menu?.item ?? null;
  const run = (action: MattrThreadMenuAction) => {
    if (item === null) return;
    onClose();
    onAction(item, action);
  };
  return (
    <MenuPrimitive.Root
      open={menu !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MattrMenuPopup anchor={menu?.anchor} align="start" side="bottom">
        {item !== null ? (
          <>
            <MattrMenuItem label={gt("Open thread")} onClick={() => run("open")} />
            <div className="mfs-menu-sep" />
            <MattrMenuItem
              label={item.pinned ? gt("Unpin") : gt("Pin")}
              onClick={() => run(item.pinned ? "unpin" : "pin")}
            />
            <MattrMenuItem label={gt("Mark as unread")} onClick={() => run("mark-unread")} />
            <MattrMenuItem
              label={item.settled ? gt("Unsettle") : gt("Settle")}
              onClick={() => run(item.settled ? "unsettle" : "settle")}
            />
            <MattrMenuItem label={gt("Copy link")} onClick={() => run("copy-link")} />
            <div className="mfs-menu-sep" />
            <MattrMenuItem label={gt("Archive")} onClick={() => run("archive")} />
          </>
        ) : null}
      </MattrMenuPopup>
    </MenuPrimitive.Root>
  );
}

/**
 * The Timeline rail (Synara frames 04 and 05): brand row, four nav rows, the activity scope,
 * threads by day with workspace, pull request and branch, and running subagents nested under
 * their thread while "Show active subagents" is on.
 */
export function MattrTimelineSidebar({
  model,
  routeReveal,
}: {
  model: MattrSidebarModel;
  routeReveal?: SidebarRouteReveal | undefined;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const { items, children, projects, activeThreadKey, nowMs, keybindings, actions } = model;
  const [storedProjectFilter, setProjectFilter] = useMattrInboxProjectFilter();
  const [sort, setSort] = useMattrTimelineSort();
  const [earlierExpanded, setEarlierExpanded] = useMattrTimelineEarlierExpanded();
  const [showSubagents] = useMattrTimelineSubagents();
  const [filter, setFilter] = useState<MattrListFilter>("all");
  const [webMenu, setWebMenu] = useState<WebThreadMenuState | null>(null);
  const [fallbackReveal] = useState<SidebarRouteReveal>(() => ({
    observedKey: null,
    pendingKey: null,
  }));
  const revealActiveRow = useActiveRowReveal(routeReveal ?? fallbackReveal, activeThreadKey);
  const crew = useCrewBots();
  const primaryId = usePrimaryEnvironmentId();
  const providers = useEnvironmentProviders();
  const meters = pickUsageMeters(
    primaryId === null ? [] : (providers.get(primaryId) ?? []),
    Number.POSITIVE_INFINITY,
  );

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const go = (to: () => void) => {
    closeMobile();
    to();
  };
  const projectFilter =
    storedProjectFilter !== null && projects.some((project) => project.key === storedProjectFilter)
      ? storedProjectFilter
      : null;
  const needsChildParents = parentsWithNeedsChild(indexChildrenByParent(children));
  const subagents = activeSubagentsByParent(children, showSubagents);
  const buckets = buildTimelineBuckets(items, {
    nowMs,
    sort,
    projectFilter,
    filter,
    needsChildParents,
    activeChildParents: new Set(subagents.keys()),
  });
  const activeChild = children.find((child) => child.key === activeThreadKey);
  const showRowMenuButton = !hasNativeContextMenu() || isMobile;
  const rowContext: TimelineRowContext = {
    subagents,
    needsChildParents,
    hiddenActiveParent:
      activeChild !== undefined &&
      !(subagents.get(activeChild.ancestorKey) ?? []).some((child) => child.key === activeChild.key)
        ? activeChild.ancestorKey
        : null,
    sort,
    hideProjectName: projectFilter !== null,
    showRowMenuButton,
    openWebMenu: (item, anchor) => setWebMenu({ item, anchor }),
    revealActiveRow,
  };
  const needsCount = countNeedsYou(items, children) + crew.needsCount;
  const projectSummary = summarizeProjects(items);
  const scopeName =
    projectFilter === null
      ? gt("All activity")
      : (projects.find((project) => project.key === projectFilter)?.name ?? gt("All activity"));
  const activeProjectKey =
    items.find((item) => item.key === activeThreadKey)?.projectKey ??
    children.find((item) => item.key === activeThreadKey)?.projectKey ??
    null;
  const newThreadHint = shortcutLabelForCommand(keybindings, "chat.new");
  const onSettings = pathname.startsWith("/settings");
  const nothingListed =
    buckets.pinned.length === 0 &&
    buckets.recent.length === 0 &&
    buckets.yesterday.length === 0 &&
    buckets.earlier.length === 0;

  const handleWebAction = (item: MattrThreadItem, action: MattrThreadMenuAction) => {
    if (actions.runThreadAction) {
      actions.runThreadAction(item, action);
      return;
    }
    if (action === "open") actions.openThread(item);
  };

  return (
    <div className="mfs mts" data-mattr-sidebar="timeline">
      <div className="mts-brand">
        <MattrBrandMenu
          onNavigate={closeMobile}
          caret={<ChevronDownGlyph className="mfs-caret" />}
        />
        <MattrTip label={gt("Search")}>
          <button
            type="button"
            className="mts-ib"
            aria-label={gt("Search")}
            onClick={() => openCommandPalette()}
          >
            <SearchGlyph />
          </button>
        </MattrTip>
        <MattrTip label={gt("Needs you")}>
          <button
            type="button"
            className="mts-ib"
            aria-label={
              needsCount > 0
                ? gt("Needs you, {count} waiting", { count: needsCount })
                : gt("Needs you")
            }
            aria-pressed={filter === "needs"}
            data-has-needs={needsCount > 0 ? "" : undefined}
            onClick={() => setFilter((current) => (current === "needs" ? "all" : "needs"))}
          >
            <InboxGlyph />
          </button>
        </MattrTip>
      </div>

      <nav className="mts-nav" aria-label={gt("Sidebar navigation")}>
        <button
          type="button"
          className="mts-ni"
          data-primary=""
          onClick={() => actions.newThread(projectFilter ?? activeProjectKey)}
        >
          <ComposeGlyph />
          <span>{gt("New thread")}</span>
          {newThreadHint ? <kbd className="mts-kbd">{newThreadHint}</kbd> : null}
        </button>
        <button
          type="button"
          className="mts-ni"
          aria-current={pathname === "/issues" ? "page" : undefined}
          onClick={() =>
            go(() => void navigate({ to: "/issues", search: readIssueListPreferences() }))
          }
        >
          <BoardGlyph />
          <span>{gt("Issues", { $context: "sidebar link to the list of issues" })}</span>
        </button>
        <button
          type="button"
          className="mts-ni"
          aria-current={pathname === "/pull-requests" ? "page" : undefined}
          onClick={() =>
            go(
              () =>
                void navigate({
                  to: "/pull-requests",
                  search: readPullRequestListPreferences(),
                }),
            )
          }
        >
          <PullRequestOpenGlyph />
          <span>{gt("Pull requests")}</span>
        </button>
        <button
          type="button"
          className="mts-ni"
          aria-current={pathname === "/settings/scheduled-tasks" ? "page" : undefined}
          onClick={() => go(() => void navigate({ to: "/settings/scheduled-tasks" }))}
        >
          <ClockGlyph />
          <span>{gt("Automations")}</span>
        </button>
      </nav>

      <div className="mts-act">
        <MenuPrimitive.Root>
          <MenuPrimitive.Trigger
            className="mts-scope"
            aria-label={gt("Activity scope: {scope}", { scope: scopeName })}
          >
            <span>{scopeName}</span>
            <ChevronDownGlyph className="mts-cr" />
          </MenuPrimitive.Trigger>
          <MattrMenuPopup>
            <MenuPrimitive.RadioGroup
              value={projectFilter ?? ALL_ACTIVITY}
              onValueChange={(value: string) =>
                setProjectFilter(value === ALL_ACTIVITY ? null : value)
              }
            >
              <MattrMenuRadioItem value={ALL_ACTIVITY} label={gt("All activity")} />
              {projects.map((project) => {
                const summary = projectSummary.get(project.key);
                return (
                  <MattrMenuRadioItem
                    key={project.key}
                    value={project.key}
                    label={project.name}
                    hint={summary ? <em>{summary.count}</em> : null}
                  />
                );
              })}
            </MenuPrimitive.RadioGroup>
          </MattrMenuPopup>
        </MenuPrimitive.Root>
        {filter === "needs" ? (
          <button
            type="button"
            className="mts-pill"
            aria-label={gt("Clear Needs you filter")}
            onClick={() => setFilter("all")}
          >
            <span>{gt("Needs you")}</span>
            <CloseGlyph />
          </button>
        ) : null}
        <MattrTip
          label={sort === "updated" ? gt("Sorted by last update") : gt("Sorted by created")}
        >
          <button
            type="button"
            className="mts-so"
            aria-label={sort === "updated" ? gt("Sort by created") : gt("Sort by last update")}
            data-sort={sort}
            onClick={() => setSort(sort === "updated" ? "created" : "updated")}
          >
            <SortGlyph />
            {sort === "created" ? <span className="mts-so-lab">{gt("Created")}</span> : null}
          </button>
        </MattrTip>
      </div>

      <div ref={observeScrollFade} className="mts-list">
        <TimelineBucket
          model={model}
          label={gt("Pinned")}
          items={buckets.pinned}
          context={rowContext}
        />
        <TimelineBucket
          model={model}
          label={gt("Recent")}
          items={buckets.recent}
          context={rowContext}
        />
        <TimelineBucket
          model={model}
          label={gt("Yesterday")}
          items={buckets.yesterday}
          context={rowContext}
        />
        {buckets.earlier.length > 0 ? (
          <section aria-label={gt("Earlier")}>
            <h3 className="mts-sec">
              <button
                type="button"
                className="mts-fold"
                aria-expanded={earlierExpanded}
                onClick={() => setEarlierExpanded(!earlierExpanded)}
              >
                <span>{gt("Earlier")}</span>
                <ChevronGlyph className="mts-cr" />
              </button>
            </h3>
            {earlierExpanded ? (
              <TimelineRows model={model} items={buckets.earlier} context={rowContext} />
            ) : null}
          </section>
        ) : null}
        {nothingListed ? (
          <p className="mfs-empty">
            {filter === "needs" ? gt("Nothing needs you right now.") : gt("No threads yet.")}
          </p>
        ) : null}
        <MattrCrew crew={crew} nowMs={nowMs} />
      </div>

      <TimelineWebContextMenu
        menu={webMenu}
        onClose={() => setWebMenu(null)}
        onAction={handleWebAction}
      />

      <div className="mfs-notices">
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
        <MattrUpdateNotice />
        <SidebarThreadUndoNotice />
      </div>
      <TimelineMeters
        meters={meters}
        nowMs={nowMs}
        onOpen={() => go(() => void navigate({ to: "/usage" }))}
      />
      <footer className="mts-foot" data-mattr-footer>
        <button
          type="button"
          className="mts-set"
          aria-current={onSettings ? "page" : undefined}
          onClick={() =>
            go(() => (onSettings ? void navigateToMainApp() : void navigate({ to: "/settings" })))
          }
        >
          <GearGlyph />
          <span>{gt("Settings")}</span>
        </button>
        <MattrTip label={gt("Keyboard shortcuts")} side="top">
          <button
            type="button"
            className="mts-help"
            aria-label={gt("Keyboard shortcuts")}
            onClick={() => go(() => void navigate({ to: "/settings/keybindings" }))}
          >
            <HelpGlyph />
          </button>
        </MattrTip>
      </footer>
    </div>
  );
}
