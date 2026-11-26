import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useEffect } from "react";
import { useGT } from "gt-react";
import * as Schema from "effect/Schema";

import { isFontFamilyAvailable } from "../../appearanceFonts";
import {
  DEFAULT_MATTR_UI_FONT,
  loadMattrUiFont,
  MATTR_UI_FONTS,
  MattrUiFont,
  type MattrUiFontDefinition,
  SYSTEM_STAND_IN,
  useMattrUiFont,
} from "../../mattrUiFont";
import { RadioGroup } from "../ui/radio-group";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const isMattrUiFont = Schema.is(MattrUiFont);

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
export function MattrUiFontSetting() {
  const gt = useGT();
  const [font, setFont] = useMattrUiFont();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches each bundled face so every tile previews in its own font.
  useEffect(() => {
    for (const definition of MATTR_UI_FONTS) void loadMattrUiFont(definition.id);
  }, []);

  return (
    <SettingsRow
      id="mattr-ui-font"
      title={gt("UI font")}
      description={gt(
        "The typeface for the whole interface. Code keeps the code font. Licensed faces are used when installed, otherwise a bundled open stand-in.",
      )}
      devicePreference
      resetAction={
        font !== DEFAULT_MATTR_UI_FONT ? (
          <SettingResetButton
            ariaLabel={gt("Reset UI font to default")}
            onClick={() => setFont(DEFAULT_MATTR_UI_FONT)}
          />
        ) : null
      }
    >
      <div className="pt-3 pb-2">
        <RadioGroup
          aria-label={gt("UI font")}
          value={font}
          onValueChange={(value) => {
            if (isMattrUiFont(value)) setFont(value);
          }}
          className="grid grid-cols-1 @min-[32rem]/settings-row:grid-cols-2 @min-[48rem]/settings-row:grid-cols-3"
        >
          {MATTR_UI_FONTS.map((definition) => (
            <MattrUiFontTile key={definition.id} definition={definition} />
          ))}
        </RadioGroup>
      </div>
    </SettingsRow>
  );
}

function MattrUiFontTile({ definition }: { readonly definition: MattrUiFontDefinition }) {
  const gt = useGT();
  const standInNote =
    definition.standIn === undefined
      ? null
      : definition.localFamily !== undefined && isInstalled(definition.localFamily)
        ? gt("Installed")
        : definition.standIn === SYSTEM_STAND_IN
          ? gt("System font until installed")
          : gt("{font} stand-in", { font: definition.standIn });

  return (
    <RadioPrimitive.Root
      value={definition.id}
      data-mattr-ui-font-option={definition.id}
      className="group/font relative flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-lg bg-card px-3 pt-2.5 pb-3 text-left outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
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
