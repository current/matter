import { useSyncExternalStore } from "react";
import {
  DEFAULT_ISLAND_SETTINGS,
  type IslandSettings,
  type IslandShortcutMode,
} from "../../../../antimatter/island/types";
import {
  DEFAULT_VOICE_ASSISTANT_SETTINGS,
  ELEVENLABS_TTS_MODELS,
  type VoiceAssistantSettings,
  type VoiceTtsProvider,
} from "../../../../antimatter/voice-assistant/types";

const STORAGE_KEY = "mattr:island:settings:v1";

const VALID_SHORTCUTS = new Set<IslandShortcutMode>([
  "control",
  "option",
  "command-shift-space",
  "off",
]);

const VALID_VOICE_DEFAULT_MODES = new Set<VoiceAssistantSettings["defaultMode"]>([
  "smart",
  "assistant",
  "dictation",
]);

const VALID_TTS_PROVIDERS = new Set<VoiceTtsProvider>([
  "auto",
  "elevenlabs",
  "deepgram",
  "openai",
  "macos",
  "browser",
  "off",
]);

export const ELEVENLABS_VOICE_ID_PATTERN = /^[A-Za-z0-9]{16,40}$/;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampRounded(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback) * 100) / 100;
}

function normalizeCustomElevenLabsVoiceId(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return ELEVENLABS_VOICE_ID_PATTERN.test(trimmed) ? trimmed : fallback;
}

function normalizeVoiceAssistantSettings(
  raw: unknown,
  base: VoiceAssistantSettings = DEFAULT_VOICE_ASSISTANT_SETTINGS,
): VoiceAssistantSettings {
  const parsed =
    typeof raw === "object" && raw !== null ? (raw as Partial<VoiceAssistantSettings>) : {};
  return {
    defaultMode:
      typeof parsed.defaultMode === "string" &&
      VALID_VOICE_DEFAULT_MODES.has(parsed.defaultMode as VoiceAssistantSettings["defaultMode"])
        ? (parsed.defaultMode as VoiceAssistantSettings["defaultMode"])
        : base.defaultMode,
    speakReplies:
      typeof parsed.speakReplies === "boolean" ? parsed.speakReplies : base.speakReplies,
    ttsProvider:
      typeof parsed.ttsProvider === "string" &&
      VALID_TTS_PROVIDERS.has(parsed.ttsProvider as VoiceTtsProvider)
        ? (parsed.ttsProvider as VoiceTtsProvider)
        : base.ttsProvider,
    ttsVoice: typeof parsed.ttsVoice === "string" ? parsed.ttsVoice : base.ttsVoice,
    elevenlabsModel:
      ELEVENLABS_TTS_MODELS.find((model) => model === parsed.elevenlabsModel) ??
      base.elevenlabsModel,
    elevenlabsVoice:
      typeof parsed.elevenlabsVoice === "string" &&
      ELEVENLABS_VOICE_ID_PATTERN.test(parsed.elevenlabsVoice.trim())
        ? parsed.elevenlabsVoice.trim()
        : base.elevenlabsVoice,
    elevenlabsCustomVoiceId: normalizeCustomElevenLabsVoiceId(
      parsed.elevenlabsCustomVoiceId,
      base.elevenlabsCustomVoiceId,
    ),
    elevenlabsStability: clampRounded(parsed.elevenlabsStability, 0, 1, base.elevenlabsStability),
    elevenlabsSimilarityBoost: clampRounded(
      parsed.elevenlabsSimilarityBoost,
      0,
      1,
      base.elevenlabsSimilarityBoost,
    ),
    elevenlabsStyle: clampRounded(parsed.elevenlabsStyle, 0, 1, base.elevenlabsStyle),
    elevenlabsSpeed: clampRounded(parsed.elevenlabsSpeed, 0.7, 1.2, base.elevenlabsSpeed),
    elevenlabsUseSpeakerBoost:
      typeof parsed.elevenlabsUseSpeakerBoost === "boolean"
        ? parsed.elevenlabsUseSpeakerBoost
        : base.elevenlabsUseSpeakerBoost,
    ttsSpeed: clampNumber(parsed.ttsSpeed, 0.8, 1.5, base.ttsSpeed),
    handsFreeAutoListen:
      typeof parsed.handsFreeAutoListen === "boolean"
        ? parsed.handsFreeAutoListen
        : base.handsFreeAutoListen,
    bargeInEnabled:
      typeof parsed.bargeInEnabled === "boolean" ? parsed.bargeInEnabled : base.bargeInEnabled,
    silenceTimeoutMs: Math.round(
      clampNumber(parsed.silenceTimeoutMs, 400, 5000, base.silenceTimeoutMs),
    ),
    proactiveBriefings:
      typeof parsed.proactiveBriefings === "boolean"
        ? parsed.proactiveBriefings
        : base.proactiveBriefings,
    announceApprovals:
      typeof parsed.announceApprovals === "boolean"
        ? parsed.announceApprovals
        : base.announceApprovals,
    announceQuestions:
      typeof parsed.announceQuestions === "boolean"
        ? parsed.announceQuestions
        : base.announceQuestions,
    announceCompletions:
      typeof parsed.announceCompletions === "boolean"
        ? parsed.announceCompletions
        : base.announceCompletions,
    announceFailures:
      typeof parsed.announceFailures === "boolean"
        ? parsed.announceFailures
        : base.announceFailures,
    soundCuesEnabled:
      typeof parsed.soundCuesEnabled === "boolean"
        ? parsed.soundCuesEnabled
        : base.soundCuesEnabled,
    thinkingCueEnabled:
      typeof parsed.thinkingCueEnabled === "boolean"
        ? parsed.thinkingCueEnabled
        : base.thinkingCueEnabled,
  };
}

