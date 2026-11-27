import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  matterNativeStreamEffect,
  type MatterNativeStreamEffect,
} from "@t3tools/client-runtime/matter/stream-animation";
import type { StreamingConfig } from "react-native-enriched-markdown";

import { readReduceMotionEnabled, subscribeReduceMotion } from "../../../lib/appState";
import { useMatterStreamAnimationSetting } from "./matterStreamAnimationStore";
import { usePhrasePacedText } from "./usePhrasePacedText";

const MatterStreamEffectContext = createContext<MatterNativeStreamEffect | null>(null);

const subscribeNothing = () => () => {};
const readFalse = () => false;

/**
 * Wraps one assistant message. While it streams, the markdown views inside it fade and pace new
 * words per this device's Streaming text setting; otherwise (and under Reduce Motion) they render
 * exactly as upstream does.
 */
export function MatterStreamingTextScope(props: {
  readonly streaming: boolean;
  readonly children: ReactNode;
}) {
  const animation = useMatterStreamAnimationSetting(props.streaming);
  const reduceMotion = useSyncExternalStore(
    props.streaming ? subscribeReduceMotion : subscribeNothing,
    props.streaming ? readReduceMotionEnabled : readFalse,
    readFalse,
  );
  const effect = props.streaming && !reduceMotion ? matterNativeStreamEffect(animation) : null;
  return <MatterStreamEffectContext value={effect}>{props.children}</MatterStreamEffectContext>;
}

export interface MatterStreamingMarkdownProps {
  readonly markdown?: string;
  readonly streaming?: boolean;
  readonly streamingConfig?: StreamingConfig;
}

const NO_STREAMING: MatterStreamingMarkdownProps = {};

/**
 * Extra props for the native markdown view (spread after its own `markdown`). Outside a streaming
 * scope it is an empty object. The first render inside one plays no animation, so the text a view
 * mounts with (a running thread being opened) shows as it is and only later words fade in.
 */
export function useMatterStreamingMarkdown(markdown: string): MatterStreamingMarkdownProps {
  const effect = use(MatterStreamEffectContext);
  const [armed, setArmed] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- arms the fade a frame after the native view drew the text it mounted with, so that text doesn't fade in again.
  useEffect(() => {
    if (effect === null || armed) return;
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, [effect, armed]);
  const paced = usePhrasePacedText(markdown, effect?.phrases === true);
  const streamingConfig = useMemo(
    (): StreamingConfig | undefined =>
      effect === null
        ? undefined
        : {
            animation: armed ? { type: "fade", duration: effect.fadeMs } : "none",
            smooth: effect.smooth,
          },
    [effect, armed],
  );
  if (effect === null || streamingConfig === undefined) return NO_STREAMING;
  return { markdown: paced, streaming: true, streamingConfig };
}
