import { MaskedView } from "@expo/ui/community/masked-view";
import { View } from "react-native";

import { ProviderIcon } from "../../../components/ProviderIcon";
import { cn } from "../../../lib/cn";

/**
 * A provider's logo as a flat glyph in one ink, like the Mac sidebar's grayscale mark. The logo
 * only masks a fill, so brand colors, gradients and bitmap logos all come out the same tone.
 */
export function MatterProviderMark(props: {
  readonly provider: string | null | undefined;
  readonly iconUrl: string | undefined;
  readonly size: number;
  readonly fillClassName: string;
}) {
  const box = { width: props.size, height: props.size };
  return (
    <MaskedView
      style={box}
      maskElement={
        <ProviderIcon iconUrl={props.iconUrl} provider={props.provider} size={props.size} />
      }
    >
      <View className={cn("flex-1", props.fillClassName)} />
    </MaskedView>
  );
}
