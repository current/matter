import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type ScrollViewInstance,
} from "react-native";
import Animated, {
  Easing,
  makeMutable,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import { NativeVoiceAudio } from "./nativeVoiceAudio";
import {
  executeVoiceClientAction,
  pickVoiceConnection,
  readVoiceWorkspaceContext,
  watchVoiceWorkspace,
} from "./mobileVoiceContext";
import { createVoiceAssistantApi } from "./voiceAssistantApi";
import type { VoiceTurnEntry } from "./voiceContextLogic";
import { VoiceModeSession, type VoicePhase } from "./voiceModeSession";

const BACKGROUND = "#05060A";
const ORB_SIZE = 168;

const PHASE_COLOR: Record<VoicePhase, string> = {
  starting: "#6B7280",
  listening: "#5EA2FF",
  hearing: "#4DE3B5",
  transcribing: "#B58CFF",
  thinking: "#B58CFF",
  speaking: "#FFB86B",
  muted: "#6B7280",
  paused: "#8AA4C8",
  error: "#FF6B6B",
};

function VoiceOrb(props: {
  readonly level: SharedValue<number>;
  readonly phase: VoicePhase;
  readonly label: string;
  readonly onPress: () => void;
}) {
  const pulse = useSharedValue(0);
  const smoothed = useDerivedValue(() => withTiming(props.level.value, { duration: 90 }));
  const animates = props.phase === "speaking" || props.phase === "thinking";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the UI-thread pulse that stands in for output level while the assistant speaks or thinks
  useEffect(() => {
    pulse.set(
      animates
        ? withRepeat(withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }), -1, true)
        : withTiming(0, { duration: 200 }),
    );
  }, [animates, pulse]);

  const outer = useAnimatedStyle(() => ({
    transform: [{ scale: 1.05 + smoothed.value * 0.75 + pulse.value * 0.22 }],
    opacity: 0.16 + smoothed.value * 0.2,
  }));
  const middle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + smoothed.value * 0.42 + pulse.value * 0.12 }],
    opacity: 0.3 + smoothed.value * 0.25,
  }));
  const core = useAnimatedStyle(() => ({
    transform: [{ scale: 0.86 + smoothed.value * 0.18 + pulse.value * 0.05 }],
  }));
  const color = PHASE_COLOR[props.phase];
  const disc = {
    position: "absolute",
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    backgroundColor: color,
  } as const;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="items-center justify-center"
      style={{ width: ORB_SIZE * 2, height: ORB_SIZE * 2 }}
    >
      <Animated.View style={[disc, outer]} />
      <Animated.View style={[disc, middle]} />
      <Animated.View style={[disc, core]} />
    </Pressable>
  );
}

function ToolBadge(props: { readonly label: string; readonly ok: boolean }) {
  return (
    <View
      className="rounded-full px-2.5 py-1"
      style={{ backgroundColor: props.ok ? "rgba(77,227,181,0.16)" : "rgba(255,107,107,0.18)" }}
    >
      <Text
        className="text-xs"
        numberOfLines={1}
        style={{ color: props.ok ? "#4DE3B5" : "#FF8F8F" }}
      >
        {props.label}
      </Text>
    </View>
  );
}

