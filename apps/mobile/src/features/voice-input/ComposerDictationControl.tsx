import type { VoiceInputPhase, VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useGT } from "gt-react-native";
import { memo, useState, type ReactNode } from "react";
import { Linking, Pressable, Text as SystemText, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  withTiming,
  type EntryExitAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { SiriWaveMobile } from "../mattr-voice/SiriWaveMobile";
import type { VoiceComposerPresentation } from "./voiceInputPresentation";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const DICTATION_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const TOOLBAR_FLIP_TIMING = {
  duration: 260,
  easing: Easing.inOut(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const TOOLBAR_HALF_HEIGHT = 22;
const TOOLBAR_PERSPECTIVE = 600;

function toolbarFlip(fromDegrees: number, toDegrees: number): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const fromRadians = (fromDegrees * Math.PI) / 180;
    const toRadians = (toDegrees * Math.PI) / 180;
    const fromSine = Math.sin(fromRadians);
    const toSine = Math.sin(toRadians);
    return {
      initialValues: {
        opacity: fromDegrees === 0 ? 1 : 0,
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          { translateY: -TOOLBAR_HALF_HEIGHT * fromSine },
          { rotateX: `${fromDegrees}deg` },
        ],
      },
      animations: {
        opacity: withTiming(toDegrees === 0 ? 1 : 0, TOOLBAR_FLIP_TIMING),
        transform: [
          { perspective: TOOLBAR_PERSPECTIVE },
          {
            translateY: withTiming(-TOOLBAR_HALF_HEIGHT * toSine, {
              ...TOOLBAR_FLIP_TIMING,
              easing: (time) => {
                const angle =
                  fromRadians + (toRadians - fromRadians) * TOOLBAR_FLIP_TIMING.easing(time);
                return (Math.sin(angle) - fromSine) / (toSine - fromSine);
              },
            }),
          },
          { rotateX: withTiming(`${toDegrees}deg`, TOOLBAR_FLIP_TIMING) },
        ],
      },
    };
  };
}

const DRAFT_TOOLBAR_ENTERING = toolbarFlip(90, 0);
const DRAFT_TOOLBAR_EXITING = toolbarFlip(0, 90);
const DICTATION_TOOLBAR_ENTERING = toolbarFlip(-90, 0);
const DICTATION_TOOLBAR_EXITING = toolbarFlip(0, -90);
const WAVEFORM_HEIGHT = 32;
const COMPACT_WAVEFORM_WIDTH = 44;
const COMPACT_WAVEFORM_HEIGHT = 18;

export function ComposerDictationDraftContent(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly compact: boolean;
  readonly hidden: boolean;
}) {
  const hidden = props.hidden;
  const rotation = useDerivedValue(() => withTiming(hidden ? 1 : 0, TOOLBAR_FLIP_TIMING));
  const compact = props.compact;
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: compact ? 1 - rotation.value : 1,
    transform: compact
      ? [
          { perspective: TOOLBAR_PERSPECTIVE },
          { translateY: -TOOLBAR_HALF_HEIGHT * Math.sin((rotation.value * Math.PI) / 2) },
          { rotateX: `${rotation.value * 90}deg` },
        ]
      : [],
  }));

  return (
    <Animated.View
      accessibilityElementsHidden={props.hidden}
      importantForAccessibility={props.hidden ? "no-hide-descendants" : "auto"}
      collapsable={false}
      className={props.className}
      pointerEvents={props.hidden ? "none" : "auto"}
      style={[animatedStyle, { backfaceVisibility: "hidden" }]}
    >
      {props.children}
    </Animated.View>
  );
}

