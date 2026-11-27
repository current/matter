import { msg, T, useGT, useMessages } from "gt-react-native";
import {
  MATTER_NATIVE_STREAM_ANIMATION_IDS,
  type MatterNativeStreamAnimationId,
} from "@t3tools/client-runtime/matter/stream-animation";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { useReduceMotionEnabled } from "../../../lib/appState";
import { resolveNativeMarkdownTypography } from "../../../lib/appearancePreferences";
// oxlint-disable-next-line t3code/no-mobile-uniwind-theme-escape-hatches -- the native markdown view takes resolved colors, as in ThreadFeed
import { useUniwindTheme } from "../../../lib/useUniwindTheme";
import {
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { MatterStreamingTextScope } from "./MatterStreamingText.matter";
import {
  setMatterStreamAnimation,
  useMatterStreamAnimationSetting,
} from "./matterStreamAnimationStore";
import { matterStreamPreviewArrivals, PREVIEW_TURN_END_DELAY_MS } from "./matterStreamPreview";

const STREAM_ANIMATION_COPY: Readonly<
  Record<MatterNativeStreamAnimationId, { readonly name: string; readonly description: string }>
> = {
  instant: {
    name: msg("Instant", { $context: "streaming text animation" }),
    description: msg("Text appears as it arrives, with no motion", {
      $context: "streaming text animation",
    }),
  },
  fade: {
    name: msg("Soft Fade", { $context: "streaming text animation" }),
    description: msg("New words glide in with a light fade", {
      $context: "streaming text animation",
    }),
  },
  typewriter: {
    name: msg("Smooth Pace", { $context: "streaming text animation" }),
    description: msg("Evens out bursts into a steady flow", {
      $context: "streaming text animation",
    }),
  },
  phrase: {
    name: msg("Phrase", { $context: "streaming text animation" }),
    description: msg("A whole phrase lands at once, so nothing moves while you read", {
      $context: "streaming text animation",
    }),
  },
};

function usePreviewTextStyle(): NativeMarkdownTextStyle {
  const { appearance, fontFamilies, monoFontFamily } = useAppearancePreferences();
  const theme = useUniwindTheme();
  const typography = resolveNativeMarkdownTypography(appearance.baseFontSize);
  return {
    color: theme["--color-md-body"],
    strongColor: theme["--color-md-strong"],
    mutedColor: theme["--color-md-body"],
    linkColor: theme["--color-md-link"],
    inlineCodeColor: theme["--color-foreground-secondary"],
    codeColor: theme["--color-md-code-text"],
    codeBackgroundColor: theme["--color-md-code-bg"],
    codeBlockBackgroundColor: theme["--color-md-code-bg"],
    fileTextColor: theme["--color-md-code-text"],
    quoteMarkerColor: theme["--color-md-blockquote-border"],
    dividerColor: theme["--color-md-hr"],
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight,
    headingFontSizes: typography.headingFontSizes,
    fontFamily: fontFamilies.regular,
    headingFontFamily: fontFamilies.bold,
    boldFontFamily: fontFamilies.bold,
    monoFontFamily,
  };
}

/** Plays the sample once on mount, through the same native view and scope the chat uses. */
function StreamPreview(props: {
  readonly sample: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly reduceMotion: boolean;
}) {
  const [arrived, setArrived] = useState(props.reduceMotion ? props.sample.length : 0);
  const [streaming, setStreaming] = useState(!props.reduceMotion);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replays a timed sample stream; the timers end with the sample.
  useEffect(() => {
    if (props.reduceMotion) return;
    const arrivals = matterStreamPreviewArrivals(props.sample);
    const timers = arrivals.map((arrival) =>
      setTimeout(() => setArrived(arrival.length), arrival.at),
    );
    const end = (arrivals.at(-1)?.at ?? 0) + PREVIEW_TURN_END_DELAY_MS;
    timers.push(setTimeout(() => setStreaming(false), end));
    return () => timers.forEach(clearTimeout);
  }, [props.sample, props.reduceMotion]);

  const visible = props.sample.slice(0, arrived);
  return (
    <View>
      {/* The whole sample, hidden, holds the height so rows below don't move as words arrive. */}
      <View
        style={{ opacity: 0 }}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <SelectableMarkdownText markdown={props.sample} textStyle={props.textStyle} />
      </View>
      <View className="absolute inset-x-0 top-0">
        {visible.length > 0 ? (
          <MatterStreamingTextScope streaming={streaming}>
            <SelectableMarkdownText markdown={visible} textStyle={props.textStyle} />
          </MatterStreamingTextScope>
        ) : null}
      </View>
    </View>
  );
}

/** Settings → Appearance: how assistant text arrives while it streams, saved on this device. */
export function MatterStreamAnimationSection() {
  const gt = useGT();
  const m = useMessages();
  const animation = useMatterStreamAnimationSetting();
  const reduceMotion = useReduceMotionEnabled();
  const textStyle = usePreviewTextStyle();
  const [replay, setReplay] = useState(0);
  const sample = gt(
    "Moved the session store behind `reconnect()`, so a dropped socket resumes mid-turn and every streamed word lands exactly once.",
  );

  return (
    <View className="gap-3">
      <SettingsSection title={gt("Streaming text")}>
        <View className="flex-row items-start gap-3 p-4">
          <View className="min-w-0 flex-1">
            <StreamPreview
              key={`${animation}:${replay}:${reduceMotion}`}
              sample={sample}
              textStyle={textStyle}
              reduceMotion={reduceMotion}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Replay preview")}
            hitSlop={8}
            className="size-7 items-center justify-center rounded-full bg-subtle"
            onPress={() => setReplay((count) => count + 1)}
          >
            <SymbolView name="arrow.clockwise" size={13} tintColorClassName="accent-icon-subtle" />
          </Pressable>
        </View>
        {MATTER_NATIVE_STREAM_ANIMATION_IDS.map((id) => (
          <ListChoiceRow
            key={id}
            label={m(STREAM_ANIMATION_COPY[id].name)}
            description={m(STREAM_ANIMATION_COPY[id].description)}
            selected={animation === id}
            separated
            onPress={() => setMatterStreamAnimation(id)}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        <T>
          How new words appear while an assistant replies. Finished messages always render plain.
          Reduce Motion shows text instantly.
        </T>
      </Text>
    </View>
  );
}
