import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { msg, T, useGT, useMessages } from "gt-react";
import { RadioIcon, Volume2Icon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentSummaries } from "../state/presentation";
import { usePreparedConnection } from "../state/session";
import { SiriWaveVisual } from "./SiriWave";
import {
  ELEVENLABS_VOICE_ID_PATTERN,
  updateIslandSettings,
  updateVoiceAssistantSettings,
  useIslandSettings,
} from "./islandSettingsStore";
import { buildVoiceApiConfig } from "./voiceApiConfig";
import {
  buildVoiceSpeakOptions,
  setVoiceModeOpen,
  syncVoiceTtsPreferencesToServer,
} from "./voiceAssistantStore";
import type { IslandShortcutMode } from "../../../../matter/island/types";
import {
  DEFAULT_ELEVENLABS_VOICE_SETTINGS,
  type ElevenLabsTtsModel,
  type VoiceAssistantSettings,
  type VoiceAvailableTtsInfo,
  type VoiceCredentialsStatus,
  type VoiceSpeakRequest,
  type VoiceTtsProvider,
} from "../../../../matter/voice-assistant/types";

const SHORTCUT_OPTIONS: ReadonlyArray<{
  readonly value: IslandShortcutMode;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "control",
    label: msg("Control (⌃⌃)"),
    hint: msg("Double-tap Control to open; hold it to dictate"),
  },
  {
    value: "option",
    label: msg("Option (⌥⌥)"),
    hint: msg("Double-tap Option to open; hold it to dictate"),
  },
  {
    value: "command-shift-space",
    label: msg("⌘⇧Space"),
    hint: msg("Standard global shortcut"),
  },
  {
    value: "off",
    label: msg("Off"),
    hint: msg("Open by clicking the notch"),
  },
];

const DEFAULT_MODE_OPTIONS: ReadonlyArray<{
  readonly value: "smart" | "assistant" | "dictation";
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "smart",
    label: msg("Smart routing"),
    hint: msg("Routes approvals, thread replies, and Matter Assistant commands automatically"),
  },
  {
    value: "assistant",
    label: msg("Matter Assistant"),
    hint: msg("Always talk to Matter to manage projects, threads, and tools"),
  },
  {
    value: "dictation",
    label: msg("Direct dictation"),
    hint: msg("Dictate directly into the selected thread"),
  },
];

const TTS_PROVIDER_OPTIONS: ReadonlyArray<{
  readonly value: VoiceTtsProvider;
  readonly label: string;
}> = [
  { value: "auto", label: msg("Auto (ElevenLabs, Deepgram, OpenAI, macOS, Browser)") },
  { value: "elevenlabs", label: msg("ElevenLabs") },
  { value: "deepgram", label: msg("Deepgram Aura-2") },
  { value: "openai", label: msg("OpenAI TTS") },
  { value: "macos", label: msg("macOS native voice") },
  { value: "browser", label: msg("Browser speech synthesis") },
  { value: "off", label: msg("Off (visual only)") },
];

const DEEPGRAM_VOICE_OPTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "", label: msg("Thalia (warm, default)") },
  { value: "aura-2-thalia-en", label: msg("Thalia (warm, default)") },
  { value: "aura-2-asteria-en", label: msg("Asteria (bright)") },
  { value: "aura-2-apollo-en", label: msg("Apollo (warm male)") },
  { value: "aura-2-orion-en", label: msg("Orion (calm male)") },
  { value: "aura-2-luna-en", label: msg("Luna (friendly)") },
  { value: "aura-2-arcas-en", label: msg("Arcas (deep male)") },
  { value: "aura-2-helena-en", label: msg("Helena (articulate)") },
];

const OPENAI_VOICE_OPTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "", label: msg("Coral (warm, default)") },
  { value: "coral", label: msg("Coral (warm, default)") },
  { value: "nova", label: msg("Nova (bright)") },
  { value: "alloy", label: msg("Alloy (neutral)") },
  { value: "ash", label: msg("Ash (crisp)") },
  { value: "sage", label: msg("Sage (calm)") },
  { value: "onyx", label: msg("Onyx (deep)") },
  { value: "shimmer", label: msg("Shimmer (expressive)") },
];

