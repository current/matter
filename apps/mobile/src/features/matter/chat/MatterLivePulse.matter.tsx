import { useIsFocused } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import { Animated, useAnimatedValue, type StyleProp, type ViewStyle } from "react-native";

import { useAppActive, useReduceMotionEnabled } from "../../../lib/appState";
import { startMatterPulseSteps } from "./matterLivePulse";

/**
 * Matter's stepped opacity pulse for live work rows. It runs only while the app is active, its
 * screen is focused and reduced motion is off, and writes a native value, so React never renders.
 */
export function MatterLivePulse(props: {
  readonly active?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}) {
  const appIsActive = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  const screenIsFocused = useIsFocused();
  const opacity = useAnimatedValue(1, { useNativeDriver: true });
  const running = props.active !== false && appIsActive && screenIsFocused && !reducedMotion;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- steps the native opacity on timers while the row is live and visible, and stops them on cleanup
  useEffect(() => {
    if (!running) return;
    return startMatterPulseSteps(opacity);
  }, [opacity, running]);

  return <Animated.View style={[props.style, { opacity }]}>{props.children}</Animated.View>;
}