export function ComposerDictationToolbar(props: {
  readonly children: ReactNode;
  readonly showsDictation: boolean;
  readonly visible?: boolean;
}) {
  // Android can drop the reduced-motion flip's final frame, leaving the toolbar invisible.
  const reducedMotion = useReducedMotion();
  const entering = props.showsDictation ? DICTATION_TOOLBAR_ENTERING : DRAFT_TOOLBAR_ENTERING;
  const exiting = props.showsDictation ? DICTATION_TOOLBAR_EXITING : DRAFT_TOOLBAR_EXITING;

  return (
    <View className="relative h-[44px] overflow-hidden">
      {props.visible !== false ? (
        <Animated.View
          key={props.showsDictation ? "dictation" : "draft"}
          className="absolute inset-0"
          entering={reducedMotion ? undefined : entering}
          exiting={reducedMotion ? undefined : exiting}
          style={{ backfaceVisibility: "hidden" }}
        >
          {props.children}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The newest metering sample drives the wave's stretch. */
function useLatestLevel(audioLevels: SharedValue<ReadonlyArray<number>>) {
  return useDerivedValue(() => audioLevels.value[VOICE_WAVEFORM_SAMPLE_COUNT - 1] ?? 0);
}

export const CompactVoiceWaveform = memo(function CompactVoiceWaveform(props: {
  readonly audioLevels: SharedValue<ReadonlyArray<number>>;
}) {
  const level = useLatestLevel(props.audioLevels);
  return (
    <SiriWaveMobile
      compact
      active
      level={level}
      mode="listening"
      width={COMPACT_WAVEFORM_WIDTH}
      height={COMPACT_WAVEFORM_HEIGHT}
    />
  );
});

const VoiceWaveform = memo(function VoiceWaveform(props: {
  readonly audioLevels: SharedValue<ReadonlyArray<number>>;
  readonly active: boolean;
}) {
  const level = useLatestLevel(props.audioLevels);
  const [width, setWidth] = useState(0);
  const handleLayout = (event: LayoutChangeEvent) => {
    setWidth(Math.round(event.nativeEvent.layout.width));
  };

  return (
    <View
      className="min-w-0 flex-1 items-center justify-center overflow-hidden"
      style={{ height: WAVEFORM_HEIGHT }}
      onLayout={handleLayout}
    >
      {width > 0 ? (
        <SiriWaveMobile
          compact
          active={props.active}
          level={level}
          mode="listening"
          width={width}
          height={WAVEFORM_HEIGHT}
        />
      ) : null}
    </View>
  );
});

/** Use system tabular figures; DM Sans lacks them and would jitter. */
export function DictationElapsedTime(props: {
  readonly seconds: number;
  readonly className?: string;
}) {
  return (
    <SystemText
      className={cn("text-xs", props.className)}
      numberOfLines={1}
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {Math.floor(props.seconds / 60)}:{String(props.seconds % 60).padStart(2, "0")}
    </SystemText>
  );
}

function VoiceActionButton(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: AppSymbolName;
  readonly loading?: boolean;
  readonly onPress: () => void;
  readonly variant?: "plain" | "primary";
}) {
  const { scale } = useAndroidControlSizing();
  const variant = props.variant ?? "plain";
  const loading = props.loading === true;
  const large = props.size === "large";
  const circleSize = Math.round((large ? 44 : 30) * scale);
  const iconSize = Math.round(
    (variant === "primary" ? (large ? 20 : 16) : large ? 24 : 20) * scale,
  );
  const primaryStyle = useAnimatedStyle(() => ({
    opacity: withTiming(loading ? 0 : 1, DICTATION_TIMING),
  }));

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: props.loading, disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        opacity: props.disabled && !props.loading ? 0.4 : 1,
        // Matches ComposerActionButton so the circle stays concentric with the large composer corner.
        // An undefined width would still override the class's 44px width.
        ...(variant === "primary" && large ? { width: 62 } : null),
      }}
    >
      <View
        className={cn(
          "items-center justify-center",
          variant === "primary" ? "rounded-full bg-subtle" : "size-[44px]",
        )}
        style={variant === "primary" ? { width: circleSize, height: circleSize } : undefined}
      >
        {variant === "primary" ? (
          <Animated.View
            className="absolute inset-0 rounded-full bg-primary"
            style={primaryStyle}
          />
        ) : null}
        <View className="absolute inset-0 items-center justify-center">
          {props.loading ? (
            <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
          ) : (
            <SymbolView
              name={props.icon}
              size={iconSize}
              weight={variant === "primary" ? "semibold" : "regular"}
              tintColorClassName={
                variant === "primary" ? "accent-primary-foreground" : "accent-icon"
              }
              type="monochrome"
            />
          )}
        </View>
      </View>
    </Pressable>
  );
}

