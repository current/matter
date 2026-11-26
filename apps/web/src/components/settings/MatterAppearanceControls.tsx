import type { CSSProperties } from "react";
import { msg, useGT } from "gt-react";
import { CheckIcon } from "lucide-react";
import { normalizeShellColor, relativeLuminance } from "../../../../../matter/shellTint";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const SHELL_COLOR_LABELS: Record<string, string> = {
  graphite: msg("Graphite", { $context: "window shell color" }),
  "ocean-slate": msg("Ocean Slate", { $context: "window shell color" }),
  "deep-indigo": msg("Deep Indigo", { $context: "window shell color" }),
  "sage-moss": msg("Sage Moss", { $context: "window shell color" }),
  "warm-terracotta": msg("Warm Terracotta", { $context: "window shell color" }),
  "dusk-plum": msg("Dusk Plum", { $context: "window shell color" }),
  "rose-clay": msg("Rose Clay", { $context: "window shell color" }),
  "obsidian-amber": msg("Obsidian Amber", { $context: "window shell color" }),
};

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

export function ColorSwatch({
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

/** The rainbow swatch that opens the system color picker; it shows the pick once one is chosen. */
export function CustomColorSwatch({
  value,
  selected,
  onChange,
}: {
  value: string | null;
  selected: boolean;
  onChange: (color: string) => void;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label
            data-selected={selected ? "" : undefined}
            className={cn(
              SWATCH_CLASS,
              "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-inset",
            )}
            style={{ background: selected && value ? value : CUSTOM_SWATCH_BACKGROUND }}
          >
            {selected && value ? <SwatchCheck color={value} /> : null}
            <input
              type="color"
              aria-label={selected ? gt("Custom color (selected)") : gt("Custom color")}
              className="absolute inset-0 size-full cursor-pointer rounded-full opacity-0"
              value={value ?? "#5b6068"}
              onChange={(event) => {
                const next = normalizeShellColor(event.currentTarget.value);
                if (next !== null && next !== value) onChange(next);
              }}
            />
          </label>
        }
      />
      <TooltipPopup>{gt("Custom color")}</TooltipPopup>
    </Tooltip>
  );
}

export function AppearanceSlider({
  id,
  label,
  value,
  min,
  max,
  step = 5,
  display,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
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
        step={step}
        style={style}
        type="range"
        value={value}
      />
    </div>
  );
}
