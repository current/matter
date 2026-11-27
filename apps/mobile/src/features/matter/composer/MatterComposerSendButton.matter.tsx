import type { ComponentProps } from "react";
import { Pressable, View, type PressableProps } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { cn } from "../../../lib/cn";

/**
 * Matter's 28px signal-red circular Send/Stop action button (matching desktop `matter/composer.css`),
 * using a muted neutral circle when idle/disabled.
 */
export function MatterComposerSendButton(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly onPress: () => void;
  readonly variant?: "send" | "stop";
  readonly onLongPress?: PressableProps["onLongPress"];
  readonly onTouchStart?: PressableProps["onTouchStart"];
}) {
  const { scale } = useAndroidControlSizing();
  const circleSize = Math.round((props.size === "large" ? 32 : 28) * scale);
  const iconSize = Math.round((props.size === "large" ? 16 : 14) * scale);
  const isActive = props.variant === "stop" || props.disabled !== true;

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      hitSlop={6}
      className="ml-1 size-[32px] shrink-0 items-center justify-center active:scale-95 active:opacity-85"
      disabled={props.disabled}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      onTouchStart={props.onTouchStart}
    >
      <View
        style={{ width: circleSize, height: circleSize }}
        className={cn(
          "items-center justify-center rounded-full",
          isActive ? "bg-danger-foreground" : "bg-adaptive-neutral-200-800",
        )}
      >
        <SymbolView
          name={props.icon}
          size={iconSize}
          weight="semibold"
          tintColorClassName={isActive ? "accent-primary-foreground" : "accent-icon-muted"}
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}
