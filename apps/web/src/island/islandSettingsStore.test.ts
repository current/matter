import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_ISLAND_SETTINGS } from "../../../../antimatter/island/types";
import { DEFAULT_VOICE_ASSISTANT_SETTINGS } from "../../../../antimatter/voice-assistant/types";
import {
  getIslandSettings,
  normalizeIslandSettings,
  updateIslandSettings,
  updateVoiceAssistantSettings,
} from "./islandSettingsStore";

describe("islandSettingsStore", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
  });

  it("defaults to enabled with single-tap Control shortcut, notifications, and voiceAssistant defaults", () => {
    expect(getIslandSettings()).toEqual({
      enabled: true,
      shortcut: "control",
      showNotifications: true,
      showMessages: true,
      voiceAssistant: DEFAULT_VOICE_ASSISTANT_SETTINGS,
    });
  });

  it("updates partial top-level settings cleanly without clobbering voiceAssistant", () => {
    updateVoiceAssistantSettings({ ttsProvider: "openai", ttsVoice: "coral", ttsSpeed: 1.2 });
    const next = updateIslandSettings({ shortcut: "option", showMessages: false });
    expect(next.shortcut).toBe("option");
    expect(next.showMessages).toBe(false);
    expect(next.enabled).toBe(true);
    expect(next.voiceAssistant.ttsProvider).toBe("openai");
    expect(next.voiceAssistant.ttsVoice).toBe("coral");
    expect(next.voiceAssistant.ttsSpeed).toBe(1.2);
    expect(getIslandSettings()).toEqual(next);
  });

  it("merges partial voiceAssistant updates and clamps numeric bounds", () => {
    const next = updateVoiceAssistantSettings({
      defaultMode: "assistant",
      ttsSpeed: 9,
      silenceTimeoutMs: 100,
      announceCompletions: false,
    });
    expect(next.voiceAssistant.defaultMode).toBe("assistant");
    expect(next.voiceAssistant.ttsSpeed).toBe(1.5);
    expect(next.voiceAssistant.silenceTimeoutMs).toBe(400);
    expect(next.voiceAssistant.announceCompletions).toBe(false);
    expect(next.voiceAssistant.announceApprovals).toBe(true);
    expect(getIslandSettings()).toEqual(next);
  });

  it("preserves backwards compatibility with legacy stored settings lacking voiceAssistant", () => {
    const legacy = {
      enabled: false,
      shortcut: "command-shift-space",
      showNotifications: false,
      showMessages: true,
    };
    const normalized = normalizeIslandSettings(legacy);
    expect(normalized).toEqual({
      enabled: false,
      shortcut: "command-shift-space",
      showNotifications: false,
      showMessages: true,
      voiceAssistant: DEFAULT_VOICE_ASSISTANT_SETTINGS,
    });
  });

  it("falls back safely on invalid stored voiceAssistant fields", () => {
    const normalized = normalizeIslandSettings({
      shortcut: "invalid-shortcut",
      voiceAssistant: {
        defaultMode: "bogus",
        ttsProvider: "unknown",
        ttsSpeed: Number.NaN,
        silenceTimeoutMs: 99_999,
        proactiveBriefings: false,
      },
    });
    expect(normalized.shortcut).toBe(DEFAULT_ISLAND_SETTINGS.shortcut);
    expect(normalized.voiceAssistant.defaultMode).toBe(
      DEFAULT_VOICE_ASSISTANT_SETTINGS.defaultMode,
    );
    expect(normalized.voiceAssistant.ttsProvider).toBe(
      DEFAULT_VOICE_ASSISTANT_SETTINGS.ttsProvider,
    );
    expect(normalized.voiceAssistant.ttsSpeed).toBe(DEFAULT_VOICE_ASSISTANT_SETTINGS.ttsSpeed);
    expect(normalized.voiceAssistant.silenceTimeoutMs).toBe(5000);
    expect(normalized.voiceAssistant.proactiveBriefings).toBe(false);
  });
});
