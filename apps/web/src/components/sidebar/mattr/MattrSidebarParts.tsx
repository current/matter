import type { BotIdentity } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, RadioIcon } from "lucide-react";
import {
  useEffect,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { useMattrApiConfig } from "../../../addons/mattrApi";
import { useEnabledBotProviderAddons, useIsAddonEnabled } from "../../../addons/useAddonRegistry";
import { contextMenuSourceOf } from "../../../contextMenuSource";
import { setVoiceAssistantModalOpen } from "../../../island/voiceAssistantStore";
import { cn } from "../../../lib/utils";
import { formatRelativeTime } from "../../../timestampFormat";
import { BotAvatar } from "../../bots/BotAvatarRenderer";
import { BOT_ACTIVITY_DOT, BOT_ACTIVITY_LABELS } from "../../bots/botActivity";
import { retainBotsSync, useBotsState } from "../../bots/botsStore";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { MattrThreadItem } from "./mattrSidebar.logic";
import type { MattrSidebarActions } from "./useMattrSidebarModel";
import { useMattrSidebarLayout } from "./mattrSidebarStore";

/** A hover label for an icon-only control. */
export function MattrTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Short age such as "4m", or an empty string for an unreadable timestamp. */
export function compactAge(iso: string | null, nowMs: number): string {
  if (iso === null) return "";
  return formatRelativeTime(iso, nowMs)?.value ?? "";
}

function MattrStatusDot({ item }: { item: MattrThreadItem }) {
  const gt = useGT();
  const tone =
    item.attention === "needs"
      ? { className: "bg-warning", label: gt("Needs you") }
      : item.attention === "running"
        ? { className: "bg-success", label: gt("Running") }
        : item.failed
          ? { className: "bg-destructive", label: gt("Failed") }
          : item.attention === "review"
            ? { className: "bg-info", label: gt("Ready to review") }
            : {
                className: "ring-1 ring-inset ring-sidebar-muted-foreground/60",
                label: gt("Idle"),
              };
  return (
    <span
      role="img"
      aria-label={tone.label}
      className={cn("size-1.5 shrink-0 rounded-full", tone.className)}
    />
  );
}

export function MattrThreadRow({
  item,
  active,
  meta,
  subtitle,
  trailing,
  actions,
}: {
  item: MattrThreadItem;
  active: boolean;
  meta?: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  actions: MattrSidebarActions;
}) {
  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    actions.openThreadMenu(
      item,
      { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
  };
  return (
    <li className="flex items-center gap-1" data-mattr-thread-row={item.key}>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => actions.openThread(item)}
        onContextMenu={onContextMenu}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
          subtitle ? "py-1.5" : "h-7",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
        )}
      >
        <MattrStatusDot item={item} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate", item.unread && "font-medium")}>{item.title}</span>
          {subtitle ? (
            <span className="truncate text-xs text-sidebar-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
            {meta}
          </span>
        ) : null}
      </button>
      {trailing}
    </li>
  );
}

export function MattrSectionHeader({
  icon,
  label,
  count,
  tone = "muted",
  expanded,
  onToggle,
}: {
  icon?: ReactNode;
  label: string;
  count?: number;
  tone?: "muted" | "attention";
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {icon}
      <span>{label}</span>
      {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
      {onToggle ? (
        <span className="ml-auto">
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" />
          )}
        </span>
      ) : null}
    </>
  );
  const className = cn(
    "flex w-full items-center gap-1.5 px-2 pt-3 pb-1 text-xs font-medium [&_svg]:size-3.5",
    tone === "attention" ? "text-warning-foreground" : "text-sidebar-muted-foreground",
  );
  if (!onToggle) return <h3 className={className}>{content}</h3>;
  return (
    <h3>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          className,
          "cursor-pointer rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        )}
      >
        {content}
      </button>
    </h3>
  );
}

/** Inbox / Spaces switch shown inside the rail; Classic lives in Settings. */
export function MattrLayoutSwitcher() {
  const gt = useGT();
  const [layout, setLayout] = useMattrSidebarLayout();
  return (
    <ToggleGroup
      aria-label={gt("Sidebar layout")}
      variant="segmented"
      size="xs"
      value={[layout]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "inbox" || value === "spaces") setLayout(value);
      }}
    >
      <Toggle value="inbox">{gt("Inbox")}</Toggle>
      <Toggle value="spaces">{gt("Spaces")}</Toggle>
    </ToggleGroup>
  );
}

export function botNeedsAttention(bot: BotIdentity): boolean {
  return (
    bot.status === "waiting_for_user" ||
    bot.status === "waiting_for_approval" ||
    bot.unreadCount > 0
  );
}

/**
 * Renders its children with the connected Bots, but only while an add-on that provides Bots is
 * enabled. Disabled, it renders nothing and opens no event stream.
 */
export function MattrBotsSlot({
  children,
}: {
  children: (bots: ReadonlyArray<BotIdentity>) => ReactNode;
}) {
  const providers = useEnabledBotProviderAddons();
  if (providers.length === 0) return null;
  return <MattrBotsSlotContent>{children}</MattrBotsSlotContent>;
}

function MattrBotsSlotContent({
  children,
}: {
  children: (bots: ReadonlyArray<BotIdentity>) => ReactNode;
}) {
  const config = useMattrApiConfig();
  const state = useBotsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the Bots event stream open while a Bots surface is mounted
  useEffect(() => {
    if (config === null) return;
    return retainBotsSync(config);
  }, [config]);
  const bots = state.providers.flatMap((provider) =>
    provider.status.kind === "connected" ? (state.botsByProvider[provider.providerId] ?? []) : [],
  );
  if (bots.length === 0) return null;
  return children(bots);
}

export function MattrBotLink({
  bot,
  size,
  className,
  children,
}: {
  bot: BotIdentity;
  size: number;
  className?: string;
  children?: ReactNode;
}) {
  const m = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = `/bots/${encodeURIComponent(bot.providerId)}/${encodeURIComponent(bot.remoteBotId)}`;
  const active = pathname === href;
  const dot = BOT_ACTIVITY_DOT[bot.status];
  return (
    <MattrTip label={bot.name}>
      <Link
        to="/bots/$providerId/$botId"
        params={{ providerId: bot.providerId, botId: bot.remoteBotId }}
        aria-current={active ? "page" : undefined}
        aria-label={`${bot.name}, ${m(BOT_ACTIVITY_LABELS[bot.status])}`}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
          className,
        )}
      >
        <BotAvatar bot={bot} size={size} activity={bot.status} />
        {dot || bot.unreadCount > 0 ? (
          <span
            aria-hidden
            className={cn(
              "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
              dot ?? "bg-info",
            )}
          />
        ) : null}
        {children}
      </Link>
    </MattrTip>
  );
}

/** A Voice Mode trigger, shown only while the Voice Assistant add-on is enabled. */
export function MattrVoiceTrigger({ variant }: { variant: "pill" | "tile" }) {
  const gt = useGT();
  const enabled = useIsAddonEnabled("voice-assistant");
  if (!enabled) return null;
  return (
    <MattrTip label={gt("Voice Mode")}>
      <button
        type="button"
        onClick={() => setVoiceAssistantModalOpen(true)}
        aria-label={gt("Voice Mode")}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 text-xs text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset",
          variant === "pill"
            ? "h-6.5 rounded-full bg-sidebar-row-hover/60 px-2.5"
            : "h-10 rounded-lg bg-sidebar-row-hover/40",
        )}
      >
        <RadioIcon aria-hidden className="size-3.5" />
        {variant === "pill" ? <span>{gt("Voice")}</span> : null}
      </button>
    </MattrTip>
  );
}