function TurnRow(props: { readonly turn: VoiceTurnEntry }) {
  const isUser = props.turn.role === "user";
  return (
    <View className={isUser ? "items-end" : "items-start"} style={{ gap: 6 }}>
      <View
        className="max-w-[88%] rounded-2xl px-3.5 py-2.5"
        style={{ backgroundColor: isUser ? "rgba(255,255,255,0.1)" : "transparent" }}
      >
        <Text
          className="text-base leading-snug"
          style={{ color: isUser ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.78)" }}
        >
          {props.turn.text}
        </Text>
      </View>
      {props.turn.toolBadges.length > 0 ? (
        <View className="max-w-[88%] flex-row flex-wrap" style={{ gap: 6 }}>
          {props.turn.toolBadges.map((badge) => (
            <ToolBadge key={badge.id} label={badge.label} ok={badge.ok} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function RoundButton(props: {
  readonly label: string;
  readonly active?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active === true }}
      onPress={props.onPress}
      className="size-14 items-center justify-center rounded-full active:opacity-70"
      style={{
        backgroundColor: props.danger
          ? "rgba(255,107,107,0.9)"
          : props.active
            ? "rgba(255,255,255,0.9)"
            : "rgba(255,255,255,0.12)",
      }}
    >
      {props.children}
    </Pressable>
  );
}

export function MattrVoiceModeScreen() {
  const gt = useGT();
  const navigation = useNavigation();
  const openWorkspaceDetail = useOpenWorkspaceDetail();
  const insets = useSafeAreaInsets();
  const [level] = useState(() => makeMutable(0));
  const [session] = useState(
    () =>
      new VoiceModeSession({
        audio: new NativeVoiceAudio(),
        getApi: () => {
          const prepared = pickVoiceConnection();
          return prepared ? createVoiceAssistantApi(prepared) : null;
        },
        readContext: readVoiceWorkspaceContext,
        watchWorkspace: watchVoiceWorkspace,
        executeAction: (action) =>
          executeVoiceClientAction(action, {
            openThread: (target) => {
              navigation.goBack();
              openWorkspaceDetail({ name: "Thread", params: target });
            },
          }),
        setLevel: (value) => level.set(value),
      }),
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [textOpen, setTextOpen] = useState(false);
  const [draft, setDraft] = useState("");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the microphone and audio session with the screen and releases them when it closes
  useEffect(() => {
    session.start();
    return () => void session.stop();
  }, [session]);
  const transcript = useRef<ScrollViewInstance>(null);

  const labels: Record<VoicePhase, string> = {
    starting: gt("Starting…"),
    listening: gt("Listening"),
    hearing: gt("Listening…"),
    transcribing: gt("Transcribing…"),
    thinking: gt("Thinking…"),
    speaking: gt("Speaking · tap to interrupt"),
    muted: gt("Muted"),
    paused: gt("Tap to talk"),
    error: gt("Something went wrong"),
  };
  const orbHint =
    snapshot.phase === "speaking"
      ? gt("Interrupt")
      : snapshot.phase === "hearing" || snapshot.phase === "listening"
        ? gt("Send now")
        : snapshot.phase === "thinking" || snapshot.phase === "transcribing"
          ? gt("Cancel")
          : gt("Start listening");
  const approval = snapshot.pendingApprovals[0] ?? null;

  const sendDraft = () => {
    session.sendText(draft);
    setDraft("");
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: BACKGROUND }}
    >
      <View
        className="flex-row items-center justify-between px-4"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Close voice mode")}
          onPress={() => navigation.goBack()}
          className="size-11 items-center justify-center rounded-full active:opacity-70"
          style={{ backgroundColor: "rgba(255,255,255,0.12)" }}
        >
          <SymbolView name="xmark" size={18} tintColor="#FFFFFF" weight="semibold" />
        </Pressable>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: snapshot.handsFree }}
          accessibilityLabel={gt("Hands-free")}
          onPress={() => session.setHandsFree(!snapshot.handsFree)}
          className="rounded-full px-4 py-2.5 active:opacity-70"
          style={{
            backgroundColor: snapshot.handsFree ? "rgba(77,227,181,0.2)" : "rgba(255,255,255,0.12)",
          }}
        >
          <Text
            className="text-sm font-semibold"
            style={{ color: snapshot.handsFree ? "#4DE3B5" : "rgba(255,255,255,0.7)" }}
          >
            {snapshot.handsFree ? gt("Hands-free on") : gt("Tap to talk")}
          </Text>
        </Pressable>
      </View>

      <View className="flex-1 items-center justify-center">
        <VoiceOrb
          level={level}
          phase={snapshot.phase}
          label={orbHint}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            session.tapOrb();
          }}
        />
        <Text
          accessibilityLiveRegion="polite"
          className="mt-2 text-lg font-semibold"
          style={{ color: "rgba(255,255,255,0.92)" }}
        >
          {labels[snapshot.phase]}
        </Text>
        {snapshot.error !== null ? (
          <Text
            accessibilityRole="alert"
            className="mt-1.5 px-8 text-center text-sm"
            style={{ color: "#FF8F8F" }}
          >
            {snapshot.error}
          </Text>
        ) : null}
      </View>

      {approval !== null ? (
        <View
          className="mx-4 mb-3 rounded-3xl p-4"
          style={{ backgroundColor: "rgba(255,184,107,0.12)", gap: 10 }}
        >
          <Text className="text-xs font-semibold uppercase" style={{ color: "#FFB86B" }}>
            {gt("Approval needed")}
          </Text>
          <Text className="text-base font-semibold" style={{ color: "rgba(255,255,255,0.95)" }}>
            {approval.title}
          </Text>
          <Text className="text-sm" numberOfLines={2} style={{ color: "rgba(255,255,255,0.65)" }}>
            {approval.detail ?? approval.threadTitle}
          </Text>
          <View className="flex-row" style={{ gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void session.respondToApproval(approval, "decline")}
              className="flex-1 items-center rounded-full py-3 active:opacity-70"
              style={{ backgroundColor: "rgba(255,255,255,0.12)" }}
            >
              <Text className="text-base font-semibold" style={{ color: "#FFFFFF" }}>
                {gt("Decline")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void session.respondToApproval(approval, "accept")}
              className="flex-1 items-center rounded-full py-3 active:opacity-70"
              style={{ backgroundColor: "#FFB86B" }}
            >
              <Text className="text-base font-semibold" style={{ color: "#1A1205" }}>
                {gt("Allow")}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {snapshot.turns.length > 0 ? (
        <ScrollView
          ref={transcript}
          className="mb-2 max-h-[34%] px-4"
          contentContainerStyle={{ gap: 10, paddingVertical: 4 }}
          onContentSizeChange={() => transcript.current?.scrollToEnd({ animated: true })}
        >
          {snapshot.turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} />
          ))}
        </ScrollView>
      ) : null}

      {textOpen ? (
        <View className="mx-4 mb-3 flex-row items-center" style={{ gap: 8 }}>
          <TextInput
            autoFocus
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={sendDraft}
            returnKeyType="send"
            placeholder={gt("Type instead")}
            placeholderTextColor="rgba(255,255,255,0.4)"
            className="min-h-12 flex-1 rounded-full px-4 text-base"
            style={{ backgroundColor: "rgba(255,255,255,0.1)", color: "#FFFFFF" }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Send")}
            onPress={sendDraft}
            className="size-12 items-center justify-center rounded-full active:opacity-70"
            style={{ backgroundColor: "#4DA3FF" }}
          >
            <SymbolView name="arrow.up" size={18} tintColor="#FFFFFF" weight="bold" />
          </Pressable>
        </View>
      ) : null}

      <View
        className="flex-row items-center justify-center"
        style={{ gap: 28, paddingBottom: insets.bottom + 16, paddingTop: 4 }}
      >
        <RoundButton
          label={snapshot.muted ? gt("Unmute") : gt("Mute")}
          danger={snapshot.muted}
          onPress={() => session.setMuted(!snapshot.muted)}
        >
          <SymbolView name="mic" size={22} tintColor="#FFFFFF" weight="semibold" />
        </RoundButton>
        <RoundButton
          label={gt("Type instead")}
          active={textOpen}
          onPress={() => setTextOpen((open) => !open)}
        >
          <SymbolView
            name="keyboard"
            size={22}
            tintColor={textOpen ? "#05060A" : "#FFFFFF"}
            weight="semibold"
          />
        </RoundButton>
      </View>
    </KeyboardAvoidingView>
  );
}
