/* oxlint-disable shadcn/no-unknown-classes -- the `mts-*` and `mfs-*` classes come from the fork stylesheets antimatter/timeline-sidebar.css and antimatter/sidebar.css, which load outside Tailwind. */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { contextMenuSourceOf } from "../../../contextMenuSource";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../../state/environments";
import { readIssueListPreferences } from "../../issue/issueListPreferences";
import { readPullRequestListPreferences } from "../../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../../ui/sidebar";
import { SidebarProviderUpdatePill } from "../SidebarProviderUpdatePill";
import { SidebarThreadUndoNotice } from "../SidebarThreadUndoNotice";
import { SidebarUpdateArchitectureWarning } from "../SidebarUpdatePill";
import { useNavigateToMainApp } from "../mainAppLocation";
import {
  MattrBrandMenu,
  MattrCrew,
  MattrMenuPopup,
  MattrMenuRadioItem,
  MattrProviderMark,
  MattrUpdateNotice,
  useCrewBots,
} from "./MattrDefaultSidebarParts";
import {
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
  ChevronGlyph,
  ClockGlyph,
  ComposeGlyph,
  FolderGlyph,
  GearGlyph,
  HelpGlyph,
  InboxGlyph,
  PullRequestClosedGlyph,
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
  subagentElapsed,
  workspaceKind,
} from "./mattrTimelineSidebar.logic";
import type { MattrSidebarModel } from "./useMattrSidebarModel";

const ALL_ACTIVITY = "__all__";

const PR_GLYPH: Record<MattrPullRequestState, typeof PullRequestOpenGlyph> = {
  open: PullRequestOpenGlyph,
  draft: PullRequestOpenGlyph,
  merged: PullRequestOpenGlyph,
  closed: PullRequestClosedGlyph,
};

