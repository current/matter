import type { BotIdentity, BotProviderDescriptor } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { useEffect } from "react";

import { ADDON_STATUS_LABELS } from "../../addons/addonRegistry";
import { useMatterApiConfig } from "../../addons/matterApi";
import { useEnabledBotProviderAddons } from "../../addons/useAddonRegistry";
import { cn } from "../../lib/utils";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { BotAvatar } from "./BotAvatarRenderer";
import { BOT_ACTIVITY_DOT, BOT_ACTIVITY_LABELS } from "./botActivity";
import { retainBotsSync, useBotsState } from "./botsStore";

/**
 * The sidebar's Bots section. Renders nothing, and starts nothing, unless an add-on that
 * provides Bots is enabled.
 */
export function BotsSidebarSection() {
  const enabledProviders = useEnabledBotProviderAddons();
  if (enabledProviders.length === 0) return null;
  return <BotsSidebarSectionContent />;
}

function BotsSidebarSectionContent() {
  const gt = useGT();
  const config = useMatterApiConfig();
  const bots = useBotsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the Bots event stream open while the section is mounted
  useEffect(() => {
    if (config === null) return;
    return retainBotsSync(config);
  }, [config]);

  return (
    <SidebarGroup data-bots-sidebar-section="">
      <h3
        id="sidebar-bots-heading"
        className="px-2 pb-1 text-xs font-medium text-sidebar-muted-foreground/80"
      >
        {gt("Bots")}
      </h3>
      <div role="group" aria-labelledby="sidebar-bots-heading">
        {bots.providers.map((provider) => (
          <BotProviderGroup
            key={provider.providerId}
            provider={provider}
            bots={bots.botsByProvider[provider.providerId] ?? []}
            showProviderName={bots.providers.length > 1}
          />
        ))}
        {bots.loaded && bots.providers.length === 0 ? (
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
            {gt("No Bots connection is available yet.")}
          </p>
        ) : null}
      </div>
    </SidebarGroup>
  );
}

function BotProviderGroup({
  provider,
  bots,
  showProviderName,
}: {
  provider: BotProviderDescriptor;
  bots: ReadonlyArray<BotIdentity>;
  showProviderName: boolean;
}) {
  const m = useMessages();
  const connected = provider.status.kind === "connected";
  return (
    <div className="flex flex-col">
      {showProviderName ? (
        <p className="px-2 pt-1 text-2xs text-sidebar-muted-foreground/75">
          {provider.displayName}
        </p>
      ) : null}
      {connected ? null : (
        <p className="px-2 py-1 text-xs text-sidebar-muted-foreground" data-bots-provider-status="">
          {showProviderName ? null : `${provider.displayName}: `}
          {m(ADDON_STATUS_LABELS[provider.status.kind])}
        </p>
      )}
      <SidebarMenu>
        {bots.map((bot) => (
          <BotSidebarRow key={bot.remoteBotId} bot={bot} />
        ))}
      </SidebarMenu>
    </div>
  );
}

function BotSidebarRow({ bot }: { bot: BotIdentity }) {
  const gt = useGT();
  const m = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = `/bots/${encodeURIComponent(bot.providerId)}/${encodeURIComponent(bot.remoteBotId)}`;
  const isActive = pathname === href;
  const dot = BOT_ACTIVITY_DOT[bot.status];
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={isActive}
        aria-current={isActive ? "page" : undefined}
        render={
          <Link
            to="/bots/$providerId/$botId"
            params={{ providerId: bot.providerId, botId: bot.remoteBotId }}
          />
        }
      >
        <BotAvatar bot={bot} size={16} activity={bot.status} still />
        <span className="min-w-0 flex-1 truncate">{bot.name}</span>
        {dot ? (
          <span
            role="img"
            aria-label={m(BOT_ACTIVITY_LABELS[bot.status])}
            className={cn("size-1.5 shrink-0 rounded-full", dot)}
          />
        ) : null}
        {bot.unreadCount > 0 ? (
          <span
            aria-label={gt("{count, plural, one {# unread message} other {# unread messages}}", {
              count: bot.unreadCount,
            })}
            className="shrink-0 text-2xs font-medium tabular-nums text-sidebar-foreground"
          >
            {bot.unreadCount}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