const ELEVENLABS_MODEL_OPTIONS: ReadonlyArray<{
  readonly value: ElevenLabsTtsModel;
  readonly label: string;
}> = [
  { value: "eleven_v4_turbo", label: msg("Eleven v4 Turbo (fast, recommended)") },
  { value: "eleven_flash_v2_5", label: msg("Eleven Flash v2.5 (lowest latency)") },
  { value: "eleven_v3_conversational", label: msg("Eleven v3 Conversational (expressive)") },
  { value: "eleven_v4", label: msg("Eleven v4 (studio quality)") },
];

const ELEVENLABS_VOICE_OPTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "SAz9YHcvj6GT2YYXdXww", label: msg("River (relaxed, default)") },
  { value: "EXAVITQu4vr4xnSDxMaL", label: msg("Sarah (reassuring)") },
  { value: "cgSgspJ2msm6clMCkdW9", label: msg("Jessica (playful)") },
  { value: "cjVigY5qzO86Huf0OWal", label: msg("Eric (smooth)") },
  { value: "CwhRBWXzGAHq8TQ4Fs17", label: msg("Roger (laid-back)") },
  { value: "bIHbv24MWmeRgasZH58o", label: msg("Will (relaxed optimist)") },
  { value: "hpp4J3VqNfWAUOO0d1Us", label: msg("Bella (professional)") },
  { value: "XrExE9yKIg1WjnnlVkGX", label: msg("Matilda (knowledgeable)") },
  { value: "IKne3meq5aSn9XLyUdCD", label: msg("Charlie (deep, energetic)") },
  { value: "iP95p4xoKVk53GoZ742B", label: msg("Chris (down-to-earth)") },
];

const DEFAULT_VOICE_SENTINEL = "__default__";

type CredentialProvider = "deepgram" | "elevenlabs";

function CredentialStatusBadge({ configured }: { readonly configured: boolean }) {
  return configured ? (
    <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">
      <T>Configured</T>
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
      <T>Not set</T>
    </span>
  );
}

type VoiceApiConfig = ReturnType<typeof buildVoiceApiConfig>;

async function postVoiceCredentials(
  api: VoiceApiConfig,
  body: { readonly deepgramApiKey: string } | { readonly elevenlabsApiKey: string },
): Promise<
  | { readonly ok: true; readonly status: VoiceCredentialsStatus }
  | { readonly ok: false; readonly reason: "http" | "network" }