export function ComposerDictationError(props: {
  readonly error: string | null;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  if (!props.error) return null;
  return (
    <View className="min-w-0 flex-row items-center gap-2 px-4 py-3">
      <Text accessibilityRole="alert" className="min-w-0 flex-1 text-sm text-danger-foreground">
        {props.error}
      </Text>
      <Pressable
        accessibilityLabel={gt("Dismiss voice input error")}
        accessibilityRole="button"
        className="size-7 items-center justify-center active:opacity-70"
        hitSlop={8}
        onPress={props.onDismiss}
      >
        <SymbolView
          name="xmark"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

export function ComposerDictationStatus(props: {
  readonly audioLevels: SharedValue<ReadonlyArray<number>>;
  readonly elapsedSeconds: number;
  readonly phase: VoiceInputPhase;
  readonly presentation: VoiceComposerPresentation;
}) {
  const recording = props.phase === "recording";
  const waveformStyle = useAnimatedStyle(() => ({
    opacity: withTiming(recording ? 1 : 0, DICTATION_TIMING),
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: withTiming(recording ? 0 : 1, DICTATION_TIMING),
  }));

  if (!props.presentation.statusLabel || props.presentation.statusKind === "error") return null;
  return (
    <View className="relative h-11 min-w-0 flex-1 justify-center">
      <View
        accessible
        accessibilityLabel={props.presentation.statusLabel}
        accessibilityLiveRegion={props.phase === "recording" ? "none" : "polite"}
        className="h-11"
      >
        <Animated.View
          className="absolute inset-0 min-w-0 flex-row items-center gap-2 px-1"
          style={waveformStyle}
        >
          <VoiceWaveform audioLevels={props.audioLevels} active={recording} />
          <DictationElapsedTime className="text-foreground-muted" seconds={props.elapsedSeconds} />
        </Animated.View>
        <Animated.View className="absolute inset-0 justify-center px-2" style={labelStyle}>
          <Text className="text-center text-sm text-foreground-muted" numberOfLines={1}>
            {props.presentation.statusLabel}
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

export function ComposerDictationCancelAction(props: {
  readonly size?: "regular" | "large";
  readonly presentation: VoiceComposerPresentation;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  if (props.presentation.leadingAction !== "cancel") return null;
  return (
    <VoiceActionButton
      size={props.size}
      accessibilityLabel={gt("Cancel dictation")}
      icon="xmark"
      onPress={props.onCancel}
    />
  );
}

export function ComposerDictationPrimaryAction(props: {
  readonly size?: "regular" | "large";
  readonly state: VoiceInputState;
  readonly presentation: VoiceComposerPresentation;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  if (props.presentation.trailingAction === "confirm") {
    return (
      <VoiceActionButton
        size={props.size}
        accessibilityLabel={
          props.presentation.confirmationEnabled
            ? gt("Finish dictation")
            : (props.presentation.statusLabel ?? gt("Preparing voice input"))
        }
        disabled={!props.presentation.confirmationEnabled}
        icon="checkmark"
        loading={!props.presentation.confirmationEnabled}
        onPress={props.onConfirm}
        variant="primary"
      />
    );
  }

  return <ComposerDictationStartAction {...props} />;
}

export function ComposerDictationStartAction(props: {
  readonly size?: "regular" | "large";
  readonly state: VoiceInputState;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  if (!props.isAvailable) return null;
  const openSettings = props.state.phase === "error" && props.state.errorAction === "settings";
  return (
    <VoiceActionButton
      size={props.size}
      accessibilityLabel={openSettings ? gt("Open microphone settings") : gt("Start dictation")}
      disabled={props.disabled}
      icon="mic"
      onPress={
        openSettings
          ? () => {
              props.onCancel();
              void Linking.openSettings();
            }
          : props.onStart
      }
    />
  );
}
