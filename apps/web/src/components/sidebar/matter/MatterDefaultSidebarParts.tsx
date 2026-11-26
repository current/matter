/* oxlint-disable shadcn/no-unknown-classes -- the `mfs-*` classes come from the fork stylesheet matter/sidebar.css, which loads outside Tailwind. */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type {
  BotIdentity,
  ProviderDriverKind,
  TrackedClaudeCloudSession,
} from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import {
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronDownIcon,
  RadioIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { fetchClaudeCloudStatus, openClaudeCloudDialog } from "../../../addons/claudeCloudApi";
import { useMatterApiConfig } from "../../../addons/matterApi";
import { useEnabledBotProviderAddons, useIsAddonEnabled } from "../../../addons/useAddonRegistry";
import { setVoiceModeOpen } from "../../../island/voiceAssistantStore";
import { useDesktopUpdateState } from "../../../state/desktopUpdate";
import {
  useEnvironmentProviders,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "../../../state/environments";
import { BotAvatar } from "../../bots/BotAvatarRenderer";
import { BOT_ACTIVITY_LABELS } from "../../bots/botActivity";
import { retainBotsSync, useBotsState } from "../../bots/botsStore";
import { ProviderInstanceIcon, providerTextColor } from "../../chat/ProviderInstanceIcon";
import { ClaudeAI } from "../../Icons";
import {
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../../desktopUpdate.logic";
import { T3Wordmark } from "../../T3Wordmark";
import { renderClosingPositioner } from "../../ui/closing-positioner";
import { useSidebar } from "../../ui/sidebar";
import { useNavigateToMainApp } from "../mainAppLocation";
import { SidebarProviderUpdatePill } from "../SidebarProviderUpdatePill";
import { SidebarThreadUndoNotice } from "../SidebarThreadUndoNotice";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "../SidebarUpdatePill";
import { useUpdateEverythingRun } from "../updateEverythingRun";
import { useUpdateEverything } from "../useUpdateEverything";
import {
  botKey,
  botNeedsAttention,
  hostDotTone,
  rankCrew,
  shortHostLabel,
} from "./matterBots.logic";
import {
  compactAge,
  formatResetLabel,
  pickUsageMeters,
  type MatterUsageMeter,
} from "./matterFinalSidebar.logic";
import { MatterTip } from "./MatterSidebarParts";
import {
  useMatterSidebarLayout,
  useMatterTimelineSubagents,
  type MatterSidebarLayout,
} from "./matterSidebarStore";

/** A thread's provider as its own colored brand mark. */
export function MatterProviderMark({ driver }: { driver: ProviderDriverKind | null }) {
  if (driver === null) {
    return (
      <span
        aria-hidden
        className="size-[7px] rounded-full ring-1 ring-inset ring-current opacity-60"
      />
    );
  }
  const color = providerTextColor(driver);
  return (
    <span aria-hidden className={color.className} style={color.style}>
      <ProviderInstanceIcon driverKind={driver} displayName={driver} iconClassName="size-3.5" />
    </span>
  );
}

/** The frosted popup both rail menus use, styled by matter/sidebar.css. */
export function MatterMenuPopup({
  children,
  align = "start",
  side = "bottom",
  anchor,
  sideOffset = 4,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  sideOffset?: number;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        side={side}
        anchor={anchor}
        sideOffset={sideOffset}
        className="z-[130]"
        render={renderClosingPositioner}
      >
        <MenuPrimitive.Popup className="dropdown-glass mfs-menu origin-(--transform-origin) outline-none [-webkit-app-region:no-drag]">
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function MatterMenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  hint?: ReactNode;
  onClick: () => void;
}) {
  return (
    <MenuPrimitive.Item className="mfs-menu-item" onClick={onClick}>
      {icon}
      <span className="mfs-menu-text">{label}</span>
      {hint}
    </MenuPrimitive.Item>
  );
}

export function MatterMenuRadioItem({
  value,
  label,
  hint,
}: {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <MenuPrimitive.RadioItem className="mfs-menu-item" value={value} closeOnClick>
      <span className="inline-flex size-3.5 items-center justify-center">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon aria-hidden className="mfs-menu-check" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      <span className="mfs-menu-text">{label}</span>
      {hint}
    </MenuPrimitive.RadioItem>
  );
}

function useHostStatus() {
  const gt = useGT();
  const environment = usePrimaryEnvironment();
  const updateStatus = useDesktopUpdateState()?.status;
  const fullLabel = environment?.serverConfig?.environment.label ?? gt("This Mac");
  const tone = hostDotTone(environment?.connection.phase, updateStatus);
  const status =
    tone === "error"
      ? { color: "var(--destructive)", label: gt("Disconnected") }
      : tone === "connecting"
        ? { color: "var(--mfs-warning)", label: gt("Connecting") }
        : tone === "update"
          ? { color: "var(--info)", label: gt("Update available") }
          : { color: "var(--mfs-success)", label: gt("Connected") };
  return { fullLabel, label: shortHostLabel(fullLabel), tone, status };
}

/** The "Matter ⌄" brand menu: Settings, Usage, Voice Mode, layout, and the host's state. */
export function MatterBrandMenu({
  onNavigate,
  caret,
}: {
  onNavigate: () => void;
  caret?: ReactNode;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const [layout, setLayout] = useMatterSidebarLayout();
  const [showSubagents, setShowSubagents] = useMatterTimelineSubagents();
  const voiceEnabled = useIsAddonEnabled("voice-assistant");
  const host = useHostStatus();
  const go = (to: () => void) => {
    onNavigate();
    to();
  };
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger className="mfs-wn" aria-label={gt("Matter menu")}>
        <T3Wordmark aria-hidden className="mfs-logo" />
        <span>{"Matter"}</span>
        {caret ?? <ChevronDownIcon aria-hidden className="mfs-caret" />}
      </MenuPrimitive.Trigger>
      <MatterMenuPopup>
        <MatterMenuItem
          icon={<SettingsIcon aria-hidden />}
          label={gt("Settings")}
          onClick={() => go(() => void navigate({ to: "/settings" }))}
        />
        <MatterMenuItem
          icon={<ChartNoAxesColumnIcon aria-hidden />}
          label={gt("Usage")}
          onClick={() => go(() => void navigate({ to: "/usage" }))}
        />
        {voiceEnabled ? (
          <MatterMenuItem
            icon={<RadioIcon aria-hidden />}
            label={gt("Voice Mode")}
            onClick={() => go(() => setVoiceModeOpen(true))}
          />
        ) : null}
        <div className="mfs-menu-sep" />
        <MenuPrimitive.Group>
          <MenuPrimitive.GroupLabel className="mfs-menu-label">
            {gt("Sidebar layout")}
          </MenuPrimitive.GroupLabel>
          <MenuPrimitive.RadioGroup
            value={layout}
            onValueChange={(value: MatterSidebarLayout) => setLayout(value)}
          >
            <MatterMenuRadioItem value="inbox" label={gt("Default")} />
            <MatterMenuRadioItem value="spaces" label={gt("Spaces")} />
            <MatterMenuRadioItem value="timeline" label={gt("Timeline")} />
            <MatterMenuRadioItem value="classic" label={gt("Classic")} />
          </MenuPrimitive.RadioGroup>
          {layout === "timeline" ? (
            <>
              <div className="mfs-menu-sep" />
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
                <span className="mfs-menu-text">{gt("Show active subagents")}</span>
              </MenuPrimitive.CheckboxItem>
            </>
          ) : null}
        </MenuPrimitive.Group>
        <div className="mfs-menu-sep" />
        <div className="mfs-menu-host" data-matter-host-status={host.tone ?? "ok"}>
          <span className="mfs-dot" style={{ background: host.status.color }} />
          <span className="min-w-0 truncate">
            {host.fullLabel} · {host.status.label}
          </span>
        </div>
      </MatterMenuPopup>
    </MenuPrimitive.Root>
  );
}

/** Connected Bots, holding their event stream open while any Bots add-on is on. */
export function useCrewBots() {
  const providers = useEnabledBotProviderAddons();
  const enabled = providers.length > 0;
  const config = useMatterApiConfig();
  const state = useBotsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the Bots event stream open while the rail shows Bots
  useEffect(() => {
    if (!enabled || config === null) return;
    return retainBotsSync(config);
  }, [enabled, config]);
  const bots = enabled
    ? state.providers.flatMap((provider) =>
        provider.status.kind === "connected"
          ? (state.botsByProvider[provider.providerId] ?? [])
          : [],
      )
    : [];
  const needs = bots.filter((bot) => botNeedsAttention(bot, state.pending));
  const rest = rankCrew(bots.filter((bot) => !botNeedsAttention(bot, state.pending)));
  return { bots: [...needs, ...rest], needsCount: needs.length, pending: state.pending };
}

const CLOUD_REFRESH_MS = 60_000;

/** Claude Cloud sessions Matter tracks, while the add-on is on. */
function useClaudeCloudSessions(enabled: boolean): ReadonlyArray<TrackedClaudeCloudSession> | null {
  const config = useMatterApiConfig();
  const [sessions, setSessions] = useState<ReadonlyArray<TrackedClaudeCloudSession> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server's Claude Cloud session list while the add-on is on
  useEffect(() => {
    if (!enabled || config === null) return;
    const controller = new AbortController();
    const load = () => {
      fetchClaudeCloudStatus(config, { signal: controller.signal }).then(
        (status) => setSessions(status.enabled ? status.sessions : null),
        () => undefined,
      );
    };
    load();
    const timer = window.setInterval(load, CLOUD_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [enabled, config]);
  return enabled ? sessions : null;
}

function botActivityAt(bot: BotIdentity): string | null {
  const value = bot.metadata["lastActivityAt"];
  return typeof value === "string" ? value : null;
}

function CrewBotRow({
  bot,
  needsYou,
  nowMs,
}: {
  bot: BotIdentity;
  needsYou: boolean;
  nowMs: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = `/bots/${encodeURIComponent(bot.providerId)}/${encodeURIComponent(bot.remoteBotId)}`;
  const active = pathname === href;
  const unread = bot.unreadCount > 0;
  const age = compactAge(botActivityAt(bot), nowMs);
  const status = needsYou ? (
    <span className="mfs-need">{gt("Needs you")}</span>
  ) : bot.status === "working" ? (
    <span className="mfs-st" data-tone="running" data-bot-working="">
      <span aria-hidden className="mfs-dot bg-success" />
      {age || m(BOT_ACTIVITY_LABELS.working)}
    </span>
  ) : unread ? (
    <span className="mfs-a">{gt("{count} new", { count: bot.unreadCount })}</span>
  ) : (
    <span className="mfs-a">
      {age || (bot.status === "idle" ? null : m(BOT_ACTIVITY_LABELS[bot.status]))}
    </span>
  );
  return (
    <li>
      <Link
        to="/bots/$providerId/$botId"
        params={{ providerId: bot.providerId, botId: bot.remoteBotId }}
        aria-current={active ? "page" : undefined}
        aria-label={`${bot.name}, ${needsYou ? gt("Needs you") : m(BOT_ACTIVITY_LABELS[bot.status])}`}
        data-unread={unread || needsYou ? "" : undefined}
        className="mfs-row"
      >
        <span className="mfs-av">
          <BotAvatar bot={bot} size={18} activity={bot.status} still />
        </span>
        <span className="mfs-t">{bot.name}</span>
        {status}
      </Link>
    </li>
  );
}

/** Crew: Bots and Claude Cloud as standing teammates. Absent while no such add-on is on. */
export function MatterCrew({
  crew,
  nowMs,
}: {
  crew: ReturnType<typeof useCrewBots>;
  nowMs: number;
}) {
  const gt = useGT();
  const cloudEnabled = useIsAddonEnabled("claude-cloud");
  const sessions = useClaudeCloudSessions(cloudEnabled);
  if (crew.bots.length === 0 && sessions === null) return null;
  const live = sessions?.filter((session) => session.teleportedThreadId === null) ?? [];
  const latest = live.toSorted((left, right) =>
    (right.lastMessageAt ?? right.createdAt).localeCompare(left.lastMessageAt ?? left.createdAt),
  )[0];
  return (
    <section className="mfs-crew" aria-label={gt("Crew")}>
      <h3 className="mfs-lab">{gt("Crew")}</h3>
      <ul>
        {crew.bots.map((bot, index) => (
          <CrewBotRow
            key={botKey(bot)}
            bot={bot}
            needsYou={index < crew.needsCount}
            nowMs={nowMs}
          />
        ))}
        {sessions !== null ? (
          <li>
            <div className="mfs-row">
              <button
                type="button"
                className="mfs-hit"
                aria-label={gt("Claude Cloud, {count} live", { count: live.length })}
                onClick={() =>
                  openClaudeCloudDialog(
                    latest
                      ? { mode: "followup", sessionId: latest.id, projectId: latest.projectId }
                      : { mode: "launch" },
                  )
                }
              />
              <span className="mfs-av" data-cloud="">
                <ClaudeAI aria-hidden />
              </span>
              <span className="mfs-t">{gt("Claude Cloud")}</span>
              <span className="mfs-a">{gt("{count} live", { count: live.length })}</span>
            </div>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function resetText(meter: MatterUsageMeter, nowMs: number, gt: ReturnType<typeof useGT>) {
  // A reset that already passed means the meter is stale until the next poll; skip the time.
  if (meter.resetsAt === null || !(Date.parse(meter.resetsAt) > nowMs)) {
    return gt("{percent}% left", { percent: 100 - meter.usedPercent });
  }
  const soon = formatResetLabel(meter.resetsAt, nowMs);
  if (soon !== null) return gt("Resets in {duration}", { duration: soon });
  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(meter.resetsAt));
  return gt("Resets {when}", { when });
}

/** Footer A's meters, pure so tests can render them without a server. */
export function MatterUsageMeters({
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
    <div className="mfs-mg" role="group" aria-label={gt("Usage limits")}>
      {meters.map((meter) => {
        const label = `${meter.providerName} ${meter.windowLabel}`;
        const reset = resetText(meter, nowMs, gt);
        const color = meter.driver === "claudeAgent" ? "var(--mfs-claude)" : "var(--mfs-fg)";
        return (
          <MatterTip key={meter.key} label={`${meter.accountName} · ${reset}`} side="top">
            <button
              type="button"
              className="mfs-m"
              aria-label={gt("{label}: {percent}% used. {reset}", {
                label,
                percent: meter.usedPercent,
                reset,
              })}
              onClick={onOpen}
            >
              <span className="mfs-ln">
                <MatterProviderMark driver={meter.driver} />
                <span>{label}</span>
                <b>{`${meter.usedPercent}%`}</b>
              </span>
              <span className="mfs-tr" aria-hidden>
                <i style={{ width: `${meter.usedPercent}%`, background: color }} />
              </span>
              <span className="mfs-rs block">{reset}</span>
            </button>
          </MatterTip>
        );
      })}
    </div>
  );
}

/** Upstream's pill doubles as an always-on "Check for updates" button; Default shows it only while an update applies. */
export function MatterUpdateNotice() {
  const state = useDesktopUpdateState();
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const everything = useUpdateEverything(
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null,
  );
  const run = useUpdateEverythingRun();
  const applies =
    run !== null || everything.hasUpdates || action !== "none" || state?.status === "downloading";
  return applies ? <SidebarUpdatePill /> : null;
}

/** Footer A: notices while they apply, the two tightest usage meters, then host and Settings. */
export function MatterFooter({ nowMs }: { nowMs: number }) {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const onSettings = pathname.startsWith("/settings");
  const primaryId = usePrimaryEnvironmentId();
  const providers = useEnvironmentProviders();
  const meters = pickUsageMeters(primaryId === null ? [] : (providers.get(primaryId) ?? []));
  const host = useHostStatus();
  const go = (to: () => void) => {
    if (isMobile) setOpenMobile(false);
    to();
  };
  return (
    <>
      <div className="mfs-notices">
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
        <MatterUpdateNotice />
        <SidebarThreadUndoNotice />
      </div>
      <footer className="mfs-f" data-matter-footer>
        <MatterUsageMeters
          meters={meters}
          nowMs={nowMs}
          onOpen={() => go(() => void navigate({ to: "/usage" }))}
        />
        <div className="mfs-hl">
          <MatterTip label={`${host.fullLabel} · ${host.status.label}`} side="top">
            <button
              type="button"
              className="mfs-host"
              aria-label={gt("{host}, {status}", {
                host: host.fullLabel,
                status: host.status.label,
              })}
              onClick={() => go(() => void navigate({ to: "/settings/connections" }))}
            >
              {host.tone !== null ? (
                <span
                  className="mfs-dot"
                  data-matter-host-dot={host.tone}
                  style={{ background: host.status.color }}
                />
              ) : null}
              <span>{host.label}</span>
            </button>
          </MatterTip>
          <MatterTip label={gt("Settings")} side="top">
            <button
              type="button"
              className="mfs-gear"
              aria-label={gt("Settings")}
              aria-current={onSettings ? "page" : undefined}
              onClick={() =>
                go(() =>
                  onSettings ? void navigateToMainApp() : void navigate({ to: "/settings" }),
                )
              }
            >
              <SettingsIcon aria-hidden />
            </button>
          </MatterTip>
        </div>
      </footer>
    </>
  );
}