> {
  try {
    const response = await fetch(`${api.baseUrl}/api/mattr/voice-assistant/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...api.headers,
      },
      credentials: api.credentials,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, reason: "http" };
    }
    const status = (await response.json()) as VoiceCredentialsStatus;
    return { ok: true, status };
  } catch {
    return { ok: false, reason: "network" };
  }
}

async function fetchAndPlayVoicePreview(
  api: VoiceApiConfig,
  payload: VoiceSpeakRequest,
  audioRef: { current: HTMLAudioElement | null },
  urlRef: { current: string | null },
): Promise<"ok" | "http_error" | "play_error"> {
  if (audioRef.current) {
    audioRef.current.pause();
    audioRef.current = null;
  }
  if (urlRef.current) {
    URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }
  try {
    const response = await fetch(`${api.baseUrl}/api/mattr/voice-assistant/speak`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...api.headers,
      },
      credentials: api.credentials,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return "http_error";
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => {
      if (urlRef.current === url) {
        URL.revokeObjectURL(url);
        urlRef.current = null;
      }
      if (audioRef.current === audio) {
        audioRef.current = null;
      }
    };
    await audio.play();
    return "ok";
  } catch {
    return "play_error";
  }
}

export function IslandSettingsSection() {
  const gt = useGT();
  const messages = useMessages();
  const islandBridge = window.desktopBridge?.island;
  const settings = useIslandSettings();
  const va = settings.voiceAssistant;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentIds = useAtomValue(environmentSummaries.environmentIdsAtom);
  const targetEnvironmentId = primaryEnvironmentId ?? environmentIds[0] ?? null;
  const prepared = Option.getOrNull(usePreparedConnection(targetEnvironmentId));

  const [previewListening, setPreviewListening] = useState(false);
  const [deepgramAvailable, setDeepgramAvailable] = useState(false);
  const [elevenlabsAvailable, setElevenlabsAvailable] = useState(false);
  const [deepgramKeyInput, setDeepgramKeyInput] = useState("");
  const [elevenlabsKeyInput, setElevenlabsKeyInput] = useState("");
  const [customVoiceInput, setCustomVoiceInput] = useState("");
  const [savingKey, setSavingKey] = useState<CredentialProvider | null>(null);
  const [testingVoice, setTestingVoice] = useState(false);
  const [credentialFeedback, setCredentialFeedback] = useState<{
    readonly kind: "ok" | "error";
    readonly text: string;
  } | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const testAudioUrlRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads TTS credential status from the connected server
  useEffect(() => {
    let disposed = false;
    const api = buildVoiceApiConfig(prepared, window.location.origin);
    void fetch(`${api.baseUrl}/api/mattr/voice-assistant/tts-info`, {
      method: "GET",
      headers: api.headers,
      credentials: api.credentials,
    })
      .then(async (response) => {
        if (!response.ok || disposed) return;
        const info = (await response.json()) as Partial<VoiceAvailableTtsInfo>;
        if (!disposed) {
          setDeepgramAvailable(info.deepgramAvailable === true);
          setElevenlabsAvailable(info.elevenlabsAvailable === true);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [prepared]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases temporary audio playback object URL on unmount
  useEffect(() => {
    return () => {
      if (testAudioRef.current) {
        testAudioRef.current.pause();
        testAudioRef.current = null;
      }
      if (testAudioUrlRef.current) {
        URL.revokeObjectURL(testAudioUrlRef.current);
        testAudioUrlRef.current = null;
      }
    };
  }, []);

  const updateTtsSettings = (patch: Partial<VoiceAssistantSettings>) => {
    const next = updateVoiceAssistantSettings(patch);
    void syncVoiceTtsPreferencesToServer(
      buildVoiceApiConfig(prepared, window.location.origin),
      next.voiceAssistant,
    );
  };

  const handleSaveKey = async (provider: CredentialProvider, nextKey: string) => {
    setSavingKey(provider);
    setCredentialFeedback(null);
    const result = await postVoiceCredentials(
      buildVoiceApiConfig(prepared, window.location.origin),
      provider === "elevenlabs" ? { elevenlabsApiKey: nextKey } : { deepgramApiKey: nextKey },
    );
    setSavingKey(null);
    if (!result.ok) {
      setCredentialFeedback({
        kind: "error",
        text:
          result.reason === "network"
            ? gt("Could not reach the Matter server.")
            : provider === "elevenlabs"
              ? gt("Could not save ElevenLabs API key.")
              : gt("Could not save Deepgram API key."),
      });
      return;
    }
    setDeepgramAvailable(result.status.deepgramAvailable);
    setElevenlabsAvailable(result.status.elevenlabsConfigured === true);
    if (provider === "elevenlabs") {
      setElevenlabsKeyInput("");
    } else {
      setDeepgramKeyInput("");
    }
    window.dispatchEvent(new Event("mattr:voice-credentials-changed"));
    const stillConfigured =
      provider === "elevenlabs"
        ? result.status.elevenlabsConfigured === true
        : result.status.deepgramAvailable;
    setCredentialFeedback({
      kind: "ok",
      text: nextKey.trim()
        ? provider === "elevenlabs"
          ? gt("ElevenLabs API key saved locally.")
          : gt("Deepgram API key saved locally.")
        : stillConfigured
          ? gt("Cleared saved key (using environment variable).")
          : provider === "elevenlabs"
            ? gt("ElevenLabs API key removed.")
            : gt("Deepgram API key removed."),
    });
  };

  const handleUseCustomVoice = () => {
    const voiceId = customVoiceInput.trim();
    if (!ELEVENLABS_VOICE_ID_PATTERN.test(voiceId)) {
      setCredentialFeedback({
        kind: "error",
        text: gt("That does not look like an ElevenLabs voice ID."),
      });
      return;
    }
    setCredentialFeedback(null);
    setCustomVoiceInput("");
    updateTtsSettings({ elevenlabsCustomVoiceId: voiceId });
  };

  const handleClearCustomVoice = () => {
    setCredentialFeedback(null);
    setCustomVoiceInput("");
    updateTtsSettings({ elevenlabsCustomVoiceId: "" });
  };

  const sliderStyle = (value: number, min: number, max: number): CSSProperties => {
    const ratio = (value - min) / (max - min);
    return {
      "--settings-slider-progress": `${ratio * 100}%`,
      "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
    } as CSSProperties;
  };

  const handleTestVoice = async () => {
    setTestingVoice(true);
    setCredentialFeedback(null);
    const outcome = await fetchAndPlayVoicePreview(
      buildVoiceApiConfig(prepared, window.location.origin),
      {
        text: gt("Hey! Voice Mode is ready whenever you want to talk through your threads."),
        ...buildVoiceSpeakOptions({
          ...va,
          ttsProvider: va.ttsProvider === "off" ? "auto" : va.ttsProvider,
        }),
      },
      testAudioRef,
      testAudioUrlRef,
    );
    setTestingVoice(false);
    if (outcome === "http_error") {
      setCredentialFeedback({
        kind: "error",
        text: gt("Voice preview failed. Check your API key or selected provider."),
      });
    } else if (outcome === "play_error") {
      setCredentialFeedback({
        kind: "error",
        text: gt("Could not play voice preview."),
      });
    }
  };

  const activeShortcut =
    SHORTCUT_OPTIONS.find((item) => item.value === settings.shortcut) ?? SHORTCUT_OPTIONS[0]!;
  const activeDefaultMode =
    DEFAULT_MODE_OPTIONS.find((item) => item.value === va.defaultMode) ?? DEFAULT_MODE_OPTIONS[0]!;
  const activeTtsProvider =
    TTS_PROVIDER_OPTIONS.find((item) => item.value === va.ttsProvider) ?? TTS_PROVIDER_OPTIONS[0]!;

  const showVoicePicker =
    va.ttsProvider === "auto" || va.ttsProvider === "deepgram" || va.ttsProvider === "openai";
  const voiceOptions =
    va.ttsProvider === "openai"
      ? OPENAI_VOICE_OPTIONS.filter((opt) => opt.value !== "")
      : DEEPGRAM_VOICE_OPTIONS.filter((opt) => opt.value !== "");
  const defaultVoiceLabel =
    va.ttsProvider === "openai" ? msg("Coral (warm, default)") : msg("Thalia (warm, default)");
  const matchedVoiceOption = voiceOptions.find((item) => item.value === va.ttsVoice);
  const selectedVoiceValue = matchedVoiceOption ? matchedVoiceOption.value : DEFAULT_VOICE_SENTINEL;
  const selectedVoiceLabel = matchedVoiceOption ? matchedVoiceOption.label : defaultVoiceLabel;

  const showElevenLabsPickers =
    va.ttsProvider === "elevenlabs" || (va.ttsProvider === "auto" && elevenlabsAvailable);
  const activeElevenLabsModel =
    ELEVENLABS_MODEL_OPTIONS.find((item) => item.value === va.elevenlabsModel) ??
    ELEVENLABS_MODEL_OPTIONS[0]!;
  const matchedElevenLabsVoice = ELEVENLABS_VOICE_OPTIONS.find(
    (item) => item.value === va.elevenlabsVoice,
  );

  const testVoiceButton = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={testingVoice}
      onClick={() => void handleTestVoice()}
    >
      <Volume2Icon className="size-3.5" />
      {testingVoice ? <T>Playing...</T> : <T>Test voice</T>}
    </Button>
  );

  const credentialFeedbackLine = credentialFeedback ? (
    <p
      className={`mt-1.5 text-xs ${
        credentialFeedback.kind === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {credentialFeedback.text}
    </p>
  ) : null;

  return (
    <>
      {islandBridge ? (
        <SettingsSection id="matter-island" title={gt("Matter Island")}>
          <SettingsRow
            title={gt("Notch island")}
            description={gt(
              "Answer agents, capture a prompt or task, and drop files at the notch without leaving the app you are in.",
            )}
            control={
              <Switch
                checked={settings.enabled}
                onCheckedChange={(checked) => updateIslandSettings({ enabled: checked })}
                aria-label={gt("Enable Matter Island")}
              />
            }
          />

          {settings.enabled ? (
            <>
              <SettingsRow
                title={gt("Global shortcut")}
                description={gt(
                  "Opens the island over any app without switching Spaces. Hold the key while it is open to dictate.",
                )}
                control={
                  <Select
                    value={settings.shortcut}
                    onValueChange={(value) => {
                      if (value) updateIslandSettings({ shortcut: value as IslandShortcutMode });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={gt("Island global shortcut")}>
                      <SelectValue>{messages(activeShortcut.label)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {SHORTCUT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <span className="flex flex-col">
                            <span>{messages(option.label)}</span>
                            <span className="text-xs text-muted-foreground">
                              {messages(option.hint)}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />

              <SettingsRow
                title={gt("Agent status at the notch")}
                description={gt(
                  "Show who is working beside the notch, and peek for a moment when an agent needs you.",
                )}
                control={
                  <Switch
                    checked={settings.showNotifications}
                    onCheckedChange={(checked) =>
                      updateIslandSettings({ showNotifications: checked })
                    }
                    aria-label={gt("Enable notch notifications")}
                  />
                }
              />

              <SettingsRow
                title={gt("Voice visual")}
                description={gt(
                  "The wave in the notch while you dictate or Voice Mode is listening or speaking.",
                )}
                control={
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => setPreviewListening((prev) => !prev)}
                    >
                      {previewListening ? <T>Idle</T> : <T>Preview active</T>}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => void islandBridge.openPanel({ startVoice: false })}
                    >
                      <T>Open Island</T>
                    </Button>
                  </div>
                }
              >
                <div className="mt-3 flex h-24 items-center justify-center rounded-xl border border-border/70 bg-popover">
                  <SiriWaveVisual
                    state={previewListening ? "listening" : "idle"}
                    level={previewListening ? 0.65 : 0.15}
                    width={180}
                    height={72}
                  />
                </div>
              </SettingsRow>
            </>
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection id="matter-voice-assistant" title={gt("Voice Assistant & Voice Mode")}>
        <SettingsRow
          title={gt("Hands-Free Voice Mode")}
          description={gt(
            "Continuous conversational co-pilot with automatic turn-taking, barge-in, and spoken workspace updates.",
          )}
          control={
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setVoiceModeOpen(true)}
            >
              <RadioIcon className="size-3.5" />
              <T>Open Voice Mode</T>
            </Button>
          }
        />

        <SettingsRow
          title={gt("Default voice routing")}
          description={gt(
            "Choose whether voice input routes smartly across chats & Matter Assistant, always asks Matter, or dictates directly.",
          )}
          control={
            <Select
              value={va.defaultMode}
              onValueChange={(value) => {
                if (value === "smart" || value === "assistant" || value === "dictation") {
                  updateVoiceAssistantSettings({ defaultMode: value });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Default voice routing")}>
                <SelectValue>{messages(activeDefaultMode.label)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {DEFAULT_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex flex-col">
                      <span>{messages(option.label)}</span>
                      <span className="text-xs text-muted-foreground">{messages(option.hint)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title={gt("Spoken voice (TTS)")}
          description={gt(
            "Engine used for assistant replies and spoken thread briefings, on this device and the Matter iPhone app. Auto uses ElevenLabs if configured, then Deepgram Aura-2, OpenAI TTS, then macOS voice.",
          )}
          control={
            <Select
              value={va.ttsProvider}
              onValueChange={(value) => {
                if (value) {
                  updateTtsSettings({ ttsProvider: value as VoiceTtsProvider });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Spoken voice provider")}>
                <SelectValue>{messages(activeTtsProvider.label)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {TTS_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {messages(option.label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <div className="mt-3 flex items-center gap-2">{testVoiceButton}</div>
          {credentialFeedbackLine}
        </SettingsRow>

        {showElevenLabsPickers ? (
          <>
            <SettingsRow
              title={gt("ElevenLabs model")}
              description={gt("Eleven v4 Turbo balances latency, cost, and natural prosody.")}
              control={
                <Select
                  value={activeElevenLabsModel.value}
                  onValueChange={(value) => {
                    const option = ELEVENLABS_MODEL_OPTIONS.find((item) => item.value === value);
                    if (option) updateTtsSettings({ elevenlabsModel: option.value });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={gt("ElevenLabs model")}>
                    <SelectValue>{messages(activeElevenLabsModel.label)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {ELEVENLABS_MODEL_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {messages(option.label)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title={gt("ElevenLabs voice")}
              description={gt(
                "Pick a conversational voice or paste a custom voice ID from your library to override it.",
              )}
              control={
                <Select
                  value={va.elevenlabsVoice}
                  onValueChange={(value) => {
                    if (value) {
                      updateTtsSettings({ elevenlabsVoice: value, elevenlabsCustomVoiceId: "" });
                    }
                  }}
                >
                  <SelectTrigger size="sm" aria-label={gt("ElevenLabs voice")}>
                    <SelectValue>
                      {va.elevenlabsCustomVoiceId
                        ? gt("Custom voice ({voiceId})", { voiceId: va.elevenlabsCustomVoiceId })
                        : matchedElevenLabsVoice
                          ? messages(matchedElevenLabsVoice.label)
                          : gt("Custom voice ({voiceId})", { voiceId: va.elevenlabsVoice })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {matchedElevenLabsVoice ? null : (
                      <SelectItem value={va.elevenlabsVoice}>
                        {gt("Custom voice ({voiceId})", { voiceId: va.elevenlabsVoice })}
                      </SelectItem>
                    )}
                    {ELEVENLABS_VOICE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {messages(option.label)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            >
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  size="sm"
                  className="max-w-xs flex-1"
                  value={customVoiceInput}
                  onChange={(event) => setCustomVoiceInput(event.target.value)}
                  placeholder={
                    va.elevenlabsCustomVoiceId
                      ? gt("Active custom ID: {voiceId}", { voiceId: va.elevenlabsCustomVoiceId })
                      : gt("Custom voice ID (overrides preset)")
                  }
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={gt("Custom ElevenLabs voice ID")}
                />
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={customVoiceInput.trim().length === 0}
                  onClick={handleUseCustomVoice}
                >
                  <T>Use voice</T>
                </Button>
                {va.elevenlabsCustomVoiceId ? (
                  <Button type="button" size="xs" variant="ghost" onClick={handleClearCustomVoice}>
                    <T>Clear</T>
                  </Button>
                ) : null}
              </div>
            </SettingsRow>

            <SettingsRow
              title={gt("Voice stability")}
              description={gt("Lower values sound more expressive; higher values sound steadier.")}
              resetAction={
                va.elevenlabsStability !== DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability ? (
                  <SettingResetButton
                    ariaLabel={gt("Reset voice stability to default")}
                    onClick={() =>
                      updateTtsSettings({
                        elevenlabsStability: DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="elevenlabs-stability"
                  >
                    {va.elevenlabsStability.toFixed(2)}
                  </output>
                  <input
                    id="elevenlabs-stability"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={va.elevenlabsStability}
                    style={sliderStyle(va.elevenlabsStability, 0, 1)}
                    className="settings-slider min-w-0 flex-1"
                    aria-label={gt("ElevenLabs voice stability")}
                    onChange={(event) =>
                      updateTtsSettings({ elevenlabsStability: Number(event.currentTarget.value) })
                    }
                  />
                </div>
              }
            />

            <SettingsRow
              title={gt("Similarity boost")}
              description={gt("Controls how closely the output matches the original voice.")}
              resetAction={
                va.elevenlabsSimilarityBoost !==
                DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost ? (
                  <SettingResetButton
                    ariaLabel={gt("Reset similarity boost to default")}
                    onClick={() =>
                      updateTtsSettings({
                        elevenlabsSimilarityBoost:
                          DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarityBoost,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="elevenlabs-similarity"
                  >
                    {va.elevenlabsSimilarityBoost.toFixed(2)}
                  </output>
                  <input
                    id="elevenlabs-similarity"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={va.elevenlabsSimilarityBoost}
                    style={sliderStyle(va.elevenlabsSimilarityBoost, 0, 1)}
                    className="settings-slider min-w-0 flex-1"
                    aria-label={gt("ElevenLabs similarity boost")}
                    onChange={(event) =>
                      updateTtsSettings({
                        elevenlabsSimilarityBoost: Number(event.currentTarget.value),
                      })
                    }
                  />
                </div>
              }
            />

            <SettingsRow
              title={gt("Style & emotion")}
              description={gt("Amplifies vocal expressiveness and cadence.")}
              resetAction={
                va.elevenlabsStyle !== DEFAULT_ELEVENLABS_VOICE_SETTINGS.style ? (
                  <SettingResetButton
                    ariaLabel={gt("Reset voice style to default")}
                    onClick={() =>
                      updateTtsSettings({
                        elevenlabsStyle: DEFAULT_ELEVENLABS_VOICE_SETTINGS.style,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="elevenlabs-style"
                  >
                    {va.elevenlabsStyle.toFixed(2)}
                  </output>
                  <input
                    id="elevenlabs-style"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={va.elevenlabsStyle}
                    style={sliderStyle(va.elevenlabsStyle, 0, 1)}
                    className="settings-slider min-w-0 flex-1"
                    aria-label={gt("ElevenLabs style and emotion")}
                    onChange={(event) =>
                      updateTtsSettings({ elevenlabsStyle: Number(event.currentTarget.value) })
                    }
                  />
                </div>
              }
            />

            <SettingsRow
              title={gt("Voice speed")}
              description={gt("Adjust speaking pace for ElevenLabs on Mac and iPhone.")}
              resetAction={
                va.elevenlabsSpeed !== DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed ? (
                  <SettingResetButton
                    ariaLabel={gt("Reset voice speed to default")}
                    onClick={() =>
                      updateTtsSettings({
                        elevenlabsSpeed: DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="elevenlabs-speed"
                  >
                    {`${va.elevenlabsSpeed.toFixed(2)}×`}
                  </output>
                  <input
                    id="elevenlabs-speed"
                    type="range"
                    min={0.7}
                    max={1.2}
                    step={0.05}
                    value={va.elevenlabsSpeed}
                    style={sliderStyle(va.elevenlabsSpeed, 0.7, 1.2)}
                    className="settings-slider min-w-0 flex-1"
                    aria-label={gt("ElevenLabs voice speed")}
                    onChange={(event) =>
                      updateTtsSettings({ elevenlabsSpeed: Number(event.currentTarget.value) })
                    }
                  />
                </div>
              }
            />

            <SettingsRow
              title={gt("Speaker boost")}
              description={gt("Enhances vocal clarity and presence over speakers or headphones.")}
              control={
                <Switch
                  checked={va.elevenlabsUseSpeakerBoost}
                  onCheckedChange={(checked) =>
                    updateTtsSettings({ elevenlabsUseSpeakerBoost: checked })
                  }
                  aria-label={gt("ElevenLabs speaker boost")}
                />
              }
            />
          </>
        ) : null}

        {showVoicePicker ? (
          <SettingsRow
            title={gt("Voice")}
            description={
              va.ttsProvider === "openai"
                ? gt("Choose the OpenAI voice used for spoken replies.")
                : gt("Choose the Deepgram Aura-2 voice used for spoken replies.")
            }
            control={
              <Select
                value={selectedVoiceValue}
                onValueChange={(value) => {
                  if (value === DEFAULT_VOICE_SENTINEL) {
                    updateTtsSettings({ ttsVoice: "" });
                  } else if (value) {
                    updateTtsSettings({ ttsVoice: value });
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Spoken voice")}>
                  <SelectValue>{messages(selectedVoiceLabel)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={DEFAULT_VOICE_SENTINEL}>
                    {messages(defaultVoiceLabel)}
                  </SelectItem>
                  {voiceOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {messages(option.label)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}

        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <span>{gt("ElevenLabs API key")}</span>
              <CredentialStatusBadge configured={elevenlabsAvailable} />
            </span>
          }
          description={gt(
            "Powers ElevenLabs voices for spoken replies on desktop and mobile. Stored locally with owner-only permissions.",
          )}
        >
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              type="password"
              size="sm"
              className="max-w-xs flex-1"
              value={elevenlabsKeyInput}
              onChange={(event) => setElevenlabsKeyInput(event.target.value)}
              placeholder={
                elevenlabsAvailable
                  ? gt("Enter new key to replace saved key")
                  : gt("Paste ElevenLabs API key")
              }
              autoComplete="off"
              aria-label={gt("ElevenLabs API key")}
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={savingKey !== null || elevenlabsKeyInput.trim().length === 0}
              onClick={() => void handleSaveKey("elevenlabs", elevenlabsKeyInput)}
            >
              {savingKey === "elevenlabs" ? <T>Saving...</T> : <T>Save</T>}
            </Button>
            {elevenlabsAvailable ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={savingKey !== null}
                onClick={() => void handleSaveKey("elevenlabs", "")}
              >
                <T>Clear</T>
              </Button>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            <T>
              Speech-to-text stays on Deepgram Flux and Nova-3 to save your ElevenLabs credits for
              voice output.
            </T>
          </p>
        </SettingsRow>

        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <span>{gt("Deepgram API key")}</span>
              <CredentialStatusBadge configured={deepgramAvailable} />
            </span>
          }
          description={gt(
            "Powers low-latency Deepgram Aura-2 voices and Nova-3 speech recognition on desktop and mobile. Stored locally with owner-only permissions.",
          )}
        >
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              type="password"
              size="sm"
              className="max-w-xs flex-1"
              value={deepgramKeyInput}
              onChange={(event) => setDeepgramKeyInput(event.target.value)}
              placeholder={
                deepgramAvailable
                  ? gt("Enter new key to replace saved key")
                  : gt("Paste Deepgram API key")
              }
              autoComplete="off"
              aria-label={gt("Deepgram API key")}
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={savingKey !== null || deepgramKeyInput.trim().length === 0}
              onClick={() => void handleSaveKey("deepgram", deepgramKeyInput)}
            >
              {savingKey === "deepgram" ? <T>Saving...</T> : <T>Save</T>}
            </Button>
            {deepgramAvailable ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={savingKey !== null}
                onClick={() => void handleSaveKey("deepgram", "")}
              >
                <T>Clear</T>
              </Button>
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          title={gt("Voice & dictation sound cues")}
          description={gt(
            "Play Lilt-style audio cues when starting or stopping dictation and opening or closing Voice Mode.",
          )}
          control={
            <Switch
              checked={va.soundCuesEnabled}
              onCheckedChange={(checked) =>
                updateVoiceAssistantSettings({ soundCuesEnabled: checked })
              }
              aria-label={gt("Voice and dictation sound cues")}
            />
          }
        />

        {va.soundCuesEnabled ? (
          <SettingsRow
            title={gt("Voice Mode thinking pulse")}
            description={gt(
              "Play a single subtle muted pulse when your turn finishes and Matter starts thinking.",
            )}
            control={
              <Switch
                checked={va.thinkingCueEnabled}
                onCheckedChange={(checked) =>
                  updateVoiceAssistantSettings({ thinkingCueEnabled: checked })
                }
                aria-label={gt("Voice Mode thinking pulse")}
              />
            }
          />
        ) : null}

        <SettingsRow
          title={gt("Speak assistant replies")}
          description={gt("Automatically speak Matter Assistant replies aloud.")}
          control={
            <Switch
              checked={va.speakReplies}
              onCheckedChange={(checked) => updateVoiceAssistantSettings({ speakReplies: checked })}
              aria-label={gt("Speak assistant replies")}
            />
          }
        />

        <SettingsRow
          title={gt("Interrupt on speech (barge-in)")}
          description={gt(
            "Immediately stop Matter from speaking when you start talking in Voice Mode.",
          )}
          control={
            <Switch
              checked={va.bargeInEnabled}
              onCheckedChange={(checked) =>
                updateVoiceAssistantSettings({ bargeInEnabled: checked })
              }
              aria-label={gt("Interrupt on speech")}
            />
          }
        />

        <SettingsRow
          title={gt("Proactive spoken briefings")}
          description={gt(
            "In Voice Mode, speak concise updates when threads finish, hit errors, ask questions, or need tool approval.",
          )}
          control={
            <Switch
              checked={va.proactiveBriefings}
              onCheckedChange={(checked) =>
                updateVoiceAssistantSettings({ proactiveBriefings: checked })
              }
              aria-label={gt("Proactive spoken briefings")}
            />
          }
        />

        {va.proactiveBriefings ? (
          <>
            <SettingsRow
              title={gt("Announce approvals & questions")}
              description={gt(
                "Read pending tool approvals and agent questions aloud so you can answer hands-free.",
              )}
              control={
                <Switch
                  checked={va.announceApprovals && va.announceQuestions}
                  onCheckedChange={(checked) =>
                    updateVoiceAssistantSettings({
                      announceApprovals: checked,
                      announceQuestions: checked,
                    })
                  }
                  aria-label={gt("Announce approvals and questions")}
                />
              }
            />
            <SettingsRow
              title={gt("Announce thread completions & errors")}
              description={gt(
                "Summarize completed or failed threads in 1 to 2 spoken sentences without reading raw code.",
              )}
              control={
                <Switch
                  checked={va.announceCompletions && va.announceFailures}
                  onCheckedChange={(checked) =>
                    updateVoiceAssistantSettings({
                      announceCompletions: checked,
                      announceFailures: checked,
                    })
                  }
                  aria-label={gt("Announce completions and errors")}
                />
              }
            />
          </>
        ) : null}
      </SettingsSection>
    </>
  );
}
