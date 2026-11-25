import { useGT } from "gt-react";
import {
  ActivityIcon,
  BellIcon,
  CircleCheckIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { useEnabledBotProviderAddons } from "../../../addons/useAddonRegistry";
import { isMacPlatform } from "../../../lib/utils";
import { useBotsState } from "../../bots/botsStore";
import { Button } from "../../ui/button";
import { SidebarInput } from "../../ui/sidebar";
import {
  bucketInboxThreads,
  countLiveThreadsByProject,
  filterThreadsByQuery,
  type MattrThreadItem,
} from "./mattrSidebar.logic";
import {
  botNeedsAttention,
  compactAge,
  MattrBotAttentionRow,
  MattrBotCrewRow,
  MattrBotsSlot,
  MattrSectionHeader,
  MattrThreadRow,
  MattrVoiceTrigger,
} from "./MattrSidebarParts";
import { MattrScopeLine } from "./MattrScopeLine";
import { useMattrInboxProjectFilter, useMattrQuietExpanded } from "./mattrSidebarStore";
import type { MattrSidebarModel } from "./useMattrSidebarModel";

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
  const searchShortcutHint =
    typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘K" : "Ctrl+K";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-mattr-sidebar="inbox">
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-0.5 pb-1">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-sidebar-row-hover/50 px-2 ring-1 ring-inset ring-sidebar-border/55 transition-colors focus-within:bg-sidebar-row-hover/85 focus-within:ring-ring/65">
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
          <SidebarInput
            type="text"
            role="searchbox"
            enterKeyHint="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={gt("Search or jump")}
            aria-label={gt("Search threads")}
            className="min-w-0 flex-1"
          />
          {query !== "" ? (
            <button
              type="button"
              aria-label={gt("Clear thread search")}
              onClick={() => setQuery("")}
              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground hover:text-sidebar-foreground"
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none shrink-0 font-sans text-3xs text-sidebar-muted-foreground/75">
              {searchShortcutHint}
            </kbd>
          )}
        </div>
        <MattrVoiceTrigger variant="icon" />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("New thread")}
          onClick={() => actions.newThread(projectFilter)}
        >
          <PlusIcon />
        </Button>
      </div>
      <MattrScopeLine
        projects={projects.map((project) => ({
          key: project.key,
          name: project.name,
          liveCount: counts.get(project.key),
        }))}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-width:none]">
        {searching ? (
          <section aria-label={gt("Search results")}>
            <MattrSectionHeader
              icon={<SearchIcon aria-hidden />}
              label={gt("Results")}
              count={results.length}
            />
            <ul className="flex flex-col gap-0.5">
              {results
                .slice(0, 50)
                .map((item) => row(item, projectMeta(item, compactAge(item.activityAt, nowMs))))}
            </ul>
            {results.length === 0 ? (
              <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
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
                <ul className="flex flex-col gap-0.5">
                  {buckets.needsYou.map((item) => (
                    <MattrThreadRow
                      key={item.key}
                      item={item}
                      active={item.key === activeThreadKey}
                      subtitle={item.projectName ?? undefined}
                      actions={actions}
                      trailing={
                        <Button
                          size="micro"
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
                      bots
                        .filter(botNeedsAttention)
                        .map((bot) => (
                          <MattrBotAttentionRow
                            key={`${bot.providerId}:${bot.remoteBotId}`}
                            bot={bot}
                          />
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
                <ul className="flex flex-col gap-0.5">
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
                <ul className="flex flex-col gap-0.5">
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
                  <ul className="flex flex-col gap-0.5">
                    {buckets.quiet.map((item) =>
                      row(item, projectMeta(item, compactAge(item.activityAt, nowMs))),
                    )}
                  </ul>
                ) : null}
              </section>
            ) : null}

            <MattrBotsSlot>
              {(bots) => (
                <section aria-label={gt("Crew")}>
                  <MattrSectionHeader icon={<UsersIcon aria-hidden />} label={gt("Crew")} />
                  <ul className="flex flex-col gap-0.5">
                    {bots.map((bot) => (
                      <MattrBotCrewRow key={`${bot.providerId}:${bot.remoteBotId}`} bot={bot} />
                    ))}
                  </ul>
                </section>
              )}
            </MattrBotsSlot>

            {nothingLive && botAttentionCount === 0 ? (
              <p className="px-2 py-3 text-xs text-sidebar-muted-foreground">
                {gt("Nothing needs you right now.")}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
