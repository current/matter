import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { CloudIcon } from "lucide-react";
import { useEffect } from "react";

import { useMatterApiConfig } from "../../addons/matterApi";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { CLAUDE_CLOUD_STATE_LABELS } from "./claudeCloudCopy";
import { retainClaudeCloudSessions, useClaudeCloudSessionsState } from "./claudeCloudStore";
import { cloudSessionSource, rankCloudSessions } from "./claudeCloudTranscript.logic";

const RECENT_LIMIT = 20;

/** "Claude Cloud sessions…": opens a recent cloud session. Reads the list while the palette is open. */
export function useClaudeCloudPaletteItem(enabled: boolean): CommandPaletteSubmenuItem | null {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const config = useMatterApiConfig();
  const { sessions } = useClaudeCloudSessionsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's cloud session list while the palette is open
  useEffect(() => {
    if (!enabled || config === null) return;
    return retainClaudeCloudSessions(config);
  }, [enabled, config]);
  if (!enabled || !sessions || sessions.length === 0) return null;
  const items: ReadonlyArray<CommandPaletteActionItem> = rankCloudSessions(sessions)
    .slice(0, RECENT_LIMIT)
    .map((session) => {
      const source = cloudSessionSource(session);
      const state = m(CLAUDE_CLOUD_STATE_LABELS[session.state]);
      return {
        kind: "action",
        value: `claude-cloud-session:${session.id}`,
        searchTerms: [session.title, session.repository ?? "", session.branch ?? "", "cloud"],
        title: session.title,
        description: source ? `${state} · ${source}` : state,
        icon: <CloudIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate({
            to: "/cloud/$sessionId",
            params: { sessionId: session.id },
            search: { instanceId: session.instanceId },
          });
        },
      };
    });
  return {
    kind: "submenu",
    value: "action:claude-cloud-sessions",
    searchTerms: ["claude", "cloud", "sessions", "remote", "open"],
    title: gt("Claude Cloud sessions…"),
    icon: <CloudIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <CloudIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: "claude-cloud-sessions", label: gt("Claude Cloud"), items }],
  };
}
