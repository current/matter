import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";

/** Native composer trigger that launches hands-free Voice Mode scoped to the active thread. */
export function ComposerVoiceModeButton(props: {
  readonly size?: "regular" | "large";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const gt = useGT();
  const { scale } = useAndroidControlSizing();
  const large = props.size === "large";
  const iconSize = Math.round((large ? 24 : 20) * scale);

  return (
    <Pressable
      accessibilityLabel={gt("Start voice mode")}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.4 : 1 }}
    >
      <View className="size-[44px] items-center justify-center">
        <SymbolView
          name="waveform"
          size={iconSize}
          weight="regular"
          tintColorClassName="accent-icon"
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}
