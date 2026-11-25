import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { msg, T, useGT, useMessages } from "gt-react";
import { RadioIcon, Volume2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentSummaries } from "../state/presentation";
import { usePreparedConnection } from "../state/session";
import { SiriWaveVisual } from "./SiriWave";
import {
  updateIslandSettings,
  updateVoiceAssistantSettings,
  useIslandSettings,
} from "./islandSettingsStore";
import { setVoiceAssistantModalOpen } from "./voiceAssistantStore";
import type { IslandShortcutMode } from "../../../../antimatter/island/types";
import type {
  VoiceAvailableTtsInfo,
  VoiceCredentialsStatus,
  VoiceTtsProvider,
} from "../../../../antimatter/voice-assistant/types";

const SHORTCUT_OPTIONS: ReadonlyArray<{
  readonly value: IslandShortcutMode;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "control",
    label: msg("Control tap (⌃)"),
    hint: msg("Tap Control alone from any app"),
  },
  {
    value: "option",
    label: msg("Option tap (⌥)"),
    hint: msg("Tap Option alone from any app"),
  },
  {
    value: "command-shift-space",
    label: msg("⌘⇧Space"),
    hint: msg("Standard global shortcut"),
  },
  {
    value: "off",
    label: msg("Off"),
    hint: msg("Open only from notifications or Settings"),
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
    hint: msg("Routes approvals, thread replies, and mattr Assistant commands automatically"),
  },
  {
    value: "assistant",
    label: msg("mattr Assistant"),
    hint: msg("Always talk to mattr to manage projects, threads, and tools"),
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
  { value: "auto", label: msg("Auto (Deepgram, OpenAI, macOS, Browser)") },
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

const DEFAULT_VOICE_SENTINEL = "__default__";

interface VoiceApiConfig {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials;
}

function buildVoiceApiConfig(
  prepared: {
    readonly httpBaseUrl?: string | null;
    readonly httpAuthorization?:
      | { readonly _tag: "Bearer"; readonly token: string }
      | { readonly _tag: "Dpop"; readonly accessToken: string }
      | null;
  } | null,
): VoiceApiConfig {
  const rawBase = prepared?.httpBaseUrl?.trim();
  const baseUrl =
    rawBase && rawBase.length > 0 ? rawBase.replace(/\/+$/, "") : window.location.origin;
  const headers: Record<string, string> = {};
  if (prepared?.httpAuthorization?._tag === "Bearer") {
    headers.authorization = `Bearer ${prepared.httpAuthorization.token}`;
  } else if (prepared?.httpAuthorization?._tag === "Dpop") {
    headers.authorization = `Bearer ${prepared.httpAuthorization.accessToken}`;
  }
  return { baseUrl, headers, credentials: "include" };
}

async function postDeepgramCredentials(
  api: VoiceApiConfig,
  deepgramApiKey: string,
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
      body: JSON.stringify({ deepgramApiKey }),
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
  payload: {
    readonly text: string;
    readonly provider: VoiceTtsProvider;
    readonly voice?: string;
    readonly speed: number;
  },
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
  const [deepgramKeyInput, setDeepgramKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [testingVoice, setTestingVoice] = useState(false);
  const [credentialFeedback, setCredentialFeedback] = useState<{
    readonly kind: "ok" | "error";
    readonly text: string;
  } | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const testAudioUrlRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads Deepgram credential status from the connected server
  useEffect(() => {
    let disposed = false;
    const api = buildVoiceApiConfig(prepared);
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

  const handleSaveDeepgramKey = async (nextKey: string) => {
    setSavingKey(true);
    setCredentialFeedback(null);
    const result = await postDeepgramCredentials(buildVoiceApiConfig(prepared), nextKey);
    setSavingKey(false);
    if (!result.ok) {
      setCredentialFeedback({
        kind: "error",
        text:
          result.reason === "http"
            ? gt("Could not save Deepgram API key.")
            : gt("Could not reach the mattr server."),
      });
      return;
    }
    setDeepgramAvailable(result.status.deepgramAvailable);
    setDeepgramKeyInput("");
    window.dispatchEvent(new Event("mattr:voice-credentials-changed"));
    setCredentialFeedback({
      kind: "ok",
      text: nextKey.trim()
        ? gt("Deepgram API key saved locally.")
        : result.status.deepgramAvailable
          ? gt("Cleared saved key (using environment variable).")
          : gt("Deepgram API key removed."),
    });
  };

  const handleTestVoice = async () => {
    setTestingVoice(true);
    setCredentialFeedback(null);
    const outcome = await fetchAndPlayVoicePreview(
      buildVoiceApiConfig(prepared),
      {
        text: gt("Hey! Voice Mode is ready whenever you want to talk through your threads."),
        provider: va.ttsProvider === "off" ? "auto" : va.ttsProvider,
        ...(va.ttsVoice ? { voice: va.ttsVoice } : {}),
        speed: va.ttsSpeed,
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

  return (
    <>
      {islandBridge ? (
        <SettingsSection id="mattr-island" title={gt("mattr Island")}>
          <SettingsRow
            title={gt("Floating Island")}
            description={gt(
              "Show a pill at the notch when a thread finishes or needs you, and talk to mattr from any app.",
            )}
            control={
              <Switch
                checked={settings.enabled}
                onCheckedChange={(checked) => updateIslandSettings({ enabled: checked })}
                aria-label={gt("Enable mattr Island")}
              />
            }
          />

          {settings.enabled ? (
            <>
              <SettingsRow
                title={gt("Global shortcut")}
                description={gt(
                  "Opens the floating session panel over any app. Tap again while open to speak.",
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
                title={gt("Notch notifications")}
                description={gt(
                  "Hang a pill from the notch when a thread finishes, asks a question, or needs approval while mattr is in the background.",
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
                title={gt("Show recent messages")}
                description={gt(
                  "Display the thread's latest prompt, tool calls, and reply above the Siri Wave.",
                )}
                control={
                  <Switch
                    checked={settings.showMessages}
                    onCheckedChange={(checked) => updateIslandSettings({ showMessages: checked })}
                    aria-label={gt("Show recent messages in Island")}
                  />
                }
              />

              <SettingsRow
                title={gt("Voice visual")}
                description={gt(
                  "Lilt Siri Wave (GLSL): animates live with your voice and mattr's spoken replies, and morphs into fluid dots while thinking.",
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

      <SettingsSection id="mattr-voice-assistant" title={gt("Voice Assistant & Voice Mode")}>
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
              onClick={() => setVoiceAssistantModalOpen(true)}
            >
              <RadioIcon className="size-3.5" />
              <T>Open Voice Mode</T>
            </Button>
          }
        />

        <SettingsRow
          title={gt("Default voice routing")}
          description={gt(
            "Choose whether voice input routes smartly across chats & mattr Assistant, always asks mattr, or dictates directly.",
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
            "Engine used for assistant replies and spoken thread briefings. Auto uses Deepgram Aura-2 if configured, then OpenAI TTS, then macOS voice.",
          )}
          control={
            <Select
              value={va.ttsProvider}
              onValueChange={(value) => {
                if (value) {
                  updateVoiceAssistantSettings({ ttsProvider: value as VoiceTtsProvider });
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
        />

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
                    updateVoiceAssistantSettings({ ttsVoice: "" });
                  } else if (value) {
                    updateVoiceAssistantSettings({ ttsVoice: value });
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
              <span>{gt("Deepgram API key")}</span>
              {deepgramAvailable ? (
                <span className="inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">
                  <T>Connected</T>
                </span>
              ) : null}
            </span>
          }
          description={gt(
            "Powers low-latency Deepgram Aura-2 voices and Nova-3 speech recognition on desktop and mobile. Stored locally with owner-only permissions.",
          )}
          control={
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
          }
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
              disabled={savingKey || deepgramKeyInput.trim().length === 0}
              onClick={() => void handleSaveDeepgramKey(deepgramKeyInput)}
            >
              {savingKey ? <T>Saving...</T> : <T>Save</T>}
            </Button>
            {deepgramAvailable ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={savingKey}
                onClick={() => void handleSaveDeepgramKey("")}
              >
                <T>Clear</T>
              </Button>
            ) : null}
          </div>
          {credentialFeedback ? (
            <p
              className={`mt-1.5 text-xs ${
                credentialFeedback.kind === "error" ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {credentialFeedback.text}
            </p>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title={gt("Speak assistant replies")}
          description={gt("Automatically speak mattr Assistant replies aloud.")}
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
            "Immediately stop mattr from speaking when you start talking in Voice Mode.",
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
