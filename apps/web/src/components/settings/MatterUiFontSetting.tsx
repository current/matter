import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useEffect } from "react";
import { useGT } from "gt-react";
import * as Schema from "effect/Schema";

import { isFontFamilyAvailable } from "../../appearanceFonts";
import {
  applyMatterUiFont,
  DEFAULT_MATTER_UI_FONT,
  loadMatterUiFont,
  MATTER_UI_FONTS,
  MatterUiFont,
  type MatterUiFontDefinition,
  SYSTEM_STAND_IN,
  useMatterUiFont,
} from "../../matterUiFont";
import { RadioGroup } from "../ui/radio-group";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const isMatterUiFont = Schema.is(MatterUiFont);

const installedCache = new Map<string, boolean>();
function isInstalled(family: string): boolean {
  let installed = installedCache.get(family);
  if (installed === undefined) {
    installed = isFontFamilyAvailable(family);
    installedCache.set(family, installed);
  }
  return installed;
}

/** Settings → Appearance: the interface typeface, saved on this device. */
export function MatterUiFontSetting() {
  const gt = useGT();
  const [font, setFont] = useMatterUiFont();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches each bundled face so every tile previews in its own font.
  useEffect(() => {
    for (const definition of MATTER_UI_FONTS) void loadMatterUiFont(definition.id);
  }, []);

  return (
    <SettingsRow
      id="matter-ui-font"
      title={gt("UI font")}
      description={gt(
        "The typeface for the whole interface. Code keeps the code font. Licensed faces are used when installed, otherwise a bundled open stand-in.",
      )}
      devicePreference
      resetAction={
        font !== DEFAULT_MATTER_UI_FONT ? (
          <SettingResetButton
            ariaLabel={gt("Reset UI font to default")}
            onClick={() => {
              applyMatterUiFont(document.documentElement, DEFAULT_MATTER_UI_FONT);
              setFont(DEFAULT_MATTER_UI_FONT);
            }}
          />
        ) : null
      }
    >
      <div className="pt-3 pb-2">
        <RadioGroup
          aria-label={gt("UI font")}
          value={font}
          onValueChange={(value) => {
            if (!isMatterUiFont(value)) return;
            // Apply here too, so the pick never depends on the entry hook having subscribed.
            applyMatterUiFont(document.documentElement, value);
            setFont(value);
          }}
          className="grid grid-cols-1 @min-[32rem]/settings-row:grid-cols-2 @min-[48rem]/settings-row:grid-cols-3"
        >
          {MATTER_UI_FONTS.map((definition) => (
            <MatterUiFontTile key={definition.id} definition={definition} />
          ))}
        </RadioGroup>
      </div>
    </SettingsRow>
  );
}

function MatterUiFontTile({ definition }: { readonly definition: MatterUiFontDefinition }) {
  const gt = useGT();
  const installed = definition.localFamily !== undefined && isInstalled(definition.localFamily);
  // Without the licensed face this pick renders exactly like the default, so it can't be picked.
  const unavailable = definition.standIn === SYSTEM_STAND_IN && !installed;
  const standInNote =
    definition.standIn === undefined
      ? null
      : installed
        ? gt("Installed")
        : unavailable
          ? gt("Not installed")
          : gt("{font} stand-in", { font: definition.standIn });

  return (
    <RadioPrimitive.Root
      value={definition.id}
      disabled={unavailable}
      data-matter-ui-font-option={definition.id}
      className="group/font relative flex min-w-0 cursor-pointer data-disabled:cursor-not-allowed data-disabled:opacity-50 flex-col gap-2.5 rounded-lg bg-card px-3 pt-2.5 pb-3 text-left outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-sm font-medium text-foreground"
            style={{ fontFamily: definition.stack }}
          >
            {definition.name}
          </span>
          <span className="block truncate text-2xs text-muted-foreground">
            {definition.usedBy}
            {standInNote ? (
              <span className="text-muted-foreground/70"> · {standInNote}</span>
            ) : null}
          </span>
        </span>
        <RadioPrimitive.Indicator
          className="grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
          aria-hidden
        >
          <CheckIcon className="size-3 shrink-0" />
        </RadioPrimitive.Indicator>
      </span>
      <span
        aria-hidden
        className="block truncate text-xl leading-tight tracking-tight text-foreground"
        style={{ fontFamily: definition.stack }}
      >
        {gt("Ship the agent.")}
      </span>
    </RadioPrimitive.Root>
  );
}
