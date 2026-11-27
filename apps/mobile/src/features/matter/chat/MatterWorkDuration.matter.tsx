import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { useMessages } from "gt-react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { workItemDurationMs, type WorkItemTiming } from "./matterWorkDuration";

/**
 * A finished tool call's duration, right-aligned in an 11px tabular column so durations line up
 * down the work log, as on web (`data-matter-wl-duration`).
 */
export function MatterWorkDuration(props: { readonly item: WorkItemTiming }) {
  const messages = useMessages();
  const durationMs = workItemDurationMs(props.item);
  if (durationMs === null) return null;
  return (
    <Text
      numberOfLines={1}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="min-w-8 pr-1 text-right text-3xs tabular-nums text-foreground-muted opacity-70"
    >
      {formatDuration(durationMs, messages)}
    </Text>
  );
}
