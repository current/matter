import type { BotIdentity } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
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
import { BOT_ACTIVITY_LABELS } from "../../bots/botActivity";
import { retainBotsSync, useBotsState } from "../../bots/botsStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { MattrThreadItem } from "./mattrSidebar.logic";
import type { MattrSidebarActions } from "./useMattrSidebarModel";

/** A hover label for an icon-only control. */
export function MattrTip({
  label,
  side = "bottom",
  children,
}: {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side={side}>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Short age such as "4m", or an empty string for an unreadable timestamp. */
export function compactAge(iso: string | null, nowMs: number): string {
  if (iso === null) return "";
  return formatRelativeTime(iso, nowMs)?.value ?? "";
}

function MattrStatusDot({
  item,
  className,
}: {
  item: MattrThreadItem;
  className?: string | undefined;
}) {
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
      className={cn("size-[7px] shrink-0 rounded-full", tone.className, className)}
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
  const hasTrailing = trailing !== undefined && trailing !== null;
  return (
    <li
      data-mattr-thread-row={item.key}
      className={cn(
        "flex items-center rounded-md transition-colors",
        hasTrailing
          ? active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover"
          : undefined,
      )}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => actions.openThread(item)}
        onContextMenu={onContextMenu}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer gap-2 rounded-md px-2 text-left text-sm leading-snug outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
          subtitle ? "items-start py-1.5" : "h-7 items-center",
          hasTrailing
            ? "pr-1.5"
            : active
              ? "bg-sidebar-row-active text-sidebar-foreground transition-colors"
              : "text-sidebar-foreground/90 transition-colors hover:bg-sidebar-row-hover",
        )}
      >
        <MattrStatusDot item={item} className={subtitle ? "mt-[5px]" : undefined} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate",
              (item.unread || active) && "font-medium text-sidebar-foreground",
            )}
          >
            {item.title}
          </span>
          {subtitle ? (
            <span className="mt-0.5 truncate text-2xs leading-tight text-sidebar-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-2xs tabular-nums text-sidebar-muted-foreground/85">
            {meta}
          </span>
        ) : null}
      </button>
      {hasTrailing ? <div className="shrink-0 pr-1.5">{trailing}</div> : null}
    </li>
  );
}

export function MattrSectionHeader({
  icon,
  label,
  count,
  tone = "muted",
  ruled = false,
  expanded,
  onToggle,
}: {
  icon?: ReactNode;
  label: string;
  count?: number;
  tone?: "muted" | "attention";
  ruled?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {icon}
      <span className="shrink-0">{label}</span>
      {count !== undefined ? (
        <span className="shrink-0 tabular-nums opacity-75">{count}</span>
      ) : null}
      {ruled ? <span aria-hidden className="ml-1 h-px flex-1 bg-sidebar-border/60" /> : null}
      {onToggle ? (
        <span className="ml-auto opacity-75">
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3" />
          )}
        </span>
      ) : null}
    </>
  );
  const className = cn(
    "flex w-full items-center gap-1.5 px-2 pt-3 pb-1 text-2xs font-medium [&_svg]:size-3 [&_svg]:shrink-0",
    tone === "attention" ? "text-warning-foreground" : "text-sidebar-muted-foreground",
  );
  if (!onToggle) return <h3 className={className}>{content}</h3>;
  return (
    <h3 className="pt-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover/70 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset [&_svg]:size-3 [&_svg]:shrink-0",
          tone === "attention" ? "text-warning-foreground" : "text-sidebar-muted-foreground",
        )}
      >
        {content}
      </button>
    </h3>
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

function MattrBotBadge({ bot }: { bot: BotIdentity }) {
  const needsUser = bot.status === "waiting_for_user" || bot.status === "waiting_for_approval";
  // One calm signal: unread wins, then a block on the user, then a failure. Working shows in text.
  const dot =
    bot.unreadCount > 0
      ? "bg-info"
      : needsUser
        ? "bg-warning"
        : bot.status === "error"
          ? "bg-destructive"
          : null;
  if (!dot) return null;
  return (
    <span
      aria-hidden
      data-mattr-bot-dot
      className={cn(
        "pointer-events-none absolute -top-1 -right-1 size-2 rounded-full ring-2 ring-sidebar",
        dot,
      )}
    />
  );
}

