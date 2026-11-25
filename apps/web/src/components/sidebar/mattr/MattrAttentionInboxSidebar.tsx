import { useGT } from "gt-react";
import {
  ActivityIcon,
  BellIcon,
  CircleCheckIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { useEnabledBotProviderAddons } from "../../../addons/useAddonRegistry";
import { useBotsState } from "../../bots/botsStore";
import { Button } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  bucketInboxThreads,
  countLiveThreadsByProject,
  filterThreadsByQuery,
  type MattrThreadItem,
} from "./mattrSidebar.logic";
import {
  botNeedsAttention,
  compactAge,
  MattrBotLink,
  MattrBotsSlot,
  MattrSectionHeader,
  MattrThreadRow,
  MattrVoiceTrigger,
} from "./MattrSidebarParts";
import { useMattrInboxProjectFilter, useMattrQuietExpanded } from "./mattrSidebarStore";
import type { MattrSidebarModel } from "./useMattrSidebarModel";

const ALL_PROJECTS = "__all__";

function useBotAttentionCount(): number {
  const providers = useEnabledBotProviderAddons();
  const state = useBotsState();
  if (providers.length === 0) return 0;
  return Object.values(state.botsByProvider).flat().filter(botNeedsAttention).length;
}

export function MattrAttentionInboxSidebar({ model }: { model: MattrSidebarModel }) {
  const gt = useGT();
  const { items, projects, activeThreadKey, nowMs, actions } = model;
  const [storedFilter, setProjectFilter] = useMattrInboxProjectFilter();
  const [quietExpanded, setQuietExpanded] = useMattrQuietExpanded();
  const [query, setQuery] = useState("");
  const botAttentionCount = useBotAttentionCount();

  const projectFilter =
    storedFilter !== null && projects.some((project) => project.key === storedFilter)
      ? storedFilter
      : null;
  const buckets = bucketInboxThreads(items, projectFilter);
  const counts = countLiveThreadsByProject(items);
  const searching = query.trim().length > 0;
  const results = searching
    ? filterThreadsByQuery(
        projectFilter === null ? items : items.filter((item) => item.projectKey === projectFilter),
        query,
      )
    : [];
  const projectMeta = (item: MattrThreadItem, age: string) =>
    projectFilter === null && item.projectName ? `${item.projectName} · ${age}` : age;
  const row = (item: MattrThreadItem, meta: string) => (
    <MattrThreadRow
      key={item.key}
      item={item}
      active={item.key === activeThreadKey}
      meta={meta}
      actions={actions}
    />
  );

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

  const nothingLive =
    buckets.needsYou.length +
      buckets.running.length +
      buckets.review.length +
      buckets.quiet.length ===
    0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-mattr-sidebar="inbox">
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-0.5 pb-1">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            size="compact"
            type="text"
            role="searchbox"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={gt("Search or jump")}
            aria-label={gt("Search threads")}
          />
        </InputGroup>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("New thread")}
          onClick={() => actions.newThread(projectFilter)}
        >
          <PlusIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {searching ? (
          <section aria-label={gt("Search results")}>
            <MattrSectionHeader
              icon={<SearchIcon aria-hidden />}
              label={gt("Results")}
              count={results.length}
            />
            <ul className="flex flex-col gap-px">
              {results
                .slice(0, 50)
                .map((item) => row(item, projectMeta(item, compactAge(item.activityAt, nowMs))))}
            </ul>
            {results.length === 0 ? (
              <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
                {gt("No threads match")}
              </p>
            ) : null}
          </section>
        ) : (
          <>
            {buckets.needsYou.length + botAttentionCount > 0 ? (
              <section aria-label={gt("Needs you")}>
                <MattrSectionHeader
                  icon={<BellIcon aria-hidden />}
                  label={gt("Needs you")}
                  count={buckets.needsYou.length + botAttentionCount}
                  tone="attention"
                />
                <ul className="flex flex-col gap-px">
                  {buckets.needsYou.map((item) => (
                    <MattrThreadRow
                      key={item.key}
                      item={item}
                      active={item.key === activeThreadKey}
                      subtitle={item.projectName ?? undefined}
                      actions={actions}
                      trailing={
                        <Button
                          size="xs"
                          variant={item.needsKind === "approval" ? "default" : "outline"}
                          onClick={() => actions.openThread(item)}
                        >
                          {item.needsKind === "approval"
                            ? gt("Review")
                            : item.needsKind === "input"
                              ? gt("Answer")
                              : gt("Open")}
                        </Button>
                      }
                    />
                  ))}
                  <MattrBotsSlot>
                    {(bots) =>
                      bots.filter(botNeedsAttention).map((bot) => (
                        <li
                          key={`${bot.providerId}:${bot.remoteBotId}`}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-row-hover"
                        >
                          <MattrBotLink bot={bot} size={16} />
                          <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                          {bot.unreadCount > 0 ? (
                            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
                              {gt("{count, plural, one {# unread} other {# unread}}", {
                                count: bot.unreadCount,
                              })}
                            </span>
                          ) : null}
                        </li>
                      ))
                    }
                  </MattrBotsSlot>
                </ul>
              </section>
            ) : null}

            {buckets.running.length > 0 ? (
              <section aria-label={gt("Running")}>
                <MattrSectionHeader
                  icon={<ActivityIcon aria-hidden />}
                  label={gt("Running")}
                  count={buckets.running.length}
                />
                <ul className="flex flex-col gap-px">
                  {buckets.running.map((item) =>
                    row(
                      item,
                      projectMeta(item, compactAge(item.runningSince ?? item.activityAt, nowMs)),
                    ),
                  )}
                </ul>
              </section>
            ) : null}

            {buckets.review.length > 0 ? (
              <section aria-label={gt("Ready to review")}>
                <MattrSectionHeader
                  icon={<CircleCheckIcon aria-hidden />}
                  label={gt("Ready to review")}
                  count={buckets.review.length}
                />
                <ul className="flex flex-col gap-px">
                  {buckets.review.map((item) => row(item, item.failed ? gt("Failed") : gt("Done")))}
                </ul>
              </section>
            ) : null}

            {buckets.quiet.length > 0 ? (
              <section aria-label={gt("Quiet")}>
                <MattrSectionHeader
                  icon={<MoonIcon aria-hidden />}
                  label={gt("Quiet")}
                  count={buckets.quiet.length}
                  expanded={quietExpanded}
                  onToggle={() => setQuietExpanded((value) => !value)}
                />
                {quietExpanded ? (
                  <ul className="flex flex-col gap-px">
                    {buckets.quiet.map((item) =>
                      row(item, projectMeta(item, compactAge(item.activityAt, nowMs))),
                    )}
                  </ul>
                ) : null}
              </section>
            ) : null}

            {nothingLive && botAttentionCount === 0 ? (
              <p className="px-2 py-3 text-xs text-sidebar-muted-foreground">
                {gt("Nothing needs you right now.")}
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-1">
        <div className="flex items-center gap-2 empty:hidden">
          <MattrBotsSlot>
            {(bots) => (
              <div
                role="group"
                aria-label={gt("Bots")}
                className="flex min-w-0 items-center gap-2 px-0.5"
              >
                {bots.slice(0, 6).map((bot) => (
                  <MattrBotLink key={`${bot.providerId}:${bot.remoteBotId}`} bot={bot} size={20} />
                ))}
              </div>
            )}
          </MattrBotsSlot>
          <span className="flex-1" />
          <MattrVoiceTrigger variant="pill" />
        </div>
        {projects.length > 1 ? (
          <div className="-mx-2 overflow-x-auto px-2 [scrollbar-width:none]">
            <ToggleGroup
              aria-label={gt("Filter by project")}
              variant="default"
              value={[projectFilter ?? ALL_PROJECTS]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === undefined) return;
                setProjectFilter(value === ALL_PROJECTS ? null : value);
              }}
            >
              <Toggle value={ALL_PROJECTS} variant="pill" size="xs">
                {gt("All")}
              </Toggle>
              {projects.map((project) => (
                <Toggle key={project.key} value={project.key} variant="pill" size="xs">
                  {project.name}
                  {counts.get(project.key) ? (
                    <span className="tabular-nums opacity-70">{counts.get(project.key)}</span>
                  ) : null}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        ) : null}
      </div>
    </div>
  );
}
