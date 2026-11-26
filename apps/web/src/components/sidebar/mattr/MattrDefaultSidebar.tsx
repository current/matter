/* oxlint-disable shadcn/no-unknown-classes -- the `mfs-*` classes come from the fork stylesheet antimatter/sidebar.css, which loads outside Tailwind. */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  ArrowUpDownIcon,
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  InboxIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

import { contextMenuSourceOf } from "../../../contextMenuSource";
import { shortcutLabelForCommand } from "../../../keybindings";
import { readIssueListPreferences } from "../../issue/issueListPreferences";
import { IssueGlyph } from "../../issue/issuePresentation";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../../ui/sidebar";
import {
  buildThreadGroups,
  compactAge,
  countOpenPullRequests,
  indexChildrenByParent,
  shouldAutoExpand,
  subagentStatus,
  summarizeProjects,
  threadRowStatus,
  type MattrListFilter,
  type MattrThreadGroup,
} from "./mattrFinalSidebar.logic";
import { filterThreadsByQuery, type MattrThreadItem } from "./mattrSidebar.logic";
import {
  MattrBrandMenu,
  MattrCrew,
  MattrFooter,
  MattrMenuPopup,
  MattrMenuRadioItem,
  MattrProviderMark,
  useCrewBots,
} from "./MattrDefaultSidebarParts";
import { MattrTip } from "./MattrSidebarParts";
import {
  useMattrCollapsedGroups,
  useMattrInboxProjectFilter,
  useMattrSortMode,
} from "./mattrSidebarStore";
import type { MattrSidebarModel } from "./useMattrSidebarModel";

const SUBAGENT_PREVIEW_LIMIT = 5;
const SEARCH_RESULT_LIMIT = 50;
const ALL_ACTIVITY = "__all__";
const NO_PROJECT_GROUP = "__none__";

const PR_GLYPH = {
  open: PullRequestGlyph.pullRequest,
  draft: PullRequestGlyph.draft,
  merged: PullRequestGlyph.merged,
  closed: PullRequestGlyph.closed,
} as const;

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

function ThreadTrailing({ item, nowMs }: { item: MattrThreadItem; nowMs: number }) {
  const status = threadRowStatus(item, nowMs);
  const pr = item.pullRequest;
  if (status.tone === "muted" && pr !== null) {
    const Glyph = PR_GLYPH[pr.state];
    return (
      <span className="mfs-pr" data-state={pr.state}>
        <Glyph aria-hidden />
        {`#${pr.number}`}
      </span>
    );
  }
  return (
    <span className="mfs-a" data-tone={status.tone}>
      {status.age}
    </span>
  );
}

function SubagentRow({
  model,
  item,
  nowMs,
}: {
  model: MattrSidebarModel;
  item: MattrThreadItem;
  nowMs: number;
}) {
  const gt = useGT();
  const onContextMenu = rowMenuHandler(model, item);
  const status = subagentStatus(item, nowMs);
  const active = item.key === model.activeThreadKey;
  const label =
    status.age ??
    (status.tone === "needs"
      ? gt("Needs you")
      : status.tone === "failed"
        ? gt("Failed")
        : gt("Done"));
  return (
    <li data-mattr-subagent={item.key}>
      <div
        className="mfs-sub"
        data-active={active ? "" : undefined}
        data-done={status.tone === "done" || status.tone === "failed" ? "" : undefined}
        onContextMenu={onContextMenu}
      >
        <button
          type="button"
          className="mfs-hit"
          aria-label={item.title}
          aria-current={active ? "page" : undefined}
          onClick={() => model.actions.openThread(item)}
        />
        <span className="mfs-pm">
          <MattrProviderMark driver={item.driver} />
        </span>
        <span className="mfs-t">{item.title}</span>
        <span className="mfs-st" data-tone={status.tone}>
          {label}
        </span>
      </div>
    </li>
  );
}

