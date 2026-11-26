import type { CSSProperties } from "react";
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
import { CheckIcon } from "lucide-react";
import {
  normalizeShellColor,
  relativeLuminance,
  SHELL_COLOR_PRESETS,
} from "../../../../../antimatter/shellTint";
import { isElectron } from "../../env";
import { cn, isMacPlatform } from "../../lib/utils";
import { MattrSidebarLayoutSetting } from "../sidebar/mattr/MattrSidebarLayoutSetting";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DEFAULT_MATTR_GOOEY_SEND, useMattrGooeySendSetting } from "../../mattrGooeySend";
import { MattrAiStatusSetting } from "./MattrAiStatusSetting";
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

const SHELL_COLOR_LABELS: Record<string, string> = {
  graphite: msg("Graphite", { $context: "window shell color" }),
  "ocean-slate": msg("Ocean Slate", { $context: "window shell color" }),
  "deep-indigo": msg("Deep Indigo", { $context: "window shell color" }),
  "sage-moss": msg("Sage Moss", { $context: "window shell color" }),
  "warm-terracotta": msg("Warm Terracotta", { $context: "window shell color" }),
  "dusk-plum": msg("Dusk Plum", { $context: "window shell color" }),
  "rose-clay": msg("Rose Clay", { $context: "window shell color" }),
  "obsidian-amber": msg("Obsidian Amber", { $context: "window shell color" }),
};

function isShellMaterial(value: unknown): value is ShellMaterial {
  return (
    value === "solid" || value === "transparent" || value === "blur" || value === "liquid-glass"
  );
}

function isShellGlassStyle(value: unknown): value is ShellGlassStyle {
  return value === "regular" || value === "clear";
}

const SWATCH_CLASS =
  "relative grid size-6 shrink-0 cursor-pointer place-items-center rounded-full ring-1 ring-inset ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring data-selected:ring-2 data-selected:ring-foreground";

const CUSTOM_SWATCH_BACKGROUND =
  "conic-gradient(from 90deg, #c0673f, #b5852b, #6b8f5e, #3f6e8c, #4b4fa8, #7d4e85, #b86a74, #c0673f)";

function SwatchCheck({ color }: { color: string | null }) {
  // Dark check on light seeds, light check on dark ones; the theme's own frame uses foreground.
  const tone =
    color === null
      ? "text-foreground"
      : relativeLuminance(color) > 0.35
        ? "text-black/80"
        : "text-white";
  return <CheckIcon aria-hidden className={cn("size-3.5 stroke-3", tone)} />;
}

function ShellSwatch({
  label,
  color,
  selected,
  className,
  style,
  onSelect,
}: {
  label: string;
  color: string | null;
  selected: boolean;
  className?: string;
  style?: CSSProperties;
  onSelect: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={selected}
            aria-label={label}
            data-selected={selected ? "" : undefined}
            className={cn(SWATCH_CLASS, className)}
            style={style}
            onClick={onSelect}
          >
            {selected ? <SwatchCheck color={color} /> : null}
          </button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function ShellSlider({
  id,
  label,
  value,
  min,
  max,
  display,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  display: string;
  onChange: (value: number) => void;
}) {
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <div className="flex w-full items-center gap-3 sm:w-52">
      <output
        className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={id}
      >
        {display}
      </output>
      <input
        aria-label={label}
        className="settings-slider min-w-0 flex-1"
        id={id}
        max={max}
        min={min}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
        step={5}
        style={style}
        type="range"
        value={value}
      />
    </div>
  );
}

export function MattrShellAppearanceSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [gooeySend, setGooeySend] = useMattrGooeySendSetting();
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
            <ShellSlider
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
            <ShellSlider
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
            <ShellSwatch
              label={gt("Default")}
              color={null}
              selected={shellColor === null}
              className="bg-sidebar"
              onSelect={() => updateSettings({ shellColor: null })}
            />
            {SHELL_COLOR_PRESETS.map((preset) => (
              <ShellSwatch
                key={preset.id}
                label={m(SHELL_COLOR_LABELS[preset.id] ?? preset.id)}
                color={preset.color}
                selected={shellColor === preset.color}
                style={{ backgroundColor: preset.color }}
                onSelect={() => updateSettings({ shellColor: preset.color })}
              />
            ))}
            <Tooltip>
              <TooltipTrigger
                render={
                  <label
                    data-selected={isCustomColor ? "" : undefined}
                    className={cn(
                      SWATCH_CLASS,
                      "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-inset",
                    )}
                    style={{ background: isCustomColor ? shellColor : CUSTOM_SWATCH_BACKGROUND }}
                  >
                    {isCustomColor ? <SwatchCheck color={shellColor} /> : null}
                    <input
                      type="color"
                      aria-label={
                        isCustomColor ? gt("Custom color (selected)") : gt("Custom color")
                      }
                      className="absolute inset-0 size-full cursor-pointer rounded-full opacity-0"
                      value={shellColor ?? "#5b6068"}
                      onChange={(event) => {
                        const next = normalizeShellColor(event.currentTarget.value);
                        if (next !== null && next !== shellColor) {
                          updateSettings({ shellColor: next });
                        }
                      }}
                    />
                  </label>
                }
              />
              <TooltipPopup>{gt("Custom color")}</TooltipPopup>
            </Tooltip>
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
          <ShellSlider
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
    </>
  );
}
