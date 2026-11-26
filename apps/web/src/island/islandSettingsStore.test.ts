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

  it("defaults to enabled with the Control shortcut, notch status, and voiceAssistant defaults", () => {
    expect(getIslandSettings()).toEqual({
      enabled: true,
      shortcut: "control",
      showNotifications: true,
      voiceAssistant: DEFAULT_VOICE_ASSISTANT_SETTINGS,
    });
  });

  it("updates partial top-level settings cleanly without clobbering voiceAssistant", () => {
    updateVoiceAssistantSettings({ ttsProvider: "openai", ttsVoice: "coral", ttsSpeed: 1.2 });
    const next = updateIslandSettings({ shortcut: "option", showNotifications: false });
    expect(next.shortcut).toBe("option");
    expect(next.showNotifications).toBe(false);
    expect(next.enabled).toBe(true);
    expect(next.voiceAssistant.ttsProvider).toBe("openai");
    expect(next.voiceAssistant.ttsVoice).toBe("coral");
    expect(next.voiceAssistant.ttsSpeed).toBe(1.2);
    expect(getIslandSettings()).toEqual(next);
  });

  it("accepts ElevenLabs provider, allowlisted models, voice ids, and clamped voice_settings", () => {
    const next = updateVoiceAssistantSettings({
      ttsProvider: "elevenlabs",
      elevenlabsModel: "eleven_flash_v2_5",
      elevenlabsVoice: " IKne3meq5aSn9XLyUdCD ",
      elevenlabsCustomVoiceId: " CustomVoiceId1234567890 ",
      elevenlabsStability: 0.35,
      elevenlabsSimilarityBoost: 0.85,
      elevenlabsStyle: 0.4,
      elevenlabsSpeed: 1.1,
      elevenlabsUseSpeakerBoost: false,
    });
    expect(next.voiceAssistant.ttsProvider).toBe("elevenlabs");
    expect(next.voiceAssistant.elevenlabsModel).toBe("eleven_flash_v2_5");
    expect(next.voiceAssistant.elevenlabsVoice).toBe("IKne3meq5aSn9XLyUdCD");
    expect(next.voiceAssistant.elevenlabsCustomVoiceId).toBe("CustomVoiceId1234567890");
    expect(next.voiceAssistant.elevenlabsStability).toBe(0.35);
    expect(next.voiceAssistant.elevenlabsSimilarityBoost).toBe(0.85);
    expect(next.voiceAssistant.elevenlabsStyle).toBe(0.4);
    expect(next.voiceAssistant.elevenlabsSpeed).toBe(1.1);
    expect(next.voiceAssistant.elevenlabsUseSpeakerBoost).toBe(false);

    const rejected = normalizeIslandSettings({
      voiceAssistant: {
        elevenlabsModel: "eleven_bogus",
        elevenlabsVoice: "../etc",
        elevenlabsCustomVoiceId: "../evil",
        elevenlabsStability: 5,
        elevenlabsSpeed: 0.1,
      },
    });
    expect(rejected.voiceAssistant.elevenlabsModel).toBe("eleven_v4_turbo");
    expect(rejected.voiceAssistant.elevenlabsVoice).toBe("SAz9YHcvj6GT2YYXdXww");
    expect(rejected.voiceAssistant.elevenlabsCustomVoiceId).toBe("");
    expect(rejected.voiceAssistant.elevenlabsStability).toBe(1);
    expect(rejected.voiceAssistant.elevenlabsSpeed).toBe(0.7);
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
    expect(next.voiceAssistant.soundCuesEnabled).toBe(true);
    expect(next.voiceAssistant.thinkingCueEnabled).toBe(true);
    expect(getIslandSettings()).toEqual(next);

    const muted = updateVoiceAssistantSettings({
      soundCuesEnabled: false,
      thinkingCueEnabled: false,
    });
    expect(muted.voiceAssistant.soundCuesEnabled).toBe(false);
    expect(muted.voiceAssistant.thinkingCueEnabled).toBe(false);
  });

  it("keeps legacy stored settings, dropping the old showMessages field and filling voiceAssistant", () => {
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
      voiceAssistant: DEFAULT_VOICE_ASSISTANT_SETTINGS,
    });
  });

  it("accepts deepgram as a valid ttsProvider in normalizeIslandSettings and updates", () => {
    const normalized = normalizeIslandSettings({
      voiceAssistant: {
        ttsProvider: "deepgram",
        ttsVoice: "aura-2-thalia-en",
      },
    });
    expect(normalized.voiceAssistant.ttsProvider).toBe("deepgram");
    expect(normalized.voiceAssistant.ttsVoice).toBe("aura-2-thalia-en");

    const updated = updateVoiceAssistantSettings({
      ttsProvider: "deepgram",
      ttsVoice: "aura-2-apollo-en",
    });
    expect(updated.voiceAssistant.ttsProvider).toBe("deepgram");
    expect(updated.voiceAssistant.ttsVoice).toBe("aura-2-apollo-en");
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
