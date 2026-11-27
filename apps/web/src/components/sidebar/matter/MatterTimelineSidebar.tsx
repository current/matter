/* oxlint-disable shadcn/no-unknown-classes -- the `mlf-*`, `mts-*` and `mfs-*` classes come from the fork stylesheets matter/timeline-feed.css, matter/timeline-sidebar.css and matter/sidebar.css, which load outside Tailwind. */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { CheckIcon, FolderPlusIcon, LayersIcon, SettingsIcon } from "lucide-react";
import {
  useState,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { contextMenuSourceOf, openContextMenuFromKeyboard } from "../../../contextMenuSource";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { shortcutLabelForCommand } from "../../../keybindings";
import { observeResize } from "../../../lib/observeResize";
import { readLocalApi } from "../../../localApi";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../../state/environments";
import { providerLogoColor } from "../../chat/ProviderInstanceIcon";
import { ProjectFavicon } from "../../ProjectFavicon";
import { readIssueListPreferences } from "../../issue/issueListPreferences";
import { readPullRequestListPreferences } from "../../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../../ui/sidebar";
import { SidebarProviderUpdatePill } from "../SidebarProviderUpdatePill";
import { SidebarThreadUndoNotice } from "../SidebarThreadUndoNotice";
import { SidebarUpdateArchitectureWarning } from "../SidebarUpdatePill";
import { useNavigateToMainApp } from "../mainAppLocation";
import { useActiveRowReveal, type SidebarRouteReveal } from "../routeReveal";
import {
  MatterBrandMenu,
  MatterCrew,
  MatterMenuItem,
  MatterMenuPopup,
  MatterMenuRadioItem,
  MatterProviderMark,
  MatterUpdateNotice,
  useCrewBots,
} from "./MatterDefaultSidebarParts";
import {
  formatResetLabel,
  indexChildrenByParent,
  parentsWithNeedsChild,
  pickUsageMeters,
  subagentStatus,
  type MatterChildItem,
  type MatterListFilter,
  type MatterUsageMeter,
} from "./matterFinalSidebar.logic";
import {
  buildTimelineSections,
  emptyTimelineSettledSection,
  isTimelineSectionOpen,
  timelineRaisesHand,
  timelineRowState,
  shortTimelineBranchLabel,
  visibleTimelineSubagents,
  type MatterTimelineNeedsKind,
  type MatterTimelineRowState,
  type MatterTimelineSection,
} from "./matterTimelineFeed.logic";
import type { MatterPullRequestState, MatterThreadItem } from "./matterSidebar.logic";
import { MatterTip } from "./MatterSidebarParts";
import {
  useMatterInboxProjectFilter,
  useMatterTimelineSort,
  useMatterTimelineSubagents,
} from "./matterSidebarStore";
import {
  BoardGlyph,
  BranchGlyph,
  ChecklistGlyph,
  ChevronDownGlyph,
  ChevronGlyph,
  ClockGlyph,
  CloseGlyph,
  ComposeGlyph,
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
  TargetGlyph,
  WaitingGlyph,
  WorktreeGlyph,
} from "./MatterTimelineIcons";
import {
  activeSubagentsByParent,
  compactWindowLabel,
  usageMeterTone,
  workspaceKind,
  type MatterTimelineSort,
} from "./matterTimelineSidebar.logic";
import type {
  MatterSidebarModel,
  MatterSidebarProject,
  MatterThreadMenuAction,
} from "./useMatterSidebarModel";
import { useMatterSettledShelf } from "./useMatterSettledShelf";

const ALL_ACTIVITY = "__all__";
const FOLDS_STORAGE_KEY = "mattr:sidebar:timeline-folds:v1";
const METER_LIMIT = 5;
const Folds = Schema.Record(Schema.String, Schema.Boolean);
const NO_FOLDS: Readonly<Record<string, boolean>> = {};
const ROW_FOCUS_STOPS =
  "button.mts-hit, button.mts-fold, button.mlf-elsewhere, button.mlf-show-more, button.mfs-hit, a.mfs-row";

const PR_GLYPH: Record<MatterPullRequestState, typeof PullRequestOpenGlyph> = {
  open: PullRequestOpenGlyph,
  draft: PullRequestOpenGlyph,
  merged: PullRequestMergedGlyph,
  closed: PullRequestClosedGlyph,
};

type GT = ReturnType<typeof useGT>;
type MenuAnchor = MenuPrimitive.Positioner.Props["anchor"];

interface WebThreadMenuState {
  readonly item: MatterThreadItem;
  readonly anchor: MenuAnchor;
}

function pointAnchor(x: number, y: number): MenuAnchor {
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

/** Up, Down, Home and End walk the rows and section folds, like a native source list. */
function moveRowFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const { key, target } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
  if (!(target instanceof HTMLElement) || !target.matches(ROW_FOCUS_STOPS)) return;
  const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(ROW_FOCUS_STOPS)];
  const next =
    key === "Home"
      ? stops[0]
      : key === "End"
        ? stops.at(-1)
        : stops[stops.indexOf(target) + (key === "ArrowDown" ? 1 : -1)];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

function needsLabel(kind: MatterTimelineNeedsKind, gt: GT): string {
  switch (kind) {
    case "approval":
      return gt("Approval", { $context: "a thread is waiting for the user to approve an action" });
    case "input":
      return gt("Question", { $context: "a thread is waiting for the user to answer a question" });
    case "limited":
      return gt("Usage limit", { $context: "a thread stopped at its provider's usage limit" });
    case "subagent":
      return gt("Subagent", { $context: "one of a thread's subagents is waiting for the user" });
    case "request":
      return gt("Guest", { $context: "a guest of a thread is waiting for its owner" });
  }
}

function sectionLabel(section: MatterTimelineSection, nowMs: number, gt: GT): string {
  switch (section.kind) {
    case "needs":
      return gt("Needs you");
    case "pinned":
      return gt("Pinned");
    case "working":
      return gt("Active", {
        $context: "threads whose agents are working or waiting on background work",
      });
    case "today":
      return gt("Today");
    case "yesterday":
      return gt("Yesterday");
    case "week":
      return gt("Previous 7 days");
    case "days30":
      return gt("Previous 30 days");
    case "month": {
      const month = new Date(section.monthStartMs ?? nowMs);
      return new Intl.DateTimeFormat(
        undefined,
        month.getFullYear() === new Date(nowMs).getFullYear()
          ? { month: "long" }
          : { month: "long", year: "numeric" },
      ).format(month);
    }
    case "snoozed":
      return gt("Snoozed", { $context: "sidebar section" });
    case "settled":
      return gt("Settled", { $context: "sidebar section" });
  }
}

/** What a screen reader hears after a row's title: everything its two lines show. */
function rowSummary(item: MatterThreadItem, state: MatterTimelineRowState, gt: GT): string {
  const parts: string[] = [];
  switch (state.tone) {
    case "needs":
      parts.push(gt("Needs you: {reason}", { reason: needsLabel(state.kind, gt) }), state.age);
      break;
    case "running":
      parts.push(gt("Working for {duration}", { duration: state.elapsed }));
      break;
    case "background":
      parts.push(gt("Waiting on background work for {duration}", { duration: state.elapsed }));
      break;
    case "failed":
      parts.push(gt("Failed"));
      if (state.age !== "") parts.push(state.age);
      break;
    case "idle":
      if (item.unread) parts.push(gt("Unread"));
      if (state.age !== "") parts.push(state.age);
      break;
  }
  if (item.projectName !== null) parts.push(item.projectName);
  if (item.providerName !== null) parts.push(item.providerName);
  if (item.branch !== null) parts.push(gt("Branch {branch}", { branch: item.branch }));
  if (item.pullRequest !== null) {
    parts.push(gt("Pull request #{number}", { number: item.pullRequest.number }));
  }
  return parts.join(", ");
}

/** The accessible id for a row's summary; thread keys only hold id-safe characters. */
const summaryId = (key: string) => `mlf-desc-${key}`;

interface TimelineRowContext {
  readonly subagents: ReadonlyMap<string, ReadonlyArray<MatterChildItem>>;
  readonly needsChildParents: ReadonlySet<string>;
  /** The row to highlight when the open thread is a subagent the list doesn't show. */
  readonly hiddenActiveParent: string | null;
  /** The open thread when it is a finished subagent, which still gets a row under its thread. */
  readonly openFinishedChild: MatterChildItem | null;
  /** The row a folded section still shows: the open thread, or the thread its subagent runs under. */
  readonly openRowKey: string | null;
  readonly expandedSubagents: ReadonlySet<string>;
  readonly toggleSubagents: (parentKey: string) => void;
  readonly sort: MatterTimelineSort;
  /** The list shows one project, so rows lead with their provider instead of its icon. */
  readonly projectScoped: boolean;
  readonly showRowMenuButton: boolean;
  readonly openWebMenu: (item: MatterThreadItem, anchor: MenuAnchor) => void;
  readonly revealActiveRow: (row: HTMLElement | null, rowKey: string) => (() => void) | undefined;
  readonly projectByKey: ReadonlyMap<string, MatterSidebarProject>;
}

function hasNativeContextMenu(): boolean {
  return (
    typeof window !== "undefined" && window.desktopBridge !== undefined && readLocalApi() != null
  );
}

function openRowContextMenu(
  event: ReactMouseEvent,
  model: MatterSidebarModel,
  item: MatterThreadItem,
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

function TimelineProjectIcon({
  project,
  onOpen,
}: {
  project: MatterSidebarProject;
  onOpen: () => void;
}) {
  return (
    <MatterTip label={project.name} side="top">
      <span className="mlf-proj-icon" onClick={onOpen}>
        <ProjectFavicon project={project.group} className="size-3.5" />
      </span>
    </MatterTip>
  );
}

function TimelineRow({
  model,
  item,
  density,
  context,
}: {
  model: MatterSidebarModel;
  item: MatterThreadItem;
  density: MatterTimelineSection["density"];
  context: TimelineRowContext;
}) {
  const gt = useGT();
  const active = item.key === model.activeThreadKey;
  const holdsActive = context.hiddenActiveParent === item.key;
  const state = timelineRowState(item, {
    childNeedsYou: context.needsChildParents.has(item.key),
    sort: context.sort,
    nowMs: model.nowMs,
  });
  const kind = workspaceKind(item);
  const pr = item.pullRequest;
  const PrGlyph = pr === null ? null : PR_GLYPH[pr.state];
  const revealKey = active ? item.key : holdsActive ? model.activeThreadKey : null;
  const project =
    context.projectScoped || item.projectKey === null
      ? undefined
      : context.projectByKey.get(item.projectKey);
  return (
    <div
      ref={revealKey !== null ? (row) => context.revealActiveRow(row, revealKey) : undefined}
      className="mts-row mlf-row"
      data-matter-timeline-row={item.key}
      data-density={density}
      data-state={state.tone}
      data-active={active || holdsActive ? "" : undefined}
      data-unread={item.unread ? "" : undefined}
      data-pinned={item.pinned ? "" : undefined}
      onContextMenu={(event) => openRowContextMenu(event, model, item, context.openWebMenu)}
      onKeyDown={openContextMenuFromKeyboard}
    >
      <button
        type="button"
        className="mts-hit"
        aria-label={item.title}
        aria-describedby={summaryId(item.key)}
        aria-current={active ? "page" : undefined}
        onClick={() => model.actions.openThread(item)}
      />
      <span id={summaryId(item.key)} className="sr-only">
        {rowSummary(item, state, gt)}
      </span>
      <span className="mts-l1">
        <span className="mts-pi" aria-hidden>
          {project !== undefined ? (
            <TimelineProjectIcon project={project} onOpen={() => model.actions.openThread(item)} />
          ) : (
            <MatterProviderMark driver={item.driver} />
          )}
        </span>
        <span className="mts-t" aria-hidden>
          {item.title}
        </span>
        {item.interactionMode === "goal" ? (
          <TargetGlyph className="mts-goal" role="img" aria-label={gt("Goal mode")} />
        ) : null}
        {item.pinned ? <PinGlyph className="mts-pin" role="img" aria-label={gt("Pinned")} /> : null}
        {density === "compact" && pr !== null && PrGlyph !== null ? (
          <span className="mts-pr mlf-pr-mark" data-state={pr.state}>
            <PrGlyph role="img" aria-label={`#${pr.number}`} />
          </span>
        ) : null}
        {state.tone === "needs" ? (
          <>
            {state.age !== "" ? (
              <span className="mts-age" aria-hidden>
                {state.age}
              </span>
            ) : null}
            <span className="mts-need" aria-hidden />
          </>
        ) : state.tone === "running" ? (
          <span className="mlf-st" data-tone="running" aria-hidden>
            {state.elapsed}
            <SpinnerGlyph className="mts-spin" />
          </span>
        ) : state.tone === "background" ? (
          <span className="mlf-st" data-tone="background" aria-hidden>
            {state.elapsed}
            <WaitingGlyph className="mlf-wait" />
          </span>
        ) : state.tone === "failed" ? (
          density === "full" ? (
            <>
              {state.age !== "" ? (
                <span className="mts-age" aria-hidden>
                  {state.age}
                </span>
              ) : null}
              <span className="mts-fail" aria-hidden />
            </>
          ) : (
            <span className="mlf-st" data-tone="failed" aria-hidden>
              {gt("Failed")}
              <span className="mts-fail" aria-hidden />
            </span>
          )
        ) : (
          <>
            {state.age !== "" ? (
              <span className="mts-age" aria-hidden>
                {state.age}
              </span>
            ) : null}
            {item.unread ? <span className="mts-unread" aria-hidden /> : null}
          </>
        )}
        {context.showRowMenuButton ? (
          <button
            type="button"
            className="mts-more"
            aria-label={gt("Actions for {title}", { title: item.title })}
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
      {density === "full" ? (
        <span className="mts-l2" aria-hidden>
          {project !== undefined && item.driver !== null ? (
            <span className="mts-pi mlf-l2-provider">
              <MatterProviderMark driver={item.driver} />
            </span>
          ) : null}
          {!context.projectScoped ? (
            <span className="mts-proj">{item.projectName ?? gt("No project")}</span>
          ) : null}
          {item.branch !== null ? (
            <MatterTip
              label={
                kind === "worktree"
                  ? gt("Worktree · {branch}", { branch: item.branch })
                  : item.branch
              }
              side="top"
            >
              <span
                className="mts-br"
                data-matter-workspace={kind}
                onClick={() => model.actions.openThread(item)}
              >
                {kind === "worktree" ? <WorktreeGlyph /> : <BranchGlyph />}
                <span>{shortTimelineBranchLabel(item.branch, item.projectName)}</span>
              </span>
            </MatterTip>
          ) : kind === "worktree" ? (
            <WorktreeGlyph className="mts-mi" data-matter-workspace="worktree" />
          ) : null}
          {state.tone === "needs" ? (
            <span className="mlf-st" data-tone="needs">
              {needsLabel(state.kind, gt)}
            </span>
          ) : state.tone === "failed" ? (
            <span className="mlf-st" data-tone="failed">
              {gt("Failed")}
            </span>
          ) : state.tone === "running" ? (
            <span className="mlf-st" data-tone="running">
              {gt("Working", { $context: "a thread's agent is running now" })}
            </span>
          ) : state.tone === "background" ? (
            <span className="mlf-st" data-tone="background">
              {gt("Waiting", {
                $context: "a thread's agent resumes by itself once its background work ends",
              })}
            </span>
          ) : pr !== null && PrGlyph !== null ? (
            <span className="mts-pr" data-state={pr.state}>
              <PrGlyph />
              {`#${pr.number}`}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function TimelineSubagent({
  model,
  item,
  context,
}: {
  model: MatterSidebarModel;
  item: MatterChildItem;
  context: TimelineRowContext;
}) {
  const gt = useGT();
  const active = item.key === model.activeThreadKey;
  const status = subagentStatus(item, model.nowMs);
  const statusText =
    status.tone === "needs"
      ? gt("Needs you: {reason}", { reason: needsLabel(item.needsKind ?? "request", gt) })
      : status.tone === "running"
        ? gt("Working for {duration}", { duration: status.age })
        : status.tone === "failed"
          ? gt("Failed")
          : gt("Done");
  return (
    <li
      ref={active ? (row) => context.revealActiveRow(row, item.key) : undefined}
      className="mts-sub"
      data-matter-timeline-subagent={item.key}
      data-active={active ? "" : undefined}
      onContextMenu={(event) => openRowContextMenu(event, model, item, context.openWebMenu)}
      onKeyDown={openContextMenuFromKeyboard}
    >
      <button
        type="button"
        className="mts-hit"
        aria-label={item.title}
        aria-describedby={summaryId(item.key)}
        aria-current={active ? "page" : undefined}
        onClick={() => model.actions.openThread(item)}
      />
      <span id={summaryId(item.key)} className="sr-only">
        {item.providerName === null ? statusText : `${statusText}, ${item.providerName}`}
      </span>
      <span className="mts-conn" aria-hidden />
      <span className="mts-pi">
        <MatterProviderMark driver={item.driver} />
      </span>
      <span className="mts-st">{item.title}</span>
      {context.showRowMenuButton ? (
        <button
          type="button"
          className="mts-more"
          aria-label={gt("Actions for {title}", { title: item.title })}
          aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation();
            context.openWebMenu(item, event.currentTarget);
          }}
        >
          <MoreGlyph />
        </button>
      ) : null}
      <span className="mts-sm" data-tone={status.tone} aria-hidden>
        {status.tone === "needs" ? (
          needsLabel(item.needsKind ?? "request", gt)
        ) : status.tone === "running" ? (
          <>
            <span className="mts-sub-dot" aria-hidden />
            {status.age}
          </>
        ) : status.tone === "failed" ? (
          gt("Failed")
        ) : (
          gt("Done")
        )}
      </span>
    </li>
  );
}

function TimelineSubagents({
  model,
  parent,
  context,
}: {
  model: MatterSidebarModel;
  parent: MatterThreadItem;
  context: TimelineRowContext;
}) {
  const gt = useGT();
  const active = context.subagents.get(parent.key) ?? [];
  const openFinished =
    context.openFinishedChild?.ancestorKey === parent.key ? context.openFinishedChild : null;
  if (active.length === 0 && openFinished === null) return null;
  const expanded = context.expandedSubagents.has(parent.key);
  const collapsed = visibleTimelineSubagents(active, {
    expanded: false,
    activeThreadKey: model.activeThreadKey,
  });
  const rows = expanded ? active : collapsed.shown;
  return (
    <ul
      role="list"
      className="mlf-subs"
      aria-label={gt("Subagents of {title}", { title: parent.title })}
    >
      {rows.map((child) => (
        <TimelineSubagent key={child.key} model={model} item={child} context={context} />
      ))}
      {openFinished !== null ? (
        <TimelineSubagent model={model} item={openFinished} context={context} />
      ) : null}
      {collapsed.hiddenCount > 0 ? (
        <li className="mts-sub mlf-more">
          <button
            type="button"
            className="mts-hit"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? gt("Show fewer subagents")
                : gt("Show {count} more running subagents", { count: collapsed.hiddenCount })
            }
            onClick={() => context.toggleSubagents(parent.key)}
          />
          <span className="mts-conn" aria-hidden />
          <span className="mts-st">
            {expanded
              ? gt("Show fewer")
              : gt("{count} more running", { count: collapsed.hiddenCount })}
          </span>
          <ChevronGlyph className="mts-cr" />
        </li>
      ) : null}
    </ul>
  );
}

function TimelineSection({
  model,
  section,
  open,
  onToggle,
  context,
  count: totalCount,
  footer: lastRow,
}: {
  model: MatterSidebarModel;
  section: MatterTimelineSection;
  open: boolean;
  onToggle: () => void;
  context: TimelineRowContext;
  /** The header's count when the section holds more than its local rows. */
  count?: number;
  /** A last row inside the open list, such as Show more. */
  footer?: ReactNode;
}) {
  const gt = useGT();
  const label = sectionLabel(section, model.nowMs, gt);
  const count = totalCount ?? section.items.length;
  const footer = lastRow ?? null;
  const rows = open
    ? section.items
    : section.items.filter((item) => item.key === context.openRowKey);
  const listId = `mlf-section-${section.id}`;
  const hiddenUnread = !open && section.items.some((item) => item.unread && !rows.includes(item));
  return (
    <section aria-label={label} data-matter-timeline-section={section.id}>
      <h3 className="mts-sec mlf-sec" data-kind={section.kind}>
        {section.foldable ? (
          <button
            type="button"
            className="mts-fold"
            aria-label={
              hiddenUnread
                ? gt("{label}, {count}, has unread threads", { label, count })
                : `${label}, ${count}`
            }
            aria-expanded={open}
            aria-controls={rows.length > 0 || footer !== null ? listId : undefined}
            onClick={onToggle}
          >
            <span>{label}</span>
            <span className="mlf-count">{count}</span>
            {hiddenUnread ? <span className="mts-unread mlf-fold-unread" aria-hidden /> : null}
            <ChevronGlyph className="mts-cr" />
          </button>
        ) : (
          <>
            <span>{label}</span>
            <span className="mlf-count">{count}</span>
          </>
        )}
      </h3>
      {rows.length > 0 || (open && footer !== null) ? (
        <ul id={listId} role="list" className="mts-rows mlf-rows" data-density={section.density}>
          {rows.map((item) => (
            <li key={item.key}>
              <TimelineRow model={model} item={item} density={section.density} context={context} />
              <TimelineSubagents model={model} parent={item} context={context} />
            </li>
          ))}
          {open ? footer : null}
        </ul>
      ) : null}
    </section>
  );
}

function meterTip(meter: MatterUsageMeter, nowMs: number, gt: GT, spoken = false): string {
  const tone = usageMeterTone(meter.usedPercent);
  const used =
    tone === "critical"
      ? gt("{percent}% used, at the limit", { percent: meter.usedPercent })
      : tone === "warn"
        ? gt("{percent}% used, close to the limit", { percent: meter.usedPercent })
        : gt("{percent}% used", { percent: meter.usedPercent });
  const soon = formatResetLabel(meter.resetsAt, nowMs);
  const window = spoken ? meter.windowLabel : compactWindowLabel(meter.windowLabel);
  const head = `${meter.accountName} · ${window} · ${used}`;
  return soon === null ? head : `${head} · ${gt("Resets in {duration}", { duration: soon })}`;
}

/** Every provider's tightest limit in one row: its logo, percent and bar. */
function TimelineMeters({
  meters,
  nowMs,
  onOpen,
}: {
  meters: ReadonlyArray<MatterUsageMeter>;
  nowMs: number;
  onOpen: () => void;
}) {
  const gt = useGT();
  if (meters.length === 0) return null;
  return (
    <div
      className="mts-use mlf-use-row"
      role="group"
      aria-label={gt("Usage limits")}
      style={{ "--mlf-meters": Math.min(meters.length, 4) } as CSSProperties}
    >
      {meters.map((meter) => (
        <MatterTip key={meter.key} label={meterTip(meter, nowMs, gt)} side="top">
          <button
            type="button"
            className="mts-m"
            data-tone={usageMeterTone(meter.usedPercent)}
            aria-label={meterTip(meter, nowMs, gt, true)}
            onClick={onOpen}
          >
            <span className="mts-mh">
              <span
                className="mts-pi"
                data-monochrome={providerLogoColor(meter.driver) === null ? "" : undefined}
              >
                <MatterProviderMark driver={meter.driver} />
              </span>
              <span className="mts-v">{`${meter.usedPercent}%`}</span>
            </span>
            <span className="mts-tr" aria-hidden>
              <i style={{ width: `${meter.usedPercent}%` }} />
            </span>
          </button>
        </MatterTip>
      ))}
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
  onAction: (item: MatterThreadItem, action: MatterThreadMenuAction) => void;
}) {
  const gt = useGT();
  const item = menu?.item ?? null;
  const run = (action: MatterThreadMenuAction) => {
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
      <MatterMenuPopup anchor={menu?.anchor} align="start" side="bottom">
        {item !== null ? (
          <>
            <MatterMenuItem label={gt("Open thread")} onClick={() => run("open")} />
            <MenuPrimitive.Separator className="mfs-menu-sep" />
            <MatterMenuItem
              label={item.pinned ? gt("Unpin") : gt("Pin")}
              onClick={() => run(item.pinned ? "unpin" : "pin")}
            />
            <MatterMenuItem
              label={item.unread ? gt("Mark as read") : gt("Mark as unread")}
              onClick={() => run(item.unread ? "mark-read" : "mark-unread")}
            />
            <MatterMenuItem
              label={item.settled ? gt("Unsettle") : gt("Settle")}
              onClick={() => run(item.settled ? "unsettle" : "settle")}
            />
            <MatterMenuItem label={gt("Copy link")} onClick={() => run("copy-link")} />
            {item.projectKey !== null ? (
              <MatterMenuItem
                label={gt("Project settings")}
                onClick={() => run("project-settings")}
              />
            ) : null}
            <MenuPrimitive.Separator className="mfs-menu-sep" />
            <MatterMenuItem label={gt("Archive")} onClick={() => run("archive")} />
          </>
        ) : null}
      </MatterMenuPopup>
    </MenuPrimitive.Root>
  );
}

/**
 * The feed leads with what waits on you and what is working, rows lead with their project's icon
 * and say what they wait on or how long they have run, older threads drop to one line under dated
 * folds, and a thread's subagents stay to a few rows.
 */
export function MatterTimelineSidebar({
  model,
  routeReveal,
}: {
  model: MatterSidebarModel;
  routeReveal?: SidebarRouteReveal | undefined;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const { items, children, projects, activeThreadKey, nowMs, keybindings, actions } = model;
  const [storedProjectFilter, setProjectFilter] = useMatterInboxProjectFilter();
  const [sort, setSort] = useMatterTimelineSort();
  const [showSubagents, setShowSubagents] = useMatterTimelineSubagents();
  const [folds, setFolds] = useLocalStorage<
    Readonly<Record<string, boolean>>,
    Readonly<Record<string, boolean>>
  >(FOLDS_STORAGE_KEY, NO_FOLDS, Folds);
  const [filter, setFilter] = useState<MatterListFilter>("all");
  const [expandedSubagents, setExpandedSubagents] = useState<ReadonlySet<string>>(new Set());
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
    METER_LIMIT,
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
  const feed = buildTimelineSections(items, {
    nowMs,
    sort,
    projectFilter,
    filter,
    needsChildParents,
  });
  const settledSection =
    feed.find((section) => section.kind === "settled") ?? emptyTimelineSettledSection();
  const settledOpen = isTimelineSectionOpen(settledSection, folds);
  const settledShelf = useMatterSettledShelf({
    items: settledSection.items,
    projects,
    projectFilter,
    open: settledOpen && filter === "all",
    activeThreadKey,
  });
  const sections =
    filter === "all" && settledShelf.total > 0 && !feed.includes(settledSection)
      ? [...feed, settledSection]
      : feed;
  const activeChild = children.find((child) => child.key === activeThreadKey);
  const activeChildHasRow =
    activeChild !== undefined &&
    (subagents.get(activeChild.ancestorKey) ?? []).some((child) => child.key === activeChild.key);
  const rowContext: TimelineRowContext = {
    subagents,
    needsChildParents,
    hiddenActiveParent:
      activeChild !== undefined && !showSubagents ? activeChild.ancestorKey : null,
    openFinishedChild:
      activeChild !== undefined && showSubagents && !activeChildHasRow ? activeChild : null,
    openRowKey: activeChild?.ancestorKey ?? activeThreadKey,
    expandedSubagents,
    toggleSubagents: (parentKey) =>
      setExpandedSubagents((current) => {
        const next = new Set(current);
        if (!next.delete(parentKey)) next.add(parentKey);
        return next;
      }),
    sort,
    projectScoped: projectFilter !== null,
    showRowMenuButton: !hasNativeContextMenu() || isMobile,
    openWebMenu: (item, anchor) => setWebMenu({ item, anchor }),
    revealActiveRow,
    projectByKey: new Map(projects.map((project) => [project.key, project])),
  };
  const needsRows = items.filter((item) => timelineRaisesHand(item, needsChildParents));
  const needsCount = needsRows.length + crew.needsCount;
  const needsByProject = new Map<string, number>();
  for (const item of needsRows) {
    if (item.projectKey === null) continue;
    needsByProject.set(item.projectKey, (needsByProject.get(item.projectKey) ?? 0) + 1);
  }
  const needsElsewhere =
    projectFilter === null
      ? 0
      : needsRows.filter((item) => item.projectKey !== projectFilter).length;
  const scopeName =
    projectFilter === null
      ? gt("All activity")
      : (projects.find((project) => project.key === projectFilter)?.name ?? gt("All activity"));
  const activeProjectKey =
    items.find((item) => item.key === activeThreadKey)?.projectKey ??
    activeChild?.projectKey ??
    null;
  const newThreadHint = shortcutLabelForCommand(keybindings, "chat.new");
  const searchHint = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const onSettings = pathname.startsWith("/settings");

  const handleWebAction = (item: MatterThreadItem, action: MatterThreadMenuAction) => {
    if (actions.runThreadAction) {
      actions.runThreadAction(item, action);
      return;
    }
    if (action === "open") actions.openThread(item);
  };

  return (
    <div className="mfs mts mlf" data-matter-sidebar="timeline">
      <div className="mts-brand">
        <MatterBrandMenu
          onNavigate={closeMobile}
          caret={<ChevronDownGlyph className="mfs-caret" />}
        />
        <MatterTip label={searchHint ? `${gt("Search")}  ${searchHint}` : gt("Search")}>
          <button
            type="button"
            className="mts-ib"
            aria-label={gt("Search")}
            onClick={() => openCommandPalette()}
          >
            <SearchGlyph />
          </button>
        </MatterTip>
        <MatterTip
          label={
            filter === "needs"
              ? gt("Show all threads")
              : needsCount > 0
                ? gt("Show only what needs you")
                : gt("Nothing needs you")
          }
        >
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
        </MatterTip>
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
          aria-current={pathname === "/tasks" ? "page" : undefined}
          onClick={() => go(() => void navigate({ to: "/tasks" }))}
        >
          <ChecklistGlyph />
          <span>{gt("Tasks")}</span>
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
          <MatterMenuPopup>
            <MenuPrimitive.RadioGroup
              value={projectFilter ?? ALL_ACTIVITY}
              onValueChange={(value: string) =>
                setProjectFilter(value === ALL_ACTIVITY ? null : value)
              }
            >
              <MatterMenuRadioItem
                value={ALL_ACTIVITY}
                label={
                  <span className="mlf-menu-proj">
                    <LayersIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    <span>{gt("All activity")}</span>
                  </span>
                }
              />
              {projects.map((project) => {
                const waiting = needsByProject.get(project.key) ?? 0;
                return (
                  <MatterMenuRadioItem
                    key={project.key}
                    value={project.key}
                    label={
                      <span className="mlf-menu-proj">
                        <ProjectFavicon project={project.group} className="size-3.5" />
                        <span>{project.name}</span>
                      </span>
                    }
                    hint={
                      waiting > 0 ? (
                        <span
                          className="mlf-menu-needs"
                          aria-label={gt("Needs you: {count}", { count: waiting })}
                        >
                          {waiting}
                        </span>
                      ) : null
                    }
                  />
                );
              })}
            </MenuPrimitive.RadioGroup>
            <MenuPrimitive.Separator className="mfs-menu-sep" />
            <MatterMenuItem
              icon={
                <>
                  <span className="mlf-menu-gap" aria-hidden />
                  <FolderPlusIcon aria-hidden />
                </>
              }
              label={gt("Add project")}
              onClick={() => go(() => openCommandPalette({ open: "add-project" }))}
            />
            <MatterMenuItem
              icon={
                <>
                  <span className="mlf-menu-gap" aria-hidden />
                  <SettingsIcon aria-hidden />
                </>
              }
              label={gt("Project settings")}
              onClick={() =>
                go(() =>
                  projectFilter === null
                    ? void navigate({ to: "/settings/projects" })
                    : void navigate({
                        to: "/projects/$projectKey",
                        params: { projectKey: projectFilter },
                      }),
                )
              }
            />
          </MatterMenuPopup>
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
        <MenuPrimitive.Root>
          <MatterTip label={gt("View options")}>
            <MenuPrimitive.Trigger
              className="mts-so"
              aria-label={
                sort === "created" ? gt("View options: sorted by created") : gt("View options")
              }
              data-sort={sort}
            >
              <SortGlyph />
              {sort === "created" ? <span className="mts-so-lab">{gt("Created")}</span> : null}
            </MenuPrimitive.Trigger>
          </MatterTip>
          <MatterMenuPopup align="end">
            <MenuPrimitive.Group>
              <MenuPrimitive.GroupLabel className="mfs-menu-label">
                {gt("Sort", { $context: "heading over the ways to order the thread list" })}
              </MenuPrimitive.GroupLabel>
              <MenuPrimitive.RadioGroup
                value={sort}
                onValueChange={(value: MatterTimelineSort) => setSort(value)}
              >
                <MatterMenuRadioItem value="updated" label={gt("Last update")} />
                <MatterMenuRadioItem
                  value="created"
                  label={gt("Created", { $context: "sort threads by when they were created" })}
                />
              </MenuPrimitive.RadioGroup>
            </MenuPrimitive.Group>
            <MenuPrimitive.Separator className="mfs-menu-sep" />
            <MenuPrimitive.Group>
              <MenuPrimitive.GroupLabel className="mfs-menu-label">
                {gt("Show", { $context: "heading over what the thread list includes" })}
              </MenuPrimitive.GroupLabel>
              <MenuPrimitive.CheckboxItem
                className="mfs-menu-item"
                checked={showSubagents}
                onCheckedChange={(checked: boolean) => setShowSubagents(checked)}
              >
                <span className="inline-flex size-3.5 items-center justify-center">
                  <MenuPrimitive.CheckboxItemIndicator>
                    <CheckIcon aria-hidden className="mfs-menu-check" />
                  </MenuPrimitive.CheckboxItemIndicator>
                </span>
                <span className="mfs-menu-text">{gt("Active subagents")}</span>
              </MenuPrimitive.CheckboxItem>
            </MenuPrimitive.Group>
          </MatterMenuPopup>
        </MenuPrimitive.Root>
      </div>

      <div ref={observeScrollFade} className="mts-list" onKeyDown={moveRowFocus}>
        {needsElsewhere > 0 ? (
          <button
            type="button"
            className="mlf-elsewhere"
            aria-label={gt("Needs you in other projects: {count}. Show all activity", {
              count: needsElsewhere,
            })}
            onClick={() => setProjectFilter(null)}
          >
            <span className="mts-need" aria-hidden />
            <span>{gt("Needs you in other projects")}</span>
            <span className="mlf-count">{needsElsewhere}</span>
            <ChevronGlyph className="mts-cr" aria-hidden />
          </button>
        ) : null}
        {sections.map((section) => {
          const open = isTimelineSectionOpen(section, folds);
          const settled = section.kind === "settled";
          return (
            <TimelineSection
              key={section.id}
              model={model}
              section={settled ? { ...section, items: settledShelf.rows } : section}
              open={open}
              onToggle={() => setFolds((current) => ({ ...current, [section.id]: !open }))}
              context={rowContext}
              {...(settled
                ? {
                    count: settledShelf.total,
                    footer:
                      settledShelf.hiddenCount > 0 ? (
                        <li>
                          <button
                            type="button"
                            className="mlf-show-more"
                            aria-disabled={settledShelf.loading}
                            onClick={settledShelf.showMore}
                          >
                            <ChevronDownGlyph aria-hidden />
                            <span>
                              {settledShelf.loading
                                ? gt("Loading")
                                : settledShelf.failed
                                  ? gt("Could not load older threads. Retry")
                                  : gt(
                                      "{count, plural, one {Show {count} more} other {Show {count} more}}",
                                      { count: settledShelf.nextCount },
                                    )}
                            </span>
                          </button>
                        </li>
                      ) : null,
                  }
                : {})}
            />
          );
        })}
        {sections.length === 0 ? (
          <div className="mlf-empty">
            <p className="mfs-empty">
              {filter === "needs"
                ? projectFilter === null
                  ? gt("Nothing needs you right now.")
                  : gt("Nothing in {project} needs you.", { project: scopeName })
                : projectFilter === null
                  ? gt("No threads yet.")
                  : gt("No threads in {project} yet.", { project: scopeName })}
            </p>
            {filter === "all" ? (
              <button
                type="button"
                className="mlf-empty-action"
                onClick={() => actions.newThread(projectFilter ?? activeProjectKey)}
              >
                <ComposeGlyph />
                <span>
                  {projectFilter === null
                    ? gt("New thread")
                    : gt("New thread in {project}", { project: scopeName })}
                </span>
              </button>
            ) : null}
            {projectFilter !== null ? (
              <button
                type="button"
                className="mlf-empty-action"
                onClick={() => setProjectFilter(null)}
              >
                <LayersIcon aria-hidden />
                <span>{gt("Show all activity")}</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <MatterCrew crew={crew} nowMs={nowMs} />
      </div>

      <TimelineWebContextMenu
        menu={webMenu}
        onClose={() => setWebMenu(null)}
        onAction={handleWebAction}
      />

      <div className="mfs-notices">
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
        <SidebarThreadUndoNotice />
      </div>
      <TimelineMeters
        meters={meters}
        nowMs={nowMs}
        onOpen={() => go(() => void navigate({ to: "/usage" }))}
      />
      <footer className="mts-foot" data-matter-footer>
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
        <ul className="mlf-foot-update">
          <MatterUpdateNotice />
        </ul>
        <MatterTip label={gt("Keyboard shortcuts")} side="top">
          <button
            type="button"
            className="mts-help"
            aria-label={gt("Keyboard shortcuts")}
            onClick={() => go(() => void navigate({ to: "/settings/keybindings" }))}
          >
            <HelpGlyph />
          </button>
        </MatterTip>
      </footer>
    </div>
  );
}
