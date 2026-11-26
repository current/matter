import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import {
  buildSiriWaveHtml,
  SIRI_WAVE_MESSAGE_FAILED,
  SIRI_WAVE_MESSAGE_READY,
  siriWaveCanvasHeight,
  siriWavePageState,
  siriWaveStateForMode,
  siriWaveStretchWorklet,
  type SiriWaveMobileMode,
} from "./siriWaveMobileLogic";

export type { SiriWaveMobileMode };

const SIRI_WAVE_HTML = buildSiriWaveHtml();
const SIRI_WAVE_SOURCE = { html: SIRI_WAVE_HTML };
const LEVEL_TIMING = { duration: 90 } as const;

function subscribeAppState(onChange: () => void) {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
}
const appIsActive = () => AppState.currentState === "active";

/** The vector stand-in when the WebView has no WebGL: three faint spectral sine strokes. */
function SiriWaveFallback(props: { readonly width: number; readonly height: number }) {
  const { width, height } = props;
  const mid = height / 2;
  const amplitude = height * 0.3;
  const path = (phase: number) => {
    const steps = 32;
    let d = "";
    for (let step = 0; step <= steps; step += 1) {
      const x = (step / steps) * width;
      const t = step / steps;
      const envelope = Math.sin(Math.PI * t) ** 2;
      const y = mid + amplitude * envelope * Math.sin(t * Math.PI * 2.2 + phase);
      d += `${step === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  };
  return (
    <Svg width={width} height={height}>
      <Path d={path(0)} stroke="#FF5A8A" strokeOpacity={0.8} strokeWidth={2} fill="none" />
      <Path d={path(0.9)} stroke="#5EA2FF" strokeOpacity={0.8} strokeWidth={2} fill="none" />
      <Path d={path(1.8)} stroke="#4DE3B5" strokeOpacity={0.8} strokeWidth={2} fill="none" />
    </Svg>
  );
}

/**
 * Lilt's GLSL Siri Wave, the one voice visual across Matter, in a transparent WebGL WebView.
 * The microphone level never crosses the bridge: it stretches the view on the UI thread, as
 * `scaleY` does on web. Only state changes reach the page, and the page stops drawing while
 * inactive or in the background.
 */
export const SiriWaveMobile = memo(function SiriWaveMobile(props: {
  readonly level: SharedValue<number> | number;
  readonly active: boolean;
  readonly mode?: SiriWaveMobileMode;
  readonly width: number;
  readonly height: number;
  /** A small inline strip, such as the composer's dictation row. */
  readonly compact?: boolean;
}) {
  const { level, width, height } = props;
  const mode = props.mode ?? "listening";
  const state = siriWaveStateForMode(mode);
  const reducedMotion = useReducedMotion();
  const appActive = useSyncExternalStore(subscribeAppState, appIsActive);
  const webView = useRef<WebView<object>>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const pageState = siriWavePageState({
    mode,
    active: props.active && appActive,
    reducedMotion,
  });
  const pageStateJson = JSON.stringify(pageState);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes state changes into the WebView page, which lives outside React
  useEffect(() => {
    if (!ready) return;
    webView.current?.injectJavaScript(`window.__siri&&window.__siri.set(${pageStateJson});true;`);
  }, [ready, pageStateJson]);

  // Speech has no output meter here, so a slow swell stands in for the reply's level.
  const swell = useSharedValue(0);
  const swelling = mode === "speaking" && props.active && !reducedMotion;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the UI-thread swell while the assistant speaks
  useEffect(() => {
    swell.set(
      swelling
        ? withRepeat(withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }), -1, true)
        : withTiming(0, { duration: 200 }),
    );
  }, [swelling, swell]);

  const smoothed = useDerivedValue(
    () => withTiming(typeof level === "number" ? level : level.value, LEVEL_TIMING),
    [level],
  );
  const stretchStyle = useAnimatedStyle(() => {
    const live = Math.max(smoothed.value, state === "speaking" ? 0.2 + 0.35 * swell.value : 0);
    return { transform: [{ scaleY: siriWaveStretchWorklet(state, live) }] };
  }, [state]);

  const canvasHeight = siriWaveCanvasHeight(width, height);
  const onMessage = (event: WebViewMessageEvent) => {
    const type = (() => {
      try {
        return (JSON.parse(event.nativeEvent.data) as { readonly type?: unknown }).type;
      } catch {
        return null;
      }
    })();
    if (type === SIRI_WAVE_MESSAGE_READY) setReady(true);
    else if (type === SIRI_WAVE_MESSAGE_FAILED) setFailed(true);
  };

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        width,
        height,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderRadius: props.compact ? height / 2 : 0,
      }}
    >
      <Animated.View style={[{ width, height: failed ? height : canvasHeight }, stretchStyle]}>
        {failed ? (
          <SiriWaveFallback width={width} height={height} />
        ) : (
          <WebView<object>
            ref={webView}
            source={SIRI_WAVE_SOURCE}
            onMessage={onMessage}
            onContentProcessDidTerminate={() => {
              setReady(false);
              webView.current?.reload();
            }}
            style={{ width, height: canvasHeight, backgroundColor: "transparent" }}
            containerStyle={{ backgroundColor: "transparent" }}
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            javaScriptEnabled
            setSupportMultipleWindows={false}
            allowsLinkPreview={false}
            textInteractionEnabled={false}
            androidLayerType="hardware"
            cacheEnabled={false}
          />
        )}
      </Animated.View>
    </View>
  );
});
