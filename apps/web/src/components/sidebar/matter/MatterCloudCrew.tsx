/* oxlint-disable shadcn/no-unknown-classes -- the `mfs-*` classes come from the fork stylesheet matter/sidebar.css, which loads outside Tailwind. */
import type { ClaudeCloudRemoteSession } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { openClaudeCloudDialog } from "../../../addons/claudeCloudApi";
import { useMatterApiConfig } from "../../../addons/matterApi";
import { CLAUDE_CLOUD_STATE_LABELS } from "../../cloud/claudeCloudCopy";
import {
  retainClaudeCloudSessions,
  useClaudeCloudSessionsState,
} from "../../cloud/claudeCloudStore";
import { isCloudSessionActive, rankCloudSessions } from "../../cloud/claudeCloudTranscript.logic";
import { ClaudeAI } from "../../Icons";
import { compactAge } from "./matterFinalSidebar.logic";

const PREVIEW_LIMIT = 4;

const DOT_COLOR: Readonly<Record<ClaudeCloudRemoteSession["state"], string>> = {
  running: "var(--mfs-success)",
  needs_input: "var(--mfs-warning)",
  idle: "var(--mfs-muted-50)",
  failed: "var(--mfs-pr-closed)",
  archived: "var(--mfs-muted-50)",
};

/** Every cloud session on the user's claude.ai accounts, while the add-on is on. */
export function useClaudeCloudCrewSessions(enabled: boolean) {
  const config = useMatterApiConfig();
  const state = useClaudeCloudSessionsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the server's cloud session list fresh while the rail shows it
  useEffect(() => {
    if (!enabled || config === null) return;
    return retainClaudeCloudSessions(config);
  }, [enabled, config]);
  return enabled ? state : null;
}

/** Crew → Claude Cloud: a row that starts a session, then the sessions themselves. */
export function MatterCloudCrew({
  sessions,
  nowMs,
}: {
  sessions: ReadonlyArray<ClaudeCloudRemoteSession>;
  nowMs: number;
}) {
  const gt = useGT();
  const [showAll, setShowAll] = useState(false);
  const ranked = rankCloudSessions(sessions);
  const live = ranked.filter((session) => isCloudSessionActive(session.state)).length;
  const visible = showAll ? ranked : ranked.slice(0, PREVIEW_LIMIT);
  const hidden = ranked.length - visible.length;
  return (
    <li data-matter-cloud-crew="">
      <div className="mfs-row">
        <button
          type="button"
          className="mfs-hit"
          aria-label={gt("New cloud session")}
          onClick={() => openClaudeCloudDialog({ mode: "launch" })}
        />
        <span className="mfs-av" data-cloud="">
          <ClaudeAI aria-hidden />
        </span>
        <span className="mfs-t">{gt("Claude Cloud")}</span>
        {live > 0 ? (
          <span className="mfs-a" data-tone="running">
            {gt("{count} live", { count: live })}
          </span>
        ) : null}
        <PlusIcon aria-hidden className="size-3.5 text-(--mfs-muted)" />
      </div>
      {ranked.length > 0 ? (
        <ul className="mfs-tree" aria-label={gt("Claude Cloud sessions")}>
          {visible.map((session) => (
            <CloudSessionRow key={session.id} session={session} nowMs={nowMs} />
          ))}
          {hidden > 0 ? (
            <li>
              <div className="mfs-sub">
                <button
                  type="button"
                  className="mfs-hit"
                  aria-label={gt("Show {count} more cloud sessions", { count: hidden })}
                  onClick={() => setShowAll(true)}
                />
                <span className="mfs-t mfs-more">{gt("{count} more", { count: hidden })}</span>
              </div>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function CloudSessionRow({ session, nowMs }: { session: ClaudeCloudRemoteSession; nowMs: number }) {
  const gt = useGT();
  const m = useMessages();
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = pathname === `/cloud/${encodeURIComponent(session.id)}`;
  const needsYou = session.state === "needs_input";
  const label = m(CLAUDE_CLOUD_STATE_LABELS[session.state]);
  const trailing = needsYou ? (
    <span className="mfs-st" data-tone="needs">
      {gt("Needs you")}
    </span>
  ) : session.state === "failed" ? (
    <span className="mfs-st" data-tone="failed">
      {label}
    </span>
  ) : (
    <span className="mfs-st" data-tone={session.state === "running" ? "running" : "done"}>
      {compactAge(session.updatedAt, nowMs)}
    </span>
  );
  return (
    <li data-claude-cloud-session={session.id} data-state={session.state}>
      <Link
        to="/cloud/$sessionId"
        params={{ sessionId: session.id }}
        search={{ instanceId: session.instanceId }}
        className="mfs-sub"
        data-active={active ? "" : undefined}
        data-unread={session.unread || needsYou ? "" : undefined}
        aria-current={active ? "page" : undefined}
        aria-label={`${session.title}, ${label}`}
      >
        <span className="mfs-pm">
          <span aria-hidden className="mfs-dot" style={{ background: DOT_COLOR[session.state] }} />
        </span>
        <span className="mfs-t">{session.title}</span>
        {trailing}
      </Link>
    </li>
  );
}