function rowMenuHandler(model: MattrSidebarModel, item: MattrThreadItem) {
  return (event: ReactMouseEvent) => {
    event.preventDefault();
    model.actions.openThreadMenu(
      item,
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
  };
}

function TimelineRow({
  model,
  item,
  childNeedsYou,
  holdsActive,
}: {
  model: MattrSidebarModel;
  item: MattrThreadItem;
  childNeedsYou: boolean;
  /** The open thread is a subagent of this row that the list doesn't show. */
  holdsActive: boolean;
}) {
  const gt = useGT();
  const active = item.key === model.activeThreadKey;
  const worktree = workspaceKind(item) === "worktree";
  const pr = item.pullRequest;
  const PrGlyph = pr === null ? null : PR_GLYPH[pr.state];
  return (
    <div
      className="mts-row"
      data-mattr-timeline-row={item.key}
      data-active={active || holdsActive ? "" : undefined}
      data-unread={item.unread ? "" : undefined}
      onContextMenu={rowMenuHandler(model, item)}
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
        {item.attention === "needs" || childNeedsYou ? (
          <span className="mts-need" role="img" aria-label={gt("Needs you")} />
        ) : item.attention === "running" ? (
          <SpinnerGlyph className="mts-spin" role="img" aria-label={gt("Running")} />
        ) : null}
      </span>
      <span className="mts-l2">
        {worktree ? (
          <WorktreeGlyph className="mts-mi" data-mattr-workspace="worktree" />
        ) : (
          <FolderGlyph className="mts-mi" data-mattr-workspace="local" />
        )}
        <span className="mts-proj">{item.projectName ?? gt("No project")}</span>
        {pr !== null && PrGlyph !== null ? (
          <span className="mts-pr" data-state={pr.state}>
            <PrGlyph />
            {`#${pr.number}`}
          </span>
        ) : null}
        {item.branch !== null ? (
          <span className="mts-br">
            <BranchGlyph />
            <span>{item.branch}</span>
          </span>
        ) : null}
      </span>
    </div>
  );
}

function TimelineSubagent({ model, item }: { model: MattrSidebarModel; item: MattrChildItem }) {
  const gt = useGT();
  const active = item.key === model.activeThreadKey;
  const needs = item.attention === "needs";
  return (
    <div
      className="mts-sub"
      data-mattr-timeline-subagent={item.key}
      data-active={active ? "" : undefined}
      onContextMenu={rowMenuHandler(model, item)}
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
        {needs
          ? gt("Needs you")
          : gt("subagent · {elapsed}", { elapsed: subagentElapsed(item, model.nowMs) })}
      </span>
    </div>
  );
}

interface TimelineRowContext {
  readonly subagents: ReadonlyMap<string, ReadonlyArray<MattrChildItem>>;
  readonly needsChildParents: ReadonlySet<string>;
  /** The row to highlight when the open thread is a subagent the list doesn't show. */
  readonly hiddenActiveParent: string | null;
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
            />
            {active.length > 0 ? (
              <div role="group" aria-label={gt("Subagents of {title}", { title: item.title })}>
                {active.map((child) => (
                  <TimelineSubagent key={child.key} model={model} item={child} />
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
    <div className="mts-use" role="group" aria-label={gt("Usage limits")}>
      {meters.map((meter) => {
        const label = `${meter.providerName} · ${compactWindowLabel(meter.windowLabel)}`;
        const soon = formatResetLabel(meter.resetsAt, nowMs);
        const tip =
          soon === null
            ? `${meter.accountName} · ${gt("{percent}% left", { percent: 100 - meter.usedPercent })}`
            : `${meter.accountName} · ${gt("Resets in {duration}", { duration: soon })}`;
        return (
          <MattrTip key={meter.key} label={tip} side="top">
            <button
              type="button"
              className="mts-m"
              aria-label={gt("{label}: {percent}% used", { label, percent: meter.usedPercent })}
              onClick={onOpen}
            >
              <span className="mts-mh">
                <span className="mts-pi">
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

/**
 * The Timeline rail (Synara frames 04 and 05): brand row, four nav rows, the activity scope,
 * threads by day with workspace, pull request and branch, and running subagents nested under
 * their thread while "Show active subagents" is on.
 */
export function MattrTimelineSidebar({ model }: { model: MattrSidebarModel }) {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const { items, children, projects, activeThreadKey, nowMs, actions } = model;
  const [storedProjectFilter, setProjectFilter] = useMattrInboxProjectFilter();
  const [sort, setSort] = useMattrTimelineSort();
  const [earlierExpanded, setEarlierExpanded] = useMattrTimelineEarlierExpanded();
  const [showSubagents] = useMattrTimelineSubagents();
  const [filter, setFilter] = useState<MattrListFilter>("all");
  const crew = useCrewBots();
  const primaryId = usePrimaryEnvironmentId();
  const providers = useEnvironmentProviders();
  const meters = pickUsageMeters(primaryId === null ? [] : (providers.get(primaryId) ?? []));

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
  const rowContext: TimelineRowContext = {
    subagents,
    needsChildParents,
    hiddenActiveParent:
      activeChild !== undefined &&
      !(subagents.get(activeChild.ancestorKey) ?? []).some((child) => child.key === activeChild.key)
        ? activeChild.ancestorKey
        : null,
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
  const onSettings = pathname.startsWith("/settings");
  const nothingListed =
    buckets.recent.length === 0 && buckets.yesterday.length === 0 && buckets.earlier.length === 0;

  return (
    <div className="mfs mts" data-mattr-sidebar="timeline">
      <div className="mts-brand">
        <MattrBrandMenu onNavigate={closeMobile} />
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
          onClick={() => actions.newThread(projectFilter ?? activeProjectKey)}
        >
          <ComposeGlyph />
          <span>{gt("New thread")}</span>
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
            <ChevronGlyph className="mts-cr" />
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
          </button>
        </MattrTip>
      </div>

      <div className="mts-list">
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
