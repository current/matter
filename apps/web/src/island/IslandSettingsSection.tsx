import { msg, T, useGT, useMessages } from "gt-react";
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
import { updateIslandSettings, useIslandSettings } from "./islandSettingsStore";
import type { IslandShortcutMode } from "../../../../antimatter/island/types";

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

export function IslandSettingsSection() {
  const gt = useGT();
  const messages = useMessages();
  const islandBridge = window.desktopBridge?.island;
  const settings = useIslandSettings();
  const [previewListening, setPreviewListening] = useState(false);

  if (!islandBridge) return null;

  const activeShortcut =
    SHORTCUT_OPTIONS.find((item) => item.value === settings.shortcut) ?? SHORTCUT_OPTIONS[0]!;

  return (
    <SettingsSection id="mattr-island" title={gt("mattr Island")}>
      <SettingsRow
        title={gt("Floating Island")}
        description={gt(
          "Show a pill at the notch when a thread finishes or needs you, and reply by voice from any app.",
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
              "Opens the floating session panel over any app. Tap again while open to dictate.",
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
                onCheckedChange={(checked) => updateIslandSettings({ showNotifications: checked })}
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
              "Lilt Siri Wave (GLSL): animates live with your voice and switches to fluid dots while transcribing.",
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
  );
}
