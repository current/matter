import { msg, T, useGT, useMessages } from "gt-react";
import { RadioIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { SiriWaveVisual } from "./SiriWave";
import {
  updateIslandSettings,
  updateVoiceAssistantSettings,
  useIslandSettings,
} from "./islandSettingsStore";
import { setVoiceAssistantModalOpen } from "./voiceAssistantStore";
import type { IslandShortcutMode } from "../../../../antimatter/island/types";
import type { VoiceTtsProvider } from "../../../../antimatter/voice-assistant/types";

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
  { value: "auto", label: msg("Auto (OpenAI → macOS → Browser)") },
  { value: "openai", label: msg("OpenAI TTS") },
  { value: "macos", label: msg("macOS native voice") },
  { value: "browser", label: msg("Browser speech synthesis") },
  { value: "off", label: msg("Off (visual only)") },
];

export function IslandSettingsSection() {
  const gt = useGT();
  const messages = useMessages();
  const islandBridge = window.desktopBridge?.island;
  const settings = useIslandSettings();
  const va = settings.voiceAssistant;
  const [previewListening, setPreviewListening] = useState(false);

  const activeShortcut =
    SHORTCUT_OPTIONS.find((item) => item.value === settings.shortcut) ?? SHORTCUT_OPTIONS[0]!;
  const activeDefaultMode =
    DEFAULT_MODE_OPTIONS.find((item) => item.value === va.defaultMode) ?? DEFAULT_MODE_OPTIONS[0]!;
  const activeTtsProvider =
    TTS_PROVIDER_OPTIONS.find((item) => item.value === va.ttsProvider) ?? TTS_PROVIDER_OPTIONS[0]!;

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
            "Engine used for assistant replies and spoken thread briefings. Auto uses OpenAI TTS if configured, then macOS voice.",
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
                "Summarize completed or failed threads in 1–2 spoken sentences without reading raw code.",
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
