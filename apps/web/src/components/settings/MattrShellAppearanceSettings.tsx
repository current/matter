import { msg, useGT, useMessages } from "gt-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SHELL_BLUR,
  MAX_SHELL_GRAIN,
  MAX_SHELL_TRANSPARENCY,
  MIN_SHELL_BLUR,
  MIN_SHELL_GRAIN,
  MIN_SHELL_TRANSPARENCY,
  type ShellGlassStyle,
  type ShellMaterial,
} from "@t3tools/contracts/settings";
import { SHELL_COLOR_PRESETS } from "../../../../../antimatter/shellTint";
import { isElectron } from "../../env";
import { isMacPlatform } from "../../lib/utils";
import { MattrSidebarLayoutSetting } from "../sidebar/mattr/MattrSidebarLayoutSetting";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { DEFAULT_MATTR_GOOEY_SEND, useMattrGooeySendSetting } from "../../mattrGooeySend";
import {
  DEFAULT_MATTR_THREAD_RIBBON,
  useMattrThreadRibbonSetting,
} from "../chat/mattrThreadRibbon.logic";
import { MattrAiStatusSetting } from "./MattrAiStatusSetting";
import {
  AppearanceSlider,
  ColorSwatch,
  CustomColorSwatch,
  SHELL_COLOR_LABELS,
} from "./MattrAppearanceControls";
import { MattrComposerAppearanceSettings } from "./MattrComposerAppearanceSettings";
import { MattrIconPackSetting } from "./MattrIconPackSetting";
import { MattrStreamAnimationSetting } from "./MattrStreamAnimationSetting";
import { MattrUiFontSetting } from "./MattrUiFontSetting";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SHELL_MATERIAL_LABELS: Record<ShellMaterial, string> = {
  solid: msg("Solid", { $context: "window shell material" }),
  transparent: msg("Transparent", { $context: "window shell material" }),
  blur: msg("Blur", { $context: "window shell material" }),
  "liquid-glass": msg("Liquid Glass", { $context: "window shell material" }),
};

const SHELL_GLASS_STYLE_LABELS: Record<ShellGlassStyle, string> = {
  regular: msg("Regular", { $context: "Liquid Glass style" }),
  clear: msg("Clear", { $context: "Liquid Glass style" }),
};

function isShellMaterial(value: unknown): value is ShellMaterial {
  return (
    value === "solid" || value === "transparent" || value === "blur" || value === "liquid-glass"
  );
}

function isShellGlassStyle(value: unknown): value is ShellGlassStyle {
  return value === "regular" || value === "clear";
}

