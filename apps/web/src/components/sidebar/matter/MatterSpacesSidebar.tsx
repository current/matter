import { useGT } from "gt-react";
import { ArchiveIcon, PinIcon, PlusIcon } from "lucide-react";
import { useEffect } from "react";

import { useEnabledBotProviderAddons, useIsAddonEnabled } from "../../../addons/useAddonRegistry";
import { isCommandPaletteOpen } from "../../../commandPaletteBus";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../../../keybindings";
import { cn, isMacPlatform } from "../../../lib/utils";
import { isModelPickerOpen } from "../../../modelPickerVisibility";
import { useBotsState } from "../../bots/botsStore";
import { ProjectFavicon } from "../../ProjectFavicon";
import { threadShortcutContext } from "../../Sidebar.logic";
import { Button } from "../../ui/button";
import {
  buildSpaceSections,
  resolveActiveSpaceKey,
  resolveProjectAttention,
  type MatterThreadAttention,
} from "./matterSidebar.logic";
import {
  compactAge,
  MatterBotLink,
  MatterBotsSlot,
  MatterSectionHeader,
  MatterThreadRow,
  MatterTip,
  MatterVoiceTrigger,
} from "./MatterSidebarParts";
import { MatterScopeLine } from "./MatterScopeLine";
import { useMatterActiveSpace, useMatterEarlierExpanded } from "./matterSidebarStore";
import type { MatterSidebarModel } from "./useMatterSidebarModel";

const MAX_FAVORITES = 8;

const ATTENTION_DOT: Record<MatterThreadAttention, string | null> = {
  needs: "bg-warning",
  running: "bg-success",
  review: "bg-info",
  idle: null,
};

function useHasConnectedBots(): boolean {
  const providers = useEnabledBotProviderAddons();
  const state = useBotsState();
  if (providers.length === 0) return false;
  return state.providers.some(
    (provider) =>
      provider.status.kind === "connected" &&
      (state.botsByProvider[provider.providerId]?.length ?? 0) > 0,
  );
}

