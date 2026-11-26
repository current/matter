import { msg, useGT, useMessages } from "gt-react";
import { ArrowUpIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { SHELL_COLOR_PRESETS } from "../../../../../antimatter/shellTint";
import {
  composerMaterialHasBlurControl,
  composerMaterialIsTranslucent,
  DEFAULT_MATTR_COMPOSER_APPEARANCE,
  MATTR_COMPOSER_MATERIALS,
  MATTR_COMPOSER_SHAPES,
  MAX_COMPOSER_BLUR,
  MAX_COMPOSER_TRANSPARENCY,
  MIN_COMPOSER_BLUR,
  MIN_COMPOSER_TRANSPARENCY,
  type MattrComposerMaterial,
  type MattrComposerShape,
  useMattrComposerAppearance,
} from "../../mattrComposerAppearance";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  AppearanceSlider,
  ColorSwatch,
  CustomColorSwatch,
  SHELL_COLOR_LABELS,
} from "./MattrAppearanceControls";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings } from "./useScopedSettings";

const MATERIAL_LABELS: Record<MattrComposerMaterial, string> = {
  solid: msg("Solid", { $context: "chat composer material" }),
  frosted: msg("Frosted", { $context: "chat composer material" }),
  glass: msg("Glass", { $context: "chat composer material" }),
  tinted: msg("Tinted", { $context: "chat composer material" }),
  minimal: msg("Minimal", { $context: "chat composer material" }),
};

const SHAPE_LABELS: Record<MattrComposerShape, string> = {
  shelf: msg("Shelf", { $context: "chat composer style" }),
  floating: msg("Floating", { $context: "chat composer style" }),
  compact: msg("Compact", { $context: "chat composer style" }),
  pill: msg("Pill", { $context: "chat composer style" }),
};

// A product name and code, so they stay untranslated.
const PREVIEW_MODEL = "Opus 5.5";
const PREVIEW_DIFF = [
  { code: "- queue.clear();", className: "bg-destructive/12 px-3 text-destructive" },
  { code: "+ queue.resume(lastEventId);", className: "bg-success/12 px-3 text-success" },
  { code: '+ emit("reconnected");', className: "bg-info/10 px-3 text-info" },
] as const;

function isMaterial(value: unknown): value is MattrComposerMaterial {
  return MATTR_COMPOSER_MATERIALS.includes(value as MattrComposerMaterial);
}

function isShape(value: unknown): value is MattrComposerShape {
  return MATTR_COMPOSER_SHAPES.includes(value as MattrComposerShape);
}

/**
 * A miniature composer over a few lines of chat, drawn with the real composer's data attributes
 * so composer.css and composer-appearance.css style it exactly like the one in a thread.
 */
