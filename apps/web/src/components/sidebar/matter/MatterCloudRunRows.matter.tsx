/* oxlint-disable shadcn/no-unknown-classes -- the `mfs-*` and `mts-*` classes come from the fork stylesheets matter/sidebar.css and matter/timeline-sidebar.css, which load outside Tailwind. */
import type { MatterCloudRun } from "@t3tools/client-runtime/matter/cloud-runs";
import { Link, useLocation } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { CloudIcon } from "lucide-react";

import { compactAge } from "./matterFinalSidebar.logic";
import { CloudGlyph } from "./MatterTimelineIcons";

/**
 * A Claude Cloud run nested under the chat that started it, like a running subagent. It opens the
 * cloud session's page; finished runs leave the tree, as finished subagents do.
 */

function useCloudRunRow(run: MatterCloudRun, nowMs: number) {
  const gt = useGT();
  const pathname = useLocation({ select: (location) => location.pathname });
  const needsInput = run.state === "needs_input";
  const age = compactAge(run.startedAt, nowMs);
  return {
    active: pathname === `/cloud/${encodeURIComponent(run.id)}`,
    needsInput,
    age,
    status: needsInput ? gt("Needs input", { $context: "a cloud run waits for the user" }) : age,
    label: needsInput
      ? gt("{title}, cloud run, needs input", { title: run.title })
      : gt("{title}, cloud run, working for {duration}", { title: run.title, duration: age }),
  };
}

const linkProps = (run: MatterCloudRun) =>
  ({
    to: "/cloud/$sessionId",
    params: { sessionId: run.id },
    search: { instanceId: run.instanceId },
  }) as const;

/** The Default rail's subagent tree row. */
export function MatterDefaultCloudRunRow({ run, nowMs }: { run: MatterCloudRun; nowMs: number }) {
  const row = useCloudRunRow(run, nowMs);
  return (
    <li data-matter-cloud-run={run.id} data-state={run.state}>
      <Link
        {...linkProps(run)}
        className="mfs-sub"
        data-active={row.active ? "" : undefined}
        data-unread={row.needsInput ? "" : undefined}
        aria-current={row.active ? "page" : undefined}
        aria-label={row.label}
      >
        <span className="mfs-pm">
          <CloudIcon aria-hidden />
        </span>
        <span className="mfs-t">{run.title}</span>
        <span className="mfs-st" data-tone={row.needsInput ? "needs" : "running"}>
          {row.status}
        </span>
      </Link>
    </li>
  );
}

/** The Timeline's active subagent row. */
export function MatterTimelineCloudRunRow({ run, nowMs }: { run: MatterCloudRun; nowMs: number }) {
  const row = useCloudRunRow(run, nowMs);
  return (
    <li
      className="mts-sub"
      data-matter-cloud-run={run.id}
      data-state={run.state}
      data-active={row.active ? "" : undefined}
    >
      <Link
        {...linkProps(run)}
        className="mts-hit"
        aria-current={row.active ? "page" : undefined}
        aria-label={row.label}
      />
      <span className="mts-conn" aria-hidden />
      <span className="mts-pi">
        <CloudGlyph />
      </span>
      <span className="mts-st">{run.title}</span>
      <span className="mts-sm" data-tone={row.needsInput ? "needs" : "running"} aria-hidden>
        {row.needsInput ? (
          row.status
        ) : (
          <>
            <span className="mts-sub-dot" aria-hidden />
            {row.age}
          </>
        )}
      </span>
    </li>
  );
}
