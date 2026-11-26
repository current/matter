import type { CSSProperties } from "react";
import { msg, useGT, useMessages } from "gt-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SHELL_GRAIN,
  MIN_SHELL_GRAIN,
  type ShellMaterial,
} from "@t3tools/contracts/settings";
import { isElectron } from "../../env";
import { MattrSidebarLayoutSetting } from "../sidebar/mattr/MattrSidebarLayoutSetting";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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

function isShellMaterial(value: unknown): value is ShellMaterial {
  return (
    value === "solid" || value === "transparent" || value === "blur" || value === "liquid-glass"
  );
}

export function MattrShellAppearanceSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  const shellGrainRatio =
    (settings.shellGrain - MIN_SHELL_GRAIN) / (MAX_SHELL_GRAIN - MIN_SHELL_GRAIN);
  const shellGrainSliderStyle = {
    "--settings-slider-progress": `${shellGrainRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - shellGrainRatio}rem`,
  } as CSSProperties;

  return (
    <>
      {isElectron ? (
        <SettingsRow
          {...searchableSetting("shell-material")}
          description={gt("Choose how the outer window frame and sidebar blend with your desktop.")}
          resetAction={
            settings.shellMaterial !== DEFAULT_UNIFIED_SETTINGS.shellMaterial ? (
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
                value={settings.shellMaterial}
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
                  <SelectValue>{m(SHELL_MATERIAL_LABELS[settings.shellMaterial])}</SelectValue>
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
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="shell-grain"
            >
              {settings.shellGrain === 0 ? gt("Off") : `${settings.shellGrain}%`}
            </output>
            <input
              aria-label={gt("Shell grain")}
              className="settings-slider min-w-0 flex-1"
              id="shell-grain"
              max={MAX_SHELL_GRAIN}
              min={MIN_SHELL_GRAIN}
              onChange={(event) => {
                const shellGrain = Number(event.currentTarget.value);
                if (
                  Number.isInteger(shellGrain) &&
                  shellGrain >= MIN_SHELL_GRAIN &&
                  shellGrain <= MAX_SHELL_GRAIN
                ) {
                  updateSettings({ shellGrain });
                }
              }}
              step={5}
              style={shellGrainSliderStyle}
              type="range"
              value={settings.shellGrain}
            />
          </div>
        }
      />

      <MattrSidebarLayoutSetting />
      <MattrUiFontSetting />
    </>
  );
}