export function MattrBotLink({
  bot,
  variant = "crew",
  className,
}: {
  bot: BotIdentity;
  variant?: "crew" | "tile";
  className?: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = `/bots/${encodeURIComponent(bot.providerId)}/${encodeURIComponent(bot.remoteBotId)}`;
  const active = pathname === href;
  const statusLabel = m(BOT_ACTIVITY_LABELS[bot.status]);
  const tipLabel =
    bot.unreadCount > 0
      ? `${bot.name} · ${gt("{count, plural, one {# unread} other {# unread}}", {
          count: bot.unreadCount,
        })}`
      : `${bot.name} · ${statusLabel}`;

  return (
    <MattrTip label={tipLabel} side={variant === "crew" ? "top" : "bottom"}>
      <Link
        to="/bots/$providerId/$botId"
        params={{ providerId: bot.providerId, botId: bot.remoteBotId }}
        aria-current={active ? "page" : undefined}
        aria-label={`${bot.name}, ${statusLabel}`}
        className={cn(
          "group/bot relative flex cursor-pointer flex-col items-center justify-center outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
          variant === "tile"
            ? cn(
                "h-12 w-full gap-1 rounded-lg px-1 ring-1 ring-inset",
                active
                  ? "bg-sidebar-row-active text-sidebar-foreground shadow-2xs ring-sidebar-border"
                  : "bg-sidebar-row-hover/40 text-sidebar-muted-foreground ring-sidebar-border/45 hover:bg-sidebar-row-hover/85 hover:text-sidebar-foreground hover:ring-sidebar-border/75",
              )
            : cn(
                "min-w-11 max-w-14 shrink-0 gap-1 rounded-lg px-1.5 py-1",
                active
                  ? "bg-sidebar-row-active text-sidebar-foreground ring-1 ring-inset ring-sidebar-border/75"
                  : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              ),
          className,
        )}
      >
        <span
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center rounded-full",
            bot.status === "working" && "ring-1 ring-success/80 ring-offset-1 ring-offset-sidebar",
          )}
        >
          {/* 24px maps GrokBotCharacter to "sm" (size-6) with full face details instead of 16px "xs". */}
          <BotAvatar bot={bot} size={24} activity={bot.status} />
          <MattrBotBadge bot={bot} />
        </span>
        <span className="max-w-full truncate text-3xs leading-none">{bot.name}</span>
      </Link>
    </MattrTip>
  );
}

function MattrVoiceWaveformGlyph({ className }: { className?: string | undefined }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 14"
      className={cn("h-3.5 w-4 shrink-0 fill-current", className)}
    >
      <rect x="0.5" y="4.5" width="1.8" height="5" rx="0.9" />
      <rect x="3.8" y="2" width="1.8" height="10" rx="0.9" />
      <rect x="7.1" y="0.5" width="1.8" height="13" rx="0.9" />
      <rect x="10.4" y="3" width="1.8" height="8" rx="0.9" />
      <rect x="13.7" y="5" width="1.8" height="4" rx="0.9" />
    </svg>
  );
}

/** A Voice Mode trigger, shown only while the Voice Assistant add-on is enabled. */
export function MattrVoiceTrigger({ variant }: { variant: "pill" | "tile" }) {
  const gt = useGT();
  const enabled = useIsAddonEnabled("voice-assistant");
  if (!enabled) return null;
  return (
    <MattrTip label={gt("Voice Mode")} side={variant === "pill" ? "top" : "bottom"}>
      <button
        type="button"
        onClick={() => setVoiceAssistantModalOpen(true)}
        aria-label={gt("Voice Mode")}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center justify-center outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
          variant === "pill"
            ? "ml-auto h-7 gap-1.5 rounded-full bg-sidebar-row-active/85 px-2.5 text-xs font-medium text-sidebar-foreground ring-1 ring-inset ring-sidebar-border/65 hover:bg-sidebar-row-active"
            : "h-12 w-full flex-col gap-1 rounded-lg bg-sidebar-row-hover/40 px-1 text-sidebar-muted-foreground ring-1 ring-inset ring-sidebar-border/45 hover:bg-sidebar-row-hover/85 hover:text-sidebar-foreground hover:ring-sidebar-border/75",
        )}
      >
        <MattrVoiceWaveformGlyph
          className={variant === "tile" ? "h-4 w-4.5 text-sidebar-foreground" : undefined}
        />
        <span className={variant === "tile" ? "text-3xs leading-none" : undefined}>
          {gt("Voice")}
        </span>
      </button>
    </MattrTip>
  );
}
