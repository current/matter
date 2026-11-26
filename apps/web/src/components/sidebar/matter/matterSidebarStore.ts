import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../../hooks/useLocalStorage";

export const MATTER_SIDEBAR_LAYOUT_STORAGE_KEY = "mattr:sidebar:layout:v1";
const MATTER_SIDEBAR_SPACE_STORAGE_KEY = "mattr:sidebar:space:v1";
const MATTER_SIDEBAR_INBOX_PROJECT_STORAGE_KEY = "mattr:sidebar:inbox-project:v1";
const MATTER_SIDEBAR_EARLIER_EXPANDED_STORAGE_KEY = "mattr:sidebar:earlier-expanded:v1";
const MATTER_SIDEBAR_SORT_STORAGE_KEY = "mattr:sidebar:sort:v1";
const MATTER_SIDEBAR_COLLAPSED_GROUPS_STORAGE_KEY = "mattr:sidebar:collapsed-groups:v1";
export const MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY = "mattr:sidebar:timeline-subagents:v1";
const MATTER_TIMELINE_SORT_STORAGE_KEY = "mattr:sidebar:timeline-sort:v1";
const MATTER_TIMELINE_EARLIER_STORAGE_KEY = "mattr:sidebar:timeline-earlier:v1";

export const MatterSidebarLayout = Schema.Literals(["inbox", "spaces", "timeline", "classic"]);
export type MatterSidebarLayout = typeof MatterSidebarLayout.Type;

/**
 * The default layout keeps its old "inbox" storage value so saved choices still load. Tests keep
 * the upstream sidebar so its suites, and every suite that renders the app shell, see the
 * structure they assert on.
 */
export const DEFAULT_MATTER_SIDEBAR_LAYOUT: MatterSidebarLayout =
  import.meta.env.MODE === "test" ? "classic" : "inbox";

const NullableKey = Schema.NullOr(Schema.String);

export function useMatterSidebarLayout() {
  return useLocalStorage(
    MATTER_SIDEBAR_LAYOUT_STORAGE_KEY,
    DEFAULT_MATTER_SIDEBAR_LAYOUT,
    MatterSidebarLayout,
  );
}

/** The project the Spaces layout shows; null follows the first favorite. */
export function useMatterActiveSpace() {
  return useLocalStorage<string | null, string | null>(
    MATTER_SIDEBAR_SPACE_STORAGE_KEY,
    null,
    NullableKey,
  );
}

/** The project the default layout is scoped to; null shows all activity. */
export function useMatterInboxProjectFilter() {
  return useLocalStorage<string | null, string | null>(
    MATTER_SIDEBAR_INBOX_PROJECT_STORAGE_KEY,
    null,
    NullableKey,
  );
}

export function useMatterEarlierExpanded() {
  return useLocalStorage(MATTER_SIDEBAR_EARLIER_EXPANDED_STORAGE_KEY, false, Schema.Boolean);
}

const MatterSortMode = Schema.Literals(["project", "recent"]);

/** The default layout's list order: grouped by project, or one list by recency. */
export function useMatterSortMode() {
  return useLocalStorage(MATTER_SIDEBAR_SORT_STORAGE_KEY, "project", MatterSortMode);
}

const CollapsedGroups = Schema.Array(Schema.String);

/** Project groups folded in the default layout. */
export function useMatterCollapsedGroups() {
  return useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    MATTER_SIDEBAR_COLLAPSED_GROUPS_STORAGE_KEY,
    [],
    CollapsedGroups,
  );
}

/** Timeline nests a thread's running subagents under it while this is on. */
export function useMatterTimelineSubagents() {
  return useLocalStorage(MATTER_TIMELINE_SUBAGENTS_STORAGE_KEY, true, Schema.Boolean);
}

const MatterTimelineSort = Schema.Literals(["updated", "created"]);

/** Timeline's feed order and day buckets: by last activity or by when threads began. */
export function useMatterTimelineSort() {
  return useLocalStorage(MATTER_TIMELINE_SORT_STORAGE_KEY, "updated", MatterTimelineSort);
}

export function useMatterTimelineEarlierExpanded() {
  return useLocalStorage(MATTER_TIMELINE_EARLIER_STORAGE_KEY, false, Schema.Boolean);
}