function ComposerPreview() {
  const gt = useGT();
  return (
    <div
      aria-hidden
      data-mattr-composer-preview=""
      className="pointer-events-none relative mt-3 h-56 overflow-hidden rounded-xl border border-border/60 bg-background select-none"
    >
      <div className="space-y-2.5 px-6 pt-4 text-sm leading-5 text-foreground/80">
        <p>{gt("Reconnects now keep their queue. The change in the session store:")}</p>
        <div className="overflow-hidden rounded-lg border border-border/60 font-mono text-xs leading-6">
          {PREVIEW_DIFF.map((line) => (
            <div key={line.code} className={line.className}>
              {line.code}
            </div>
          ))}
        </div>
        <p className="text-muted-foreground">{gt("Ran the suite: 214 passed.")}</p>
      </div>
      <div className="absolute inset-x-4 bottom-3 mx-auto max-w-md">
        <div data-mattr-composer="" data-context-row="" className="relative isolate">
          <div
            data-slot="composer-host"
            className="relative z-10 after:pointer-events-none after:absolute after:inset-0 after:z-1 after:rounded-[inherit] after:border"
          >
            <div data-chat-composer-body="" className="text-sm leading-5">
              <span className="text-(--mc-placeholder)">{gt("Ask for follow-up changes")}</span>
            </div>
            <div data-chat-composer-footer="" className="flex items-center">
              <PlusIcon className="size-4 text-(--mc-text)" />
              <span className="ms-auto text-(--mc-text)">{PREVIEW_MODEL}</span>
              <span className="ms-3 grid size-7 place-items-center rounded-full bg-(--mc-send) text-white">
                <ArrowUpIcon className="size-3.5" />
              </span>
            </div>
          </div>
          <div data-slot="composer-context-strip" className="flex items-center">
            <span className="ps-1.5 font-medium text-(--mc-text)">mattr</span>
            <span className="ps-2">{gt("Local")}</span>
            <span className="ms-auto inline-flex items-center gap-1.5 pe-1.5">
              <GitBranchIcon className="size-3" />
              main
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MattrComposerAppearanceSettings() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const shellColor = useScopedSettings().shellColor;
  const [appearance, update] = useMattrComposerAppearance();
  const defaults = DEFAULT_MATTR_COMPOSER_APPEARANCE;
  const { material, color } = appearance;
  const isPresetColor = SHELL_COLOR_PRESETS.some((preset) => preset.color === color);
  const isCustomColor = color !== null && color !== "shell" && !isPresetColor;
  const isDefaultColor = color === defaults.color || (material === "tinted" && color === "shell");

  return (
    <>
      <SettingsRow
        {...searchableSetting("mattr-scroll-fade")}
        description={gt("Soften chat and pages as they scroll under the top edge.")}
        devicePreference
        resetAction={
          appearance.scrollFade !== defaults.scrollFade ? (
            <SettingResetButton
              ariaLabel={gt("Reset scroll edge fade to default")}
              onClick={() => update({ scrollFade: defaults.scrollFade })}
            />
          ) : null
        }
        control={
          <Switch
            checked={appearance.scrollFade}
            onCheckedChange={(checked) => update({ scrollFade: Boolean(checked) })}
            aria-label={gt("Scroll edge fade")}
          />
        }
      />

      <SettingsRow
        {...searchableSetting("mattr-composer-material")}
        description={gt("How the chat composer is painted over the conversation behind it.")}
        devicePreference
        resetAction={
          material !== defaults.material ? (
            <SettingResetButton
              ariaLabel={gt("Reset composer material to default")}
              onClick={() => update({ material: defaults.material })}
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-40">
            <Select
              value={material}
              onValueChange={(value) => {
                if (isMaterial(value)) update({ material: value });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full min-w-0"
                aria-label={gt("Composer material")}
              >
                <SelectValue>{m(MATERIAL_LABELS[material])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="solid">{gt("Solid (default)")}</SelectItem>
                <SelectItem value="frosted">{m(MATERIAL_LABELS.frosted)}</SelectItem>
                <SelectItem value="glass">{m(MATERIAL_LABELS.glass)}</SelectItem>
                <SelectItem value="tinted">{m(MATERIAL_LABELS.tinted)}</SelectItem>
                <SelectItem value="minimal">{m(MATERIAL_LABELS.minimal)}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      >
        <ComposerPreview />
      </SettingsRow>

      <SettingsRow
        {...searchableSetting("mattr-composer-shape")}
        description={gt("The composer's shape, from the default shelf to a soft pill.")}
        devicePreference
        resetAction={
          appearance.shape !== defaults.shape ? (
            <SettingResetButton
              ariaLabel={gt("Reset composer style to default")}
              onClick={() => update({ shape: defaults.shape })}
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-40">
            <Select
              value={appearance.shape}
              onValueChange={(value) => {
                if (isShape(value)) update({ shape: value });
              }}
            >
              <SelectTrigger size="sm" className="w-full min-w-0" aria-label={gt("Composer style")}>
                <SelectValue>{m(SHAPE_LABELS[appearance.shape])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="shelf">{gt("Shelf (default)")}</SelectItem>
                <SelectItem value="floating">{m(SHAPE_LABELS.floating)}</SelectItem>
                <SelectItem value="compact">{m(SHAPE_LABELS.compact)}</SelectItem>
                <SelectItem value="pill">{m(SHAPE_LABELS.pill)}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />

      {composerMaterialIsTranslucent(material) ? (
        <SettingsRow
          {...searchableSetting("setting-mattr-composer-transparency")}
          description={gt("How much of the conversation shows through the composer.")}
          devicePreference
          resetAction={
            appearance.transparency !== defaults.transparency ? (
              <SettingResetButton
                ariaLabel={gt("Reset composer transparency to default")}
                onClick={() => update({ transparency: defaults.transparency })}
              />
            ) : null
          }
          control={
            <AppearanceSlider
              id="mattr-composer-transparency"
              label={gt("Composer transparency")}
              value={appearance.transparency}
              min={MIN_COMPOSER_TRANSPARENCY}
              max={MAX_COMPOSER_TRANSPARENCY}
              display={`${appearance.transparency}%`}
              onChange={(transparency) => update({ transparency })}
            />
          }
        />
      ) : null}

      {composerMaterialHasBlurControl(material) ? (
        <SettingsRow
          {...searchableSetting("setting-mattr-composer-blur")}
          description={gt("How strongly the conversation behind the composer is blurred.")}
          devicePreference
          resetAction={
            appearance.blur !== defaults.blur ? (
              <SettingResetButton
                ariaLabel={gt("Reset composer blur to default")}
                onClick={() => update({ blur: defaults.blur })}
              />
            ) : null
          }
          control={
            <AppearanceSlider
              id="mattr-composer-blur"
              label={gt("Composer blur")}
              value={appearance.blur}
              min={MIN_COMPOSER_BLUR}
              max={MAX_COMPOSER_BLUR}
              step={2}
              display={appearance.blur === 0 ? gt("Off") : `${appearance.blur}px`}
              onChange={(blur) => update({ blur })}
            />
          }
        />
      ) : null}

      {material !== "minimal" ? (
        <SettingsRow
          {...searchableSetting("mattr-composer-color")}
          description={gt(
            "Tint the composer. Colors adapt to light and dark so the prompt stays readable.",
          )}
          devicePreference
          resetAction={
            !isDefaultColor ? (
              <SettingResetButton
                ariaLabel={gt("Reset composer color to default")}
                onClick={() => update({ color: defaults.color })}
              />
            ) : null
          }
          control={
            <div
              role="group"
              aria-label={gt("Composer color")}
              className="flex flex-wrap items-center gap-2 py-0.5"
            >
              {material === "tinted" ? (
                <ColorSwatch
                  label={gt("Default (match shell)")}
                  color={shellColor}
                  selected={color === null || color === "shell"}
                  className="bg-sidebar"
                  style={shellColor === null ? {} : { backgroundColor: shellColor }}
                  onSelect={() => update({ color: null })}
                />
              ) : (
                <>
                  <ColorSwatch
                    label={gt("Default")}
                    color={null}
                    selected={color === null}
                    className="bg-card"
                    onSelect={() => update({ color: null })}
                  />
                  <ColorSwatch
                    label={gt("Match shell")}
                    color={shellColor}
                    selected={color === "shell"}
                    className="bg-sidebar"
                    style={shellColor === null ? {} : { backgroundColor: shellColor }}
                    onSelect={() => update({ color: "shell" })}
                  />
                </>
              )}
              {SHELL_COLOR_PRESETS.map((preset) => (
                <ColorSwatch
                  key={preset.id}
                  label={m(SHELL_COLOR_LABELS[preset.id] ?? preset.id)}
                  color={preset.color}
                  selected={color === preset.color}
                  style={{ backgroundColor: preset.color }}
                  onSelect={() => update({ color: preset.color })}
                />
              ))}
              <CustomColorSwatch
                value={isCustomColor ? color : null}
                selected={isCustomColor}
                onChange={(next) => update({ color: next })}
              />
            </div>
          }
        />
      ) : null}
    </>
  );
}