export function MattrShellAppearanceSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [gooeySend, setGooeySend] = useMattrGooeySendSetting();
  const [threadRibbon, setThreadRibbon] = useMattrThreadRibbonSetting();
  const material = settings.shellMaterial;
  // Blur amount and glass style drive macOS-only native calls; Windows maps materials to
  // acrylic and mica, which have no such knobs.
  const isMacDesktop = isElectron && isMacPlatform(navigator.platform);
  const shellColor = settings.shellColor;
  const isCustomColor =
    shellColor !== null && !SHELL_COLOR_PRESETS.some((preset) => preset.color === shellColor);

  return (
    <>
      {isElectron ? (
        <SettingsRow
          {...searchableSetting("shell-material")}
          description={gt("Choose how the outer window frame and sidebar blend with your desktop.")}
          resetAction={
            material !== DEFAULT_UNIFIED_SETTINGS.shellMaterial ? (
              <SettingResetButton
                ariaLabel={gt("Reset shell material to default")}
                onClick={() =>
                  updateSettings({ shellMaterial: DEFAULT_UNIFIED_SETTINGS.shellMaterial })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={material}
                onValueChange={(value) => {
                  if (isShellMaterial(value)) {
                    updateSettings({ shellMaterial: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full min-w-0"
                  aria-label={gt("Shell material")}
                >
                  <SelectValue>{m(SHELL_MATERIAL_LABELS[material])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="solid">{gt("Solid (default)")}</SelectItem>
                  <SelectItem value="transparent">
                    {m(SHELL_MATERIAL_LABELS.transparent)}
                  </SelectItem>
                  <SelectItem value="blur">{m(SHELL_MATERIAL_LABELS.blur)}</SelectItem>
                  <SelectItem value="liquid-glass">
                    {m(SHELL_MATERIAL_LABELS["liquid-glass"])}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
      ) : null}

      {isElectron && material !== "solid" ? (
        <SettingsRow
          {...searchableSetting("setting-shell-transparency")}
          description={gt("How much of your desktop shows through the frame and sidebar.")}
          resetAction={
            settings.shellTransparency !== DEFAULT_UNIFIED_SETTINGS.shellTransparency ? (
              <SettingResetButton
                ariaLabel={gt("Reset shell transparency to default")}
                onClick={() =>
                  updateSettings({
                    shellTransparency: DEFAULT_UNIFIED_SETTINGS.shellTransparency,
                  })
                }
              />
            ) : null
          }
          control={
            <AppearanceSlider
              id="shell-transparency"
              label={gt("Shell transparency")}
              value={settings.shellTransparency}
              min={MIN_SHELL_TRANSPARENCY}
              max={MAX_SHELL_TRANSPARENCY}
              display={`${settings.shellTransparency}%`}
              onChange={(shellTransparency) => updateSettings({ shellTransparency })}
            />
          }
        />
      ) : null}

      {isMacDesktop && material === "blur" ? (
        <SettingsRow
          {...searchableSetting("setting-shell-blur")}
          description={gt("How strongly the desktop behind the frame is blurred.")}
          resetAction={
            settings.shellBlur !== DEFAULT_UNIFIED_SETTINGS.shellBlur ? (
              <SettingResetButton
                ariaLabel={gt("Reset blur amount to default")}
                onClick={() => updateSettings({ shellBlur: DEFAULT_UNIFIED_SETTINGS.shellBlur })}
              />
            ) : null
          }
          control={
            <AppearanceSlider
              id="shell-blur"
              label={gt("Blur amount")}
              value={settings.shellBlur}
              min={MIN_SHELL_BLUR}
              max={MAX_SHELL_BLUR}
              display={settings.shellBlur === 0 ? gt("Off") : `${settings.shellBlur}%`}
              onChange={(shellBlur) => updateSettings({ shellBlur })}
            />
          }
        />
      ) : null}

      {isMacDesktop && material === "liquid-glass" ? (
        <SettingsRow
          {...searchableSetting("shell-glass-style")}
          description={gt("Regular glass frosts what's behind it; Clear keeps it sharp.")}
          resetAction={
            settings.shellGlassStyle !== DEFAULT_UNIFIED_SETTINGS.shellGlassStyle ? (
              <SettingResetButton
                ariaLabel={gt("Reset glass style to default")}
                onClick={() =>
                  updateSettings({ shellGlassStyle: DEFAULT_UNIFIED_SETTINGS.shellGlassStyle })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.shellGlassStyle}
                onValueChange={(value) => {
                  if (isShellGlassStyle(value)) {
                    updateSettings({ shellGlassStyle: value });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label={gt("Glass style")}>
                  <SelectValue>{m(SHELL_GLASS_STYLE_LABELS[settings.shellGlassStyle])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="regular">{m(SHELL_GLASS_STYLE_LABELS.regular)}</SelectItem>
                  <SelectItem value="clear">{m(SHELL_GLASS_STYLE_LABELS.clear)}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
      ) : null}

      <SettingsRow
        {...searchableSetting("shell-color")}
        description={gt(
          "Tint the window frame and sidebar. Colors adapt to light and dark so text stays readable.",
        )}
        resetAction={
          shellColor !== null ? (
            <SettingResetButton
              ariaLabel={gt("Reset shell color to default")}
              onClick={() => updateSettings({ shellColor: null })}
            />
          ) : null
        }
        control={
          <div
            role="group"
            aria-label={gt("Shell color")}
            className="flex flex-wrap items-center gap-2 py-0.5"
          >
            <ColorSwatch
              label={gt("Default")}
              color={null}
              selected={shellColor === null}
              className="bg-sidebar"
              onSelect={() => updateSettings({ shellColor: null })}
            />
            {SHELL_COLOR_PRESETS.map((preset) => (
              <ColorSwatch
                key={preset.id}
                label={m(SHELL_COLOR_LABELS[preset.id] ?? preset.id)}
                color={preset.color}
                selected={shellColor === preset.color}
                style={{ backgroundColor: preset.color }}
                onSelect={() => updateSettings({ shellColor: preset.color })}
              />
            ))}
            <CustomColorSwatch
              value={shellColor}
              selected={isCustomColor}
              onChange={(next) => updateSettings({ shellColor: next })}
            />
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("setting-shell-grain")}
        description={gt("Add a tactile film grain texture to the outer window shell and sidebar.")}
        resetAction={
          settings.shellGrain !== DEFAULT_UNIFIED_SETTINGS.shellGrain ? (
            <SettingResetButton
              ariaLabel={gt("Reset shell grain to default")}
              onClick={() => updateSettings({ shellGrain: DEFAULT_UNIFIED_SETTINGS.shellGrain })}
            />
          ) : null
        }
        control={
          <AppearanceSlider
            id="shell-grain"
            label={gt("Shell grain")}
            value={settings.shellGrain}
            min={MIN_SHELL_GRAIN}
            max={MAX_SHELL_GRAIN}
            display={settings.shellGrain === 0 ? gt("Off") : `${settings.shellGrain}%`}
            onChange={(shellGrain) => updateSettings({ shellGrain })}
          />
        }
      />

      <MattrSidebarLayoutSetting />
      <MattrUiFontSetting />
      <MattrIconPackSetting />
      <MattrAiStatusSetting />
      <MattrStreamAnimationSetting />
      <MattrComposerAppearanceSettings />
      <SettingsRow
        id="mattr-gooey-send"
        title={gt("Gooey send button")}
        description={gt(
          "Right-click the send button to pop out Dictate and Voice Mode. Turn off to show both buttons inline.",
        )}
        devicePreference
        resetAction={
          gooeySend !== DEFAULT_MATTR_GOOEY_SEND ? (
            <SettingResetButton
              ariaLabel={gt("Reset gooey send button to default")}
              onClick={() => setGooeySend(DEFAULT_MATTR_GOOEY_SEND)}
            />
          ) : null
        }
        control={
          <Switch
            checked={gooeySend}
            onCheckedChange={(checked) => setGooeySend(Boolean(checked))}
            aria-label={gt("Gooey send button")}
          />
        }
      />
      <SettingsRow
        id="mattr-thread-ribbon"
        title={gt("Thread ribbon")}
        description={gt(
          "Show thread actions in the top bar and running agents above the composer. Turn off for the classic details card.",
        )}
        devicePreference
        resetAction={
          threadRibbon !== DEFAULT_MATTR_THREAD_RIBBON ? (
            <SettingResetButton
              ariaLabel={gt("Reset thread ribbon to default")}
              onClick={() => setThreadRibbon(DEFAULT_MATTR_THREAD_RIBBON)}
            />
          ) : null
        }
        control={
          <Switch
            checked={threadRibbon}
            onCheckedChange={(checked) => setThreadRibbon(Boolean(checked))}
            aria-label={gt("Thread ribbon")}
          />
        }
      />
    </>
  );
}
