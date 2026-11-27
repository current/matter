import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { cn } from "../../../lib/cn";

/**
 * Matter's Shelf composer surface: a 17px-radius outer shelf holding the 13px-radius prompt card
 * and an under-tray row beneath it. When `underTray` is absent (scratch or project-less threads),
 * the outer shelf collapses cleanly with no empty rim.
 */
export function MatterComposerShelf(props: {
  readonly children: ReactNode;
  readonly underTray?: ReactNode;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const isDark = themeAppearance === "dark";
  const hasUnderTray = props.underTray !== null && props.underTray !== undefined;

  // Light: #f4f4f5 shelf + #ffffff card. Dark: #111111 shelf + #1a1b1b raised card (matches desktop).
  const shelfSurfaceClass = isDark
    ? "bg-card border-adaptive-neutral-200-a80-white-a8"
    : "bg-grouped-card border-border-subtle";
  const cardSurfaceClass = isDark
    ? "bg-grouped-card border-adaptive-neutral-950-a5-white-a5"
    : "bg-card border-border-subtle";

  const card = (
    <View
      className={cn(
        "overflow-hidden rounded-[13px] border",
        cardSurfaceClass,
        !isDark && Platform.OS !== "android" && "shadow-[0_1px_2px] shadow-adaptive-black-a10-a25",
      )}
      style={{ borderCurve: "continuous" }}
    >
      {props.children}
    </View>
  );

  if (!hasUnderTray) {
    return card;
  }

  return (
    <View
      className={cn("overflow-hidden rounded-[17px] border p-1 pb-0", shelfSurfaceClass)}
      style={{ borderCurve: "continuous" }}
    >
      {card}
      {props.underTray}
    </View>
  );
}