export function normalizeIslandSettings(
  raw: unknown,
  base: IslandSettings = DEFAULT_ISLAND_SETTINGS,
): IslandSettings {
  const parsed = typeof raw === "object" && raw !== null ? (raw as Partial<IslandSettings>) : {};
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : base.enabled,
    shortcut:
      typeof parsed.shortcut === "string" &&
      VALID_SHORTCUTS.has(parsed.shortcut as IslandShortcutMode)
        ? (parsed.shortcut as IslandShortcutMode)
        : base.shortcut,
    showNotifications:
      typeof parsed.showNotifications === "boolean"
        ? parsed.showNotifications
        : base.showNotifications,
    showMessages:
      typeof parsed.showMessages === "boolean" ? parsed.showMessages : base.showMessages,
    voiceAssistant: normalizeVoiceAssistantSettings(parsed.voiceAssistant, base.voiceAssistant),
  };
}

function readStoredSettings(): IslandSettings {
  if (typeof window === "undefined") return DEFAULT_ISLAND_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ISLAND_SETTINGS;
    return normalizeIslandSettings(JSON.parse(raw), DEFAULT_ISLAND_SETTINGS);
  } catch {
    return DEFAULT_ISLAND_SETTINGS;
  }
}

let currentSettings: IslandSettings = readStoredSettings();
const listeners = new Set<() => void>();

export function getIslandSettings(): IslandSettings {
  return currentSettings;
}

function subscribeIslandSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateIslandSettings(patch: Partial<IslandSettings>): IslandSettings {
  const next = normalizeIslandSettings(patch, currentSettings);
  currentSettings = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
    void window.desktopBridge?.island?.updateSettings(next).catch(() => undefined);
  }
  for (const listener of listeners) listener();
  return next;
}

export function updateVoiceAssistantSettings(
  patch: Partial<VoiceAssistantSettings>,
): IslandSettings {
  return updateIslandSettings({
    voiceAssistant: normalizeVoiceAssistantSettings(patch, currentSettings.voiceAssistant),
  });
}

export function useIslandSettings(): IslandSettings {
  return useSyncExternalStore(
    subscribeIslandSettings,
    getIslandSettings,
    () => DEFAULT_ISLAND_SETTINGS,
  );
}
