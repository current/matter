import { useGT, useLocale, useMessages } from "gt-react-native";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { matterTimelineSectionLabel } from "./matterTimelineCopy";
import type { MatterTimelineSectionListItem } from "./matterTimelineList";
import { toggleMatterTimelineSection } from "./useMatterTimeline";

/** A Timeline section's label and quiet count; foldable ones fold on tap. */
export const MatterTimelineSectionHeader = memo(function MatterTimelineSectionHeader(props: {
  readonly item: MatterTimelineSectionListItem;
  readonly pane?: "screen" | "sidebar";
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const { item } = props;
  const sidebarPane = props.pane === "sidebar";
  const label = matterTimelineSectionLabel(item, locale, m);
  const needs = item.kind === "needs";
  const textClassName = needs
    ? "text-warning-foreground"
    : sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary";
  const className = cn(
    "flex-row items-center gap-1.5 pb-1.5",
    item.first ? "pt-2" : "pt-5",
    sidebarPane ? "px-3" : "px-5",
  );
  const content = (
    <>
      <Text className={cn("text-2xs font-t3-medium", textClassName)}>{label}</Text>
      <Text className={cn("text-2xs tabular-nums", textClassName, !needs && "opacity-70")}>
        {item.count}
      </Text>
      {item.hiddenUnread ? (
        <View className="size-1.5 rounded-full bg-adaptive-blue-500-400" />
      ) : null}
      {item.foldable ? (
        <SymbolView
          name={item.open ? "chevron.down" : "chevron.right"}
          size={9}
          weight="semibold"
          type="monochrome"
          tintColorClassName={
            sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-tertiary"
          }
          style={{ opacity: item.open ? 0.6 : 1 }}
        />
      ) : null}
    </>
  );
  if (!item.foldable) {
    return (
      <View accessibilityRole="header" className={className}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        item.hiddenUnread
          ? gt("{label}, {count}, has unread threads", { label, count: item.count })
          : gt("{label}, {count}", { label, count: item.count })
      }
      accessibilityState={{ expanded: item.open }}
      accessibilityHint={item.open ? gt("Folds this section.") : gt("Unfolds this section.")}
      className={className}
      hitSlop={{ top: 4, bottom: 4 }}
      onPress={() => toggleMatterTimelineSection(item.sectionId, item.open)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  );
});
