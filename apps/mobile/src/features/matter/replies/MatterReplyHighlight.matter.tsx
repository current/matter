import type { MessageId } from "@t3tools/contracts";
import { useEffect } from "react";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { useMatterReplyHighlight } from "./matterReplies";

/**
 * One-shot tint behind a message a reply jumped to, like desktop's highlight flash. It mounts
 * only while that message is highlighted, so idle rows draw nothing.
 */
export function MatterReplyHighlight(props: { readonly messageId: MessageId }) {
  const nonce = useMatterReplyHighlight(props.messageId);
  if (nonce === null) return null;
  return <MatterReplyHighlightFlash key={nonce} />;
}

function MatterReplyHighlightFlash() {
  const reduceMotion = useReducedMotion();
  // Reduced motion holds a still tint until the highlight ends and the overlay unmounts.
  const opacity = useSharedValue(reduceMotion ? 1 : 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the finite native flash once the highlighted row mounts
  useEffect(() => {
    if (reduceMotion) return;
    opacity.set(
      withSequence(
        withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) }),
        withDelay(700, withTiming(0, { duration: 620, easing: Easing.in(Easing.quad) })),
      ),
    );
  }, [opacity, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute -inset-x-1 -inset-y-1 rounded-[18px] bg-focus/10"
      style={[{ borderCurve: "continuous" }, style]}
    />
  );
}
