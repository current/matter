import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  ChevronsUpDownIcon,
  RadioIcon,
  SettingsIcon,
} from "lucide-react";

import { useIsAddonEnabled } from "../../../addons/useAddonRegistry";
import { setVoiceAssistantModalOpen } from "../../../island/voiceAssistantStore";
import { cn } from "../../../lib/utils";
import {
  useIssuesSupported,
  usePrimaryEnvironment,
  usePullRequestsSupported,
} from "../../../state/environments";
import { readIssueListPreferences } from "../../issue/issueListPreferences";
import { IssueGlyph } from "../../issue/issuePresentation";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../../pullRequest/pullRequestListPreferences";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { useSidebar } from "../../ui/sidebar";
import { isSidebarUtilityPage, useNavigateToMainApp } from "../mainAppLocation";
import { SidebarProviderUpdatePill } from "../SidebarProviderUpdatePill";
import { SidebarThreadUndoNotice } from "../SidebarThreadUndoNotice";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "../SidebarUpdatePill";
import { MattrTip } from "./MattrSidebarParts";

const quietButton =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset aria-[current=page]:bg-sidebar-row-active aria-[current=page]:text-sidebar-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * The custom layouts' whole footer in one line: the host chip opens every utility, Usage and
 * Settings stay one click away, and update and undo notices appear above it only while they apply.
 */
export function MattrStatusLine() {
  const gt = useGT();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const environment = usePrimaryEnvironment();
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const voiceEnabled = useIsAddonEnabled("voice-assistant");
  const pathname = useLocation({ select: (location) => location.pathname });
  const onUtilityPage = isSidebarUtilityPage(pathname);
  const onSettings = pathname.startsWith("/settings");
  const onUsage = pathname.startsWith("/usage");

  const go = (to: () => void) => {
    if (isMobile) setOpenMobile(false);
    to();
  };
  const openSettings = () =>
    go(() => (onSettings ? void navigateToMainApp() : void navigate({ to: "/settings" })));
  const openUsage = () => go(() => void navigate({ to: "/usage" }));
  const openPullRequests = () =>
    go(() => void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() }));
  const openIssues = () =>
    go(() => void navigate({ to: "/issues", search: readIssueListPreferences() }));

  const hostLabel = environment?.serverConfig?.environment.label ?? gt("This Mac");
  const phase = environment?.connection.phase;
  const connectionDot =
    phase === undefined || phase === "available"
      ? "bg-success"
      : phase === "connecting"
        ? "bg-warning"
        : "bg-destructive";

  return (
    <div className="flex shrink-0 flex-col gap-1 px-2 pb-1.5" data-mattr-status-line>
      <div className="flex flex-col gap-1 empty:hidden">
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
        <SidebarThreadUndoNotice />
      </div>
      <div className="flex h-8 items-center gap-0.5">
        {onUtilityPage ? (
          <button
            type="button"
            onClick={() => go(() => void navigateToMainApp())}
            className={cn(quietButton, "min-w-0 flex-1 justify-start gap-2 px-2 text-xs")}
          >
            <ArrowLeftIcon aria-hidden />
            <span className="truncate">{gt("Back to threads")}</span>
          </button>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={gt("{host} menu", { host: hostLabel })}
                  className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-1.5 pl-1 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-popup-open:bg-sidebar-row-active"
                />
              }
            >
              <span className="relative grid size-5 shrink-0 place-items-center rounded-md bg-sidebar-row-active text-3xs font-semibold text-sidebar-foreground ring-1 ring-inset ring-sidebar-border/60">
                {hostLabel.slice(0, 1).toUpperCase()}
                <span
                  aria-hidden
                  className={cn(
                    "absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full ring-2 ring-sidebar",
                    connectionDot,
                  )}
                />
              </span>
              <span className="min-w-0 truncate text-xs font-medium text-sidebar-foreground">
                {hostLabel}
              </span>
              <ChevronsUpDownIcon
                aria-hidden
                className="ml-auto size-3 shrink-0 text-sidebar-muted-foreground"
              />
            </MenuTrigger>
            <MenuPopup side="top" align="start">
              <MenuItem onClick={openSettings}>
                <SettingsIcon />
                {gt("Settings")}
              </MenuItem>
              {pullRequestsSupported ? (
                <MenuItem onClick={openPullRequests}>
                  <PullRequestGlyph.pullRequest />
                  {gt("Pull requests")}
                </MenuItem>
              ) : null}
              {issuesSupported ? (
                <MenuItem onClick={openIssues}>
                  <IssueGlyph.issue />
                  {gt("Issues", { $context: "sidebar link to the list of issues" })}
                </MenuItem>
              ) : null}
              <MenuItem onClick={openUsage}>
                <ChartNoAxesColumnIcon />
                {gt("Usage")}
              </MenuItem>
              {voiceEnabled ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={() => go(() => setVoiceAssistantModalOpen(true))}>
                    <RadioIcon />
                    {gt("Voice Mode")}
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        )}
        <SidebarUpdatePill />
        <MattrTip label={gt("Usage")} side="top">
          <button
            type="button"
            aria-label={gt("Usage")}
            aria-current={onUsage ? "page" : undefined}
            onClick={openUsage}
            className={cn(quietButton, "w-7")}
          >
            <ChartNoAxesColumnIcon aria-hidden />
          </button>
        </MattrTip>
        <MattrTip label={gt("Settings")} side="top">
          <button
            type="button"
            aria-label={gt("Settings")}
            aria-current={onSettings ? "page" : undefined}
            onClick={openSettings}
            className={cn(quietButton, "w-7")}
          >
            <SettingsIcon aria-hidden />
          </button>
        </MattrTip>
      </div>
    </div>
  );
}
