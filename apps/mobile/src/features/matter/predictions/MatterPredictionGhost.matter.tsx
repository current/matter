import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";

/**
 * Matter: the predicted next message as ghost text over the empty editor, clamped to three lines,
 * with a Use chip on its first line. It overlaps the editor from the top and grows the composer
 * only by the lines the editor can't hold. Taps outside the chip reach the editor beneath.
 */
export function MatterPredictionGhost(props: {
  readonly text: string | null;
  readonly editorHeight: number;
  readonly inset: number;
  readonly textStyle: { readonly fontSize: number; readonly lineHeight: number };
  readonly onAccept: () => void;
}) {
  const gt = useGT();
  if (props.text === null) return null;
  return (
    <View
      pointerEvents="box-none"
      className="flex-row items-start gap-2"
      style={{
        marginTop: -props.editorHeight,
        minHeight: props.editorHeight,
        paddingVertical: props.inset,
      }}
    >
      <View pointerEvents="none" className="min-w-0 flex-1">
        <Text
          numberOfLines={3}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className="text-placeholder"
          style={props.textStyle}
        >
          {props.text}
        </Text>
      </View>
      <View className="justify-center" style={{ height: props.textStyle.lineHeight }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Use suggested prompt: {prompt}", { prompt: props.text })}
          hitSlop={8}
          onPress={props.onAccept}
          className="h-6 items-center justify-center rounded-full border border-border bg-grouped-card px-2.5 active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            {gt("Use", { $context: "button, fills the suggested message into the composer" })}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