export function MatterSpacesSidebar({ model }: { model: MatterSidebarModel }) {
  const gt = useGT();
  const { items, projects, activeThreadKey, nowMs, keybindings, actions } = model;
  const [storedSpace, setActiveSpace] = useMatterActiveSpace();
  const [earlierExpanded, setEarlierExpanded] = useMatterEarlierExpanded();
  const hasConnectedBots = useHasConnectedBots();
  const voiceEnabled = useIsAddonEnabled("voice-assistant");
  const projectKeys = projects.map((project) => project.key);
  const activeKey = resolveActiveSpaceKey(storedSpace, projectKeys);
  const activeProject = projects.find((project) => project.key === activeKey) ?? null;
  const sections = buildSpaceSections(items, activeKey, nowMs);
  const favorites = projects.slice(0, MAX_FAVORITES);
  const shortcutPrefix =
    typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens on window so the thread jump shortcuts switch spaces while Spaces is shown
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: threadShortcutContext(null),
      });
      const index = threadJumpIndexFromCommand(command ?? "");
      if (index === null) return;
      const target = projectKeys[index];
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveSpace(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, projectKeys, setActiveSpace]);

  const row = (item: (typeof items)[number]) => (
    <MatterThreadRow
      key={item.key}
      item={item}
      active={item.key === activeThreadKey}
      meta={
        item.attention === "needs"
          ? gt("waiting")
          : compactAge(item.runningSince ?? item.activityAt, nowMs)
      }
      actions={actions}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-matter-sidebar="spaces">
      <MatterScopeLine />
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-1">
        <div role="group" aria-label={gt("Spaces")} className="grid grid-cols-4 gap-1.5">
          {favorites.map((project, index) => {
            const dot = ATTENTION_DOT[resolveProjectAttention(items, project.key) ?? "idle"];
            const selected = project.key === activeKey;
            return (
              <MatterTip
                key={project.key}
                label={index < 9 ? `${project.name} (${shortcutPrefix}${index + 1})` : project.name}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={project.name}
                  onClick={() => setActiveSpace(project.key)}
                  className={cn(
                    "relative grid h-10 cursor-pointer place-items-center rounded-lg outline-hidden ring-1 ring-inset transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "bg-sidebar-row-active shadow-2xs ring-sidebar-border"
                      : "bg-sidebar-row-hover/40 ring-sidebar-border/45 hover:bg-sidebar-row-hover/85 hover:ring-sidebar-border/75",
                  )}
                >
                  <ProjectFavicon project={project.group} className="size-5" />
                  {dot ? (
                    <span
                      aria-hidden
                      className={cn("absolute top-1.5 right-1.5 size-1.5 rounded-full", dot)}
                    />
                  ) : null}
                </button>
              </MatterTip>
            );
          })}
        </div>
        <MatterBotsSlot>
          {(bots) => (
            <div role="group" aria-label={gt("Bots")} className="grid grid-cols-4 gap-1.5">
              {bots.slice(0, voiceEnabled ? 3 : 4).map((bot) => (
                <MatterBotLink
                  key={`${bot.providerId}:${bot.remoteBotId}`}
                  bot={bot}
                  variant="tile"
                />
              ))}
              <MatterVoiceTrigger variant="tile" />
            </div>
          )}
        </MatterBotsSlot>
        {!hasConnectedBots && voiceEnabled ? (
          <div className="flex justify-end">
            <MatterVoiceTrigger variant="pill" />
          </div>
        ) : null}
      </div>

      {activeProject ? (
        <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-1">
          <ProjectFavicon project={activeProject.group} className="size-4 shrink-0" />
          <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
            {activeProject.name}
          </h2>
          <span className="shrink-0 text-2xs tabular-nums text-sidebar-muted-foreground">
            {gt("{count, plural, one {# thread} other {# threads}}", {
              count: sections.liveCount,
            })}
          </span>
          <span className="flex-1" />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("New thread in {project}", { project: activeProject.name })}
            onClick={() => actions.newThread(activeProject.key)}
          >
            <PlusIcon />
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-width:none]">
        {activeProject === null ? (
          <p className="px-2 py-3 text-xs text-sidebar-muted-foreground">
            {gt("Add a project to start a space.")}
          </p>
        ) : (
          <>
            {sections.pinned.length > 0 ? (
              <section aria-label={gt("Pinned")}>
                <MatterSectionHeader icon={<PinIcon aria-hidden />} label={gt("Pinned")} ruled />
                <ul className="flex flex-col gap-0.5">{sections.pinned.map(row)}</ul>
              </section>
            ) : null}
            <section aria-label={gt("Today")}>
              <MatterSectionHeader label={gt("Today")} ruled />
              <ul className="flex flex-col gap-0.5">{sections.today.map(row)}</ul>
              {sections.today.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground">
                  {gt("No threads today.")}
                </p>
              ) : null}
            </section>
            {sections.earlier.length > 0 ? (
              <section aria-label={gt("Earlier")}>
                <MatterSectionHeader
                  icon={<ArchiveIcon aria-hidden />}
                  label={gt("Earlier")}
                  count={sections.earlier.length}
                  expanded={earlierExpanded}
                  onToggle={() => setEarlierExpanded((value) => !value)}
                />
                {earlierExpanded ? (
                  <ul className="flex flex-col gap-0.5">{sections.earlier.map(row)}</ul>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>

      {favorites.length > 1 ? (
        <div
          role="group"
          aria-label={gt("Switch space")}
          className="flex shrink-0 items-center justify-center gap-1 px-2 pt-1 pb-1.5"
        >
          {favorites.map((project) => (
            <button
              key={project.key}
              type="button"
              aria-label={project.name}
              aria-pressed={project.key === activeKey}
              onClick={() => setActiveSpace(project.key)}
              className="grid size-5 cursor-pointer place-items-center rounded-full outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
            >
              <span
                aria-hidden
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  project.key === activeKey
                    ? "w-4 bg-sidebar-foreground/85"
                    : "w-1.5 bg-sidebar-muted-foreground/45 hover:bg-sidebar-muted-foreground/75",
                )}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
