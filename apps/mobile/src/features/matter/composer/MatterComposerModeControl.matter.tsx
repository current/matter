import { MATTER_INTERACTION_MODES } from "@t3tools/client-runtime/matter/interaction-mode";
import type { ProviderInteractionMode } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";
import { cn } from "../../../lib/cn";
import { MATTER_INTERACTION_MODE_COPY } from "./matterComposerLogic";

const MODE_ICON: Record<ProviderInteractionMode, AppSymbolName> = {
  default: "chevron.left.forwardslash.chevron.right",
  plan: "list.number",
  goal: "target",
};

const MODE_MENU_IMAGE: Record<ProviderInteractionMode, string> = {
  default: "chevron.left.forwardslash.chevron.right",
  plan: "list.number",
  goal: "target",
};

/**
 * Matter's interaction mode control beside `+`: a quiet icon in Default, and a tinted pill with
 * its label and an inline `×` clear button in Plan (emerald) or Goal (amber).
 */
export function MatterComposerModeControl(props: {
  readonly mode: ProviderInteractionMode;
  readonly onModeChange: (mode: ProviderInteractionMode) => void;
  readonly onClear: () => void;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { mode, onModeChange, onClear, disabled = false } = props;
  const active = mode !== "default";
  const label = messages(MATTER_INTERACTION_MODE_COPY[mode].label);

  const iconTintClassName =
    mode === "plan"
      ? "accent-adaptive-emerald-700-300"
      : mode === "goal"
        ? "accent-warning-foreground"
        : "accent-icon-muted";

  const labelClassName =
    mode === "plan" ? "text-adaptive-emerald-700-300" : "text-warning-foreground";

  const trigger = (
    <Pressable
      accessibilityLabel={gt("Interaction mode: {label}", { label })}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: active ? 2 : 4 }}
      className={cn(
        "h-[28px] flex-row items-center justify-center rounded-[8px] active:opacity-70",
        active ? "gap-1.5 pl-2 pr-1" : "w-[28px]",
      )}
    >
      <SymbolView
        name={MODE_ICON[mode]}
        size={14}
        tintColorClassName={iconTintClassName}
        type="monochrome"
      />
      {active ? (
        <Text className={cn("text-xs font-t3-medium", labelClassName)} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );

  const menuTrigger = disabled ? (
    trigger
  ) : (
    <Menu
      title={gt("Mode")}
      actions={MATTER_INTERACTION_MODES.map((option) => ({
        id: option,
        title: messages(MATTER_INTERACTION_MODE_COPY[option].label),
        subtitle: messages(MATTER_INTERACTION_MODE_COPY[option].description),
        image: MODE_MENU_IMAGE[option],
        state: option === mode ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const next = nativeEvent.event as ProviderInteractionMode;
        if (next !== mode) onModeChange(next);
      }}
    >
      {trigger}
    </Menu>
  );

  return (
    <View
      className={cn(
        "h-[28px] shrink-0 flex-row items-center rounded-[8px]",
        mode === "plan" && "bg-adaptive-emerald-500-a12-a16",
        mode === "goal" && "bg-adaptive-amber-500-a12-a16",
        disabled && "opacity-45",
      )}
    >
      {menuTrigger}
      {active ? (
        <Pressable
          accessibilityLabel={gt("Leave {label} mode", { label })}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={{ top: 8, bottom: 8, left: 2, right: 6 }}
          onPress={onClear}
          className="h-[28px] w-[22px] items-center justify-center rounded-r-[8px] opacity-80 active:opacity-50"
        >
          <SymbolView
            name="xmark"
            size={11}
            weight="semibold"
            tintColorClassName={iconTintClassName}
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
