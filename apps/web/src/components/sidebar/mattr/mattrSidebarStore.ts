import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../../hooks/useLocalStorage";

export const MATTR_SIDEBAR_LAYOUT_STORAGE_KEY = "mattr:sidebar:layout:v1";
const MATTR_SIDEBAR_SPACE_STORAGE_KEY = "mattr:sidebar:space:v1";
const MATTR_SIDEBAR_INBOX_PROJECT_STORAGE_KEY = "mattr:sidebar:inbox-project:v1";
const MATTR_SIDEBAR_QUIET_EXPANDED_STORAGE_KEY = "mattr:sidebar:quiet-expanded:v1";
const MATTR_SIDEBAR_EARLIER_EXPANDED_STORAGE_KEY = "mattr:sidebar:earlier-expanded:v1";

export const MattrSidebarLayout = Schema.Literals(["inbox", "spaces", "classic"]);
export type MattrSidebarLayout = typeof MattrSidebarLayout.Type;

/**
 * Attention Inbox is the default. Tests keep the upstream sidebar so its suites, and every suite
 * that renders the app shell, see the structure they assert on.
 */
export const DEFAULT_MATTR_SIDEBAR_LAYOUT: MattrSidebarLayout =
  import.meta.env.MODE === "test" ? "classic" : "inbox";

const NullableKey = Schema.NullOr(Schema.String);

export function useMattrSidebarLayout() {
  return useLocalStorage(
    MATTR_SIDEBAR_LAYOUT_STORAGE_KEY,
    DEFAULT_MATTR_SIDEBAR_LAYOUT,
    MattrSidebarLayout,
  );
}

/** The project the Spaces layout shows; null follows the first favorite. */
export function useMattrActiveSpace() {
  return useLocalStorage<string | null, string | null>(
    MATTR_SIDEBAR_SPACE_STORAGE_KEY,
    null,
    NullableKey,
  );
}

/** The project the Attention Inbox is sliced to; null shows every project. */
export function useMattrInboxProjectFilter() {
  return useLocalStorage<string | null, string | null>(
    MATTR_SIDEBAR_INBOX_PROJECT_STORAGE_KEY,
    null,
    NullableKey,
  );
}

export function useMattrQuietExpanded() {
  return useLocalStorage(MATTR_SIDEBAR_QUIET_EXPANDED_STORAGE_KEY, false, Schema.Boolean);
}

export function useMattrEarlierExpanded() {
  return useLocalStorage(MATTR_SIDEBAR_EARLIER_EXPANDED_STORAGE_KEY, false, Schema.Boolean);
}