function ThreadRow({
  model,
  item,
  subagents,
  expanded,
  onToggle,
}: {
  model: MattrSidebarModel;
  item: MattrThreadItem;
  subagents: ReadonlyArray<MattrThreadItem>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const gt = useGT();
  const onContextMenu = rowMenuHandler(model, item);
  const [showAll, setShowAll] = useState(false);
  const active = item.key === model.activeThreadKey;
  const hasSubagents = subagents.length > 0;
  const visible = showAll ? subagents : subagents.slice(0, SUBAGENT_PREVIEW_LIMIT);
  const hidden = subagents.length - visible.length;
  return (
    <li data-mattr-thread-row={item.key}>
      <div
        className="mfs-row"
        data-active={active ? "" : undefined}
        data-unread={item.unread || item.attention === "needs" ? "" : undefined}
        onContextMenu={onContextMenu}
      >
        <button
          type="button"
          className="mfs-hit"
          aria-label={item.title}
          aria-current={active ? "page" : undefined}
          onClick={() => model.actions.openThread(item)}
        />
        <span className="mfs-pm" data-parent={hasSubagents ? "" : undefined}>
          <MattrProviderMark driver={item.driver} />
          {hasSubagents ? (
            <button
              type="button"
              className="mfs-disclose"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? gt("Hide subagents of {title}", { title: item.title })
                  : gt("Show {count} subagents of {title}", {
                      count: subagents.length,
                      title: item.title,
                    })
              }
              onClick={onToggle}
            >
              <ChevronRightIcon aria-hidden />
            </button>
          ) : null}
        </span>
        <span className="mfs-t">{item.title}</span>
        <ThreadTrailing item={item} nowMs={model.nowMs} />
      </div>
      {hasSubagents && expanded ? (
        <ul className="mfs-tree" aria-label={gt("Subagents of {title}", { title: item.title })}>
          {visible.map((child) => (
            <SubagentRow key={child.key} model={model} item={child} nowMs={model.nowMs} />
          ))}
          {hidden > 0 ? (
            <li>
              <div className="mfs-sub">
                <button
                  type="button"
                  className="mfs-hit"
                  aria-label={gt("Show {count} more subagents", { count: hidden })}
                  onClick={() => setShowAll(true)}
                />
                <span className="mfs-t mfs-more">{gt("{count} more", { count: hidden })}</span>
              </div>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function ThreadGroup({
  model,
  group,
  childrenByParent,
  collapsed,
  onToggleCollapsed,
  isExpanded,
  onToggleExpanded,
}: {
  model: MattrSidebarModel;
  group: MattrThreadGroup;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<MattrThreadItem>>;
  collapsed: boolean;
  onToggleCollapsed: (() => void) | null;
  isExpanded: (item: MattrThreadItem, subagents: ReadonlyArray<MattrThreadItem>) => boolean;
  onToggleExpanded: (item: MattrThreadItem, expanded: boolean) => void;
}) {
  const gt = useGT();
  const name = group.name ?? gt("No project");
  return (
    <section
      aria-label={onToggleCollapsed ? name : gt("Recent")}
      data-mattr-group={group.key ?? ""}
    >
      {onToggleCollapsed ? (
        <button
          type="button"
          className="mfs-lab"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <span>{name}</span>
          <em>{group.items.length}</em>
          <ChevronDownIcon
            aria-hidden
            className="mfs-fold"
            style={collapsed ? { rotate: "-90deg" } : undefined}
          />
        </button>
      ) : null}
      {collapsed ? null : (
        <ul>
          {group.items.map((item) => {
            const subagents = childrenByParent.get(item.key) ?? [];
            const expanded = isExpanded(item, subagents);
            return (
              <ThreadRow
                key={item.key}
                model={model}
                item={item}
                subagents={subagents}
                expanded={expanded}
                onToggle={() => onToggleExpanded(item, !expanded)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The default mattr rail ("final choice"): brand row, search, New thread, a 2x2 nav grid, the
 * activity scope, project groups with nested subagents, Crew, and Footer A's usage meters.
 */
export function MattrDefaultSidebar({ model }: { model: MattrSidebarModel }) {
  const gt = useGT();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const { items, children, projects, activeThreadKey, nowMs, keybindings, actions } = model;
  const [storedProjectFilter, setProjectFilter] = useMattrInboxProjectFilter();
  const [sort, setSort] = useMattrSortMode();
  const [collapsedGroups, setCollapsedGroups] = useMattrCollapsedGroups();
  const [filter, setFilter] = useState<MattrListFilter>("all");
  const [query, setQuery] = useState("");
  const [expansion, setExpansion] = useState<Readonly<Record<string, boolean>>>({});
  const crew = useCrewBots();

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const projectFilter =
    storedProjectFilter !== null && projects.some((project) => project.key === storedProjectFilter)
      ? storedProjectFilter
      : null;
  const projectSummary = summarizeProjects(items);
  const childrenByParent = indexChildrenByParent(children);
  const groups = buildThreadGroups(items, projects, { sort, projectFilter, filter });
  const needsCount = items.filter((item) => item.attention === "needs").length + crew.needsCount;
  const openPullRequests = countOpenPullRequests(items);
  const searching = query.trim().length > 0;
  const results = searching
    ? filterThreadsByQuery(
        [...items, ...children].filter(
          (item) => projectFilter === null || item.projectKey === projectFilter,
        ),
        query,
      ).slice(0, SEARCH_RESULT_LIMIT)
    : [];
  const atDefault = filter === "all" && projectFilter === null && !searching;
  const scopeName =
    projectFilter === null
      ? gt("All activity")
      : (projects.find((project) => project.key === projectFilter)?.name ?? gt("All activity"));
  const activeProjectKey =
    items.find((item) => item.key === activeThreadKey)?.projectKey ??
    children.find((item) => item.key === activeThreadKey)?.projectKey ??
    null;
  const searchHint = shortcutLabelForCommand(keybindings, "commandPalette.toggle") ?? "⌘K";
  const newThreadHint = shortcutLabelForCommand(keybindings, "chat.new");

  const isExpanded = (item: MattrThreadItem, subagents: ReadonlyArray<MattrThreadItem>) =>
    expansion[item.key] ?? shouldAutoExpand(item, subagents, activeThreadKey);
  const onToggleExpanded = (item: MattrThreadItem, next: boolean) =>
    setExpansion((current) => ({ ...current, [item.key]: next }));
  const toggleGroup = (key: string) =>
    setCollapsedGroups((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  const resetView = () => {
    setFilter("all");
    setProjectFilter(null);
    setQuery("");
  };
  const go = (to: () => void) => {
    closeMobile();
    to();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      setQuery("");
    } else if (event.key === "Enter" && results[0]) {
      event.preventDefault();
      actions.openThread(results[0]);
      setQuery("");
    }
  };

  const nothingListed = groups.length === 0;

  return (
    <div className="mfs" data-mattr-sidebar="default">
      <div className="mfs-ws">
        <MattrBrandMenu onNavigate={closeMobile} />
        <MattrTip label={gt("All activity")}>
          <button
            type="button"
            className="mfs-wi"
            aria-label={gt("Show all activity")}
            data-on={atDefault ? "" : undefined}
            onClick={resetView}
          >
            <InboxIcon aria-hidden />
          </button>
        </MattrTip>
      </div>

      <div className="mfs-hd">
        <label className="mfs-fld">
          <SearchIcon aria-hidden />
          <input
            type="text"
            role="searchbox"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={gt("Search threads")}
            aria-label={gt("Search threads")}
          />
          {query !== "" ? (
            <button
              type="button"
              className="mfs-clear"
              aria-label={gt("Clear thread search")}
              onClick={() => setQuery("")}
            >
              <XIcon aria-hidden />
            </button>
          ) : (
            <kbd className="mfs-kbd">{searchHint}</kbd>
          )}
        </label>
        <button
          type="button"
          className="mfs-nt"
          onClick={() => actions.newThread(projectFilter ?? activeProjectKey)}
        >
          <SquarePenIcon aria-hidden />
          {gt("New thread")}
          {newThreadHint ? <em>{newThreadHint}</em> : null}
        </button>
      </div>

      <nav className="mfs-qn" aria-label={gt("Sidebar navigation")}>
        <button
          type="button"
          className="mfs-ni"
          aria-current={pathname === "/issues" ? "page" : undefined}
          onClick={() =>
            go(() => void navigate({ to: "/issues", search: readIssueListPreferences() }))
          }
        >
          <IssueGlyph.issue aria-hidden />
          <span>{gt("Issues", { $context: "sidebar link to the list of issues" })}</span>
        </button>
        <button
          type="button"
          className="mfs-ni"
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
          <PullRequestGlyph.pullRequest aria-hidden />
          <span>{gt("PRs")}</span>
          {openPullRequests > 0 ? <em>{openPullRequests}</em> : null}
        </button>
        <button
          type="button"
          className="mfs-ni"
          aria-current={pathname === "/settings/scheduled-tasks" ? "page" : undefined}
          onClick={() => go(() => void navigate({ to: "/settings/scheduled-tasks" }))}
        >
          <ClockIcon aria-hidden />
          <span>{gt("Automations")}</span>
        </button>
        <button
          type="button"
          className="mfs-ni"
          aria-pressed={filter === "needs"}
          onClick={() => setFilter((current) => (current === "needs" ? "all" : "needs"))}
        >
          <BellIcon aria-hidden />
          <span>{gt("Needs you")}</span>
          {needsCount > 0 ? <span className="mfs-cnt">{needsCount}</span> : null}
        </button>
      </nav>

      <div className="mfs-aa">
        <MenuPrimitive.Root>
          <MenuPrimitive.Trigger
            className="mfs-scope"
            aria-label={gt("Activity scope: {scope}", { scope: scopeName })}
          >
            <span>{scopeName}</span>
            <ChevronRightIcon aria-hidden />
          </MenuPrimitive.Trigger>
          <MattrMenuPopup>
            <MenuPrimitive.RadioGroup
              value={projectFilter ?? ALL_ACTIVITY}
              onValueChange={(value: string) =>
                setProjectFilter(value === ALL_ACTIVITY ? null : value)
              }
            >
              <MattrMenuRadioItem
                value={ALL_ACTIVITY}
                label={gt("All activity")}
                hint={<em>{items.filter((item) => !item.settled && !item.snoozed).length}</em>}
              />
              {projects.map((project) => {
                const summary = projectSummary.get(project.key);
                return (
                  <MattrMenuRadioItem
                    key={project.key}
                    value={project.key}
                    label={project.name}
                    hint={
                      <>
                        {summary?.running ? (
                          <span
                            role="img"
                            aria-label={gt("Running")}
                            className="mfs-dot"
                            style={{ background: "var(--success)" }}
                          />
                        ) : null}
                        {summary ? <em>{summary.count}</em> : null}
                      </>
                    }
                  />
                );
              })}
            </MenuPrimitive.RadioGroup>
          </MattrMenuPopup>
        </MenuPrimitive.Root>
        <MattrTip label={sort === "project" ? gt("Sorted by project") : gt("Sorted by recent")}>
          <button
            type="button"
            className="mfs-sort"
            aria-label={sort === "project" ? gt("Sort by recent activity") : gt("Group by project")}
            onClick={() => setSort(sort === "project" ? "recent" : "project")}
          >
            <ArrowUpDownIcon aria-hidden />
          </button>
        </MattrTip>
      </div>

      <div className="mfs-list">
        {searching ? (
          <section aria-label={gt("Search results")}>
            <ul>
              {results.map((item) => (
                <li key={item.key}>
                  <div
                    className="mfs-row"
                    data-active={item.key === activeThreadKey ? "" : undefined}
                  >
                    <button
                      type="button"
                      className="mfs-hit"
                      aria-label={item.title}
                      onClick={() => {
                        actions.openThread(item);
                        setQuery("");
                      }}
                    />
                    <span className="mfs-pm">
                      <MattrProviderMark driver={item.driver} />
                    </span>
                    <span className="mfs-t">{item.title}</span>
                    <span className="mfs-a">{compactAge(item.activityAt, nowMs)}</span>
                  </div>
                </li>
              ))}
            </ul>
            {results.length === 0 ? <p className="mfs-empty">{gt("No threads match")}</p> : null}
          </section>
        ) : (
          <>
            {groups.map((group) => {
              const key = group.key ?? NO_PROJECT_GROUP;
              const grouped = sort === "project";
              const collapsed = grouped && filter === "all" && collapsedGroups.includes(key);
              return (
                <ThreadGroup
                  key={key}
                  model={model}
                  group={group}
                  childrenByParent={childrenByParent}
                  collapsed={collapsed}
                  onToggleCollapsed={grouped ? () => toggleGroup(key) : null}
                  isExpanded={isExpanded}
                  onToggleExpanded={onToggleExpanded}
                />
              );
            })}
            {nothingListed ? (
              <p className="mfs-empty">
                {filter === "needs" ? gt("Nothing needs you right now.") : gt("No threads yet.")}
              </p>
            ) : null}
          </>
        )}
        <MattrCrew crew={crew} nowMs={nowMs} />
      </div>

      <MattrFooter nowMs={nowMs} />
    </div>
  );
}
