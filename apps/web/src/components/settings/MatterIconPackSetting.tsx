import { msg, useGT, useMessages } from "gt-react";
import {
  BellIcon,
  FolderIcon,
  InboxIcon,
  MessageSquareIcon,
  SettingsIcon,
  TerminalIcon,
} from "lucide-react";
import { Fragment, createElement, type ReactNode } from "react";

import {
  DEFAULT_ICON_PACK,
  ICON_PACK_OPTIONS,
  iconPackSource,
  isIconPackId,
  preloadIconPacks,
  setIconPack,
  type IconPackId,
} from "../../../../../matter/icons/iconPack";
import { drawPackIcon, packIconSpecOf } from "../../../../../matter/icons/packIcon";
import { useMatterIconPack, useMatterIconPackState } from "../../matterIconPack";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const PACK_DESCRIPTIONS: Record<IconPackId, string> = {
  "sf-symbols-fill": msg("Apple's filled system glyphs", { $context: "icon pack" }),
  "solar-bold": msg("Bold, soft shapes, as in Clonk", { $context: "icon pack" }),
  "solar-duotone": msg("Solar with a tinted second layer", { $context: "icon pack" }),
  "phosphor-fill": msg("Solid, rounded Phosphor shapes", { $context: "icon pack" }),
  "heroicons-solid": msg("Tailwind's solid set", { $context: "icon pack" }),
  "remix-fill": msg("Crisp, filled product glyphs", { $context: "icon pack" }),
  "mingcute-fill": msg("Plump, friendly solids", { $context: "icon pack" }),
  "fluent-filled": msg("Microsoft's filled system icons", { $context: "icon pack" }),
  "ionicons-solid": msg("Ionic's solid app icons", { $context: "icon pack" }),
  "material-rounded-fill": msg("Google's filled, rounded symbols", { $context: "icon pack" }),
  "tabler-filled": msg("Solid Tabler shapes, line arrows", { $context: "icon pack" }),
  hugeicons: msg("Synara's outlines, solid panel glyphs", { $context: "icon pack" }),
  "lucide-orca": msg("Thin 1.5 strokes, as in Orca", { $context: "icon pack" }),
};

const PREVIEW_ICONS = {
  FolderIcon,
  InboxIcon,
  MessageSquareIcon,
  TerminalIcon,
  BellIcon,
  SettingsIcon,
};

/** Six real app icons drawn in `pack`, whatever pack the rest of the app shows. */
function IconPackPreview({ pack }: { pack: IconPackId }) {
  const { sources, failed } = useMatterIconPackState();
  const source = iconPackSource(pack);
  const ready = source === null || sources[source] !== undefined || failed[source] === true;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground" aria-hidden>
      {Object.entries(PREVIEW_ICONS).map(([name, Icon]) => {
        const spec = packIconSpecOf(Icon);
        const props = { className: "size-3.5" };
        return (
          <Fragment key={name}>
            {spec ? (
              (drawPackIcon(
                { createElement },
                spec,
                ready ? pack : null,
                sources,
                props,
              ) as ReactNode)
            ) : (
              <Icon {...props} />
            )}
          </Fragment>
        );
      })}
    </span>
  );
}

/** Settings → Appearance row choosing the app's icon pack; saved on this device, applied live. */
export function MatterIconPackSetting() {
  const gt = useGT();
  const m = useMessages();
  const pack = useMatterIconPack();
  const current = ICON_PACK_OPTIONS.find((option) => option.id === pack);
  return (
    <SettingsRow
      id="matter-icon-pack"
      title={gt("Icon pack")}
      description={gt("Choose the icon set used across the app. Changes apply instantly.")}
      devicePreference
      resetAction={
        pack !== DEFAULT_ICON_PACK ? (
          <SettingResetButton
            ariaLabel={gt("Reset icon pack to default")}
            onClick={() => setIconPack(DEFAULT_ICON_PACK)}
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-52">
          <Select
            value={pack}
            onValueChange={(value) => {
              if (isIconPackId(value)) setIconPack(value);
            }}
            onOpenChange={(open) => {
              if (open) preloadIconPacks();
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={gt("Icon pack")}>
              <SelectValue>{current?.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ICON_PACK_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  <span className="flex w-full items-center justify-between gap-6">
                    <span className="flex min-w-0 flex-col">
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-xs">
                        {m(PACK_DESCRIPTIONS[option.id])}
                      </span>
                    </span>
                    <IconPackPreview pack={option.id} />
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
