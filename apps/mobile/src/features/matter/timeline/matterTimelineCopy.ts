import type {
  MatterTimelineNeedsKind,
  MatterTimelineSectionKind,
} from "@t3tools/client-runtime/matter/timeline-feed";
import { msg } from "gt-react-native";

import type { MessageResolver } from "../../../i18n/messages";
import type { MatterTimelineRowInfo } from "./matterTimelineList";

const SECTION_LABEL: Record<Exclude<MatterTimelineSectionKind, "month">, string> = {
  needs: msg("Needs you", { $context: "thread list section, threads waiting on the user" }),
  pinned: msg("Pinned", { $context: "thread list section" }),
  working: msg("Active", {
    $context: "thread list section, threads whose agents are working or waiting on background work",
  }),
  today: msg("Today", { $context: "thread list section" }),
  yesterday: msg("Yesterday", { $context: "thread list section" }),
  week: msg("Previous 7 days", { $context: "thread list section" }),
  days30: msg("Previous 30 days", { $context: "thread list section" }),
  snoozed: msg("Snoozed", { $context: "thread list section" }),
  settled: msg("Archived", { $context: "thread list section, threads put away" }),
};

export function matterTimelineSectionLabel(
  section: {
    readonly kind: MatterTimelineSectionKind;
    readonly monthStartMs: number | null;
    readonly showYear: boolean;
  },
  locale: string,
  resolve: MessageResolver,
): string {
  if (section.kind !== "month" || section.monthStartMs === null) {
    return resolve(SECTION_LABEL[section.kind === "month" ? "days30" : section.kind]);
  }
  return new Intl.DateTimeFormat(
    locale,
    section.showYear ? { month: "long", year: "numeric" } : { month: "long" },
  ).format(new Date(section.monthStartMs));
}

const NEEDS_LABEL: Record<MatterTimelineNeedsKind, string> = {
  approval: msg("Approval", { $context: "a thread is waiting for the user to approve an action" }),
  input: msg("Question", { $context: "a thread is waiting for the user to answer a question" }),
  limited: msg("Usage limit", { $context: "a thread stopped at its provider's usage limit" }),
  subagent: msg("Subagent", { $context: "one of a thread's subagents is waiting for the user" }),
  request: msg("Guest", { $context: "a guest of a thread is waiting for its owner" }),
};

const STATE_LABEL = {
  failed: msg("Failed", { $context: "thread status" }),
  running: msg("Working", { $context: "a thread's agent is running now" }),
  background: msg("Waiting", {
    $context: "a thread's agent resumes by itself once its background work ends",
  }),
} as const;

/** The state named at a row's right edge; idle rows name none. */
export function matterTimelineStateLabel(
  info: Pick<MatterTimelineRowInfo, "tone" | "needsKind">,
  resolve: MessageResolver,
): string | null {
  switch (info.tone) {
    case "needs":
      return resolve(NEEDS_LABEL[info.needsKind ?? "request"]);
    case "failed":
    case "running":
    case "background":
      return resolve(STATE_LABEL[info.tone]);
    case "idle":
      return null;
  }
}

const NEEDS_YOU_REASON = msg("Needs you: {reason}");
const BRANCH = msg("Branch {branch}");
const PULL_REQUEST = msg("Pull request #{number}");

/** What a screen reader hears for a row: everything its two lines show. */
export function matterTimelineRowAccessibilityLabel(
  input: {
    readonly title: string;
    readonly info: MatterTimelineRowInfo;
    readonly timeText: string;
    readonly providerName: string | null;
    readonly pinned: boolean;
    readonly hasQueuedMessages: boolean;
  },
  resolve: MessageResolver,
): string {
  const { info } = input;
  const state = matterTimelineStateLabel(info, resolve);
  return [
    input.title,
    info.tone === "needs" && state !== null ? resolve(NEEDS_YOU_REASON, { reason: state }) : state,
    info.tone === "idle" && info.unread
      ? resolve(msg("Unread", { $context: "thread status" }))
      : null,
    input.timeText || null,
    input.pinned ? resolve(msg("Pinned", { $context: "thread is pinned" })) : null,
    info.projectName,
    input.providerName,
    info.branchLabel === null ? null : resolve(BRANCH, { branch: info.branchLabel }),
    info.pullRequestNumber === null
      ? null
      : resolve(PULL_REQUEST, { number: info.pullRequestNumber }),
    input.hasQueuedMessages ? resolve(msg("messages queued to send")) : null,
  ]
    .filter((part) => part !== null && part !== "")
    .join(", ");
}
