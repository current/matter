import type { ProviderInteractionMode } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { ChevronUpIcon, HammerIcon, ListChecksIcon, TargetIcon, XIcon } from "lucide-react";
import { use, useState } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HiddenThreadContext } from "./backgroundThread";
import { ComposerControl } from "./ComposerControl";
import { composerFloatingLayerProps, useComposerMenuProps } from "./composerEventScope";
import { MATTER_INTERACTION_MODES } from "@t3tools/client-runtime/matter/interaction-mode";
import { useComposerMenuState } from "./useComposerMenuState";

const MODE_COPY = {
  default: {
    icon: HammerIcon,
    label: msg("Default", { $context: "composer interaction mode" }),
    description: msg("Normal interactive coding"),
  },
  plan: {
    icon: ListChecksIcon,
    label: msg("Plan", { $context: "composer interaction mode" }),
    description: msg("Research, ask questions, and propose a step-by-step plan before editing"),
  },
  goal: {
    icon: TargetIcon,
    label: msg("Goal", { $context: "composer interaction mode" }),
    description: msg("Autonomous end-to-end execution until verified complete"),
  },
} as const;

const MATTER_MODE_SHORTCUT_LABEL = "⇧Tab";

function MatterModeMenuItems(props: {
  readonly mode: ProviderInteractionMode;
  readonly onModeChange: (mode: ProviderInteractionMode) => void;
}) {
  const messages = useMessages();
  const { mode, onModeChange } = props;
  return (
    <div className="w-80" data-matter-mode-menu="">
      <MenuGroup>
        <MenuGroupLabel>
          <T>Mode</T>
        </MenuGroupLabel>
        <MenuRadioGroup
          value={mode}
          onValueChange={(value: ProviderInteractionMode) => {
            if (value !== mode) onModeChange(value);
          }}
        >
          {MATTER_INTERACTION_MODES.map((option) => {
            const copy = MODE_COPY[option];
            const OptionIcon = copy.icon;
            return (
              <MenuRadioItem key={option} value={option} closeOnClick>
                <span className="flex w-full items-start gap-2">
                  <OptionIcon aria-hidden="true" className="mt-0.5 size-4" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{messages(copy.label)}</span>
                    <span className="text-muted-foreground text-xs leading-snug">
                      {messages(copy.description)}
                    </span>
                  </span>
                  <MenuRadioItemIndicator className="mt-0.5 ms-auto" />
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuGroup>
      <div data-matter-mode-menu-hint="" className="px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
        <T>
          <kbd className="font-sans">⇧Tab</kbd> cycles modes
        </T>
      </div>
    </div>
  );
}

/**
 * Plan or Goal as a tinted pill with a clear button; Default shows nothing here and is chosen in
 * the model picker's footer. Shift+Tab and `/plan`, `/goal`, `/default` reach the same setter.
 */
export function MatterComposerModeControl(props: {
  readonly mode: ProviderInteractionMode;
  readonly onModeChange: (mode: ProviderInteractionMode) => void;
  /** The × on Plan or Goal; leaving a running native goal also clears it there. */
  readonly onClear: () => void;
  /** Read-only or offline threads show their mode but can't change it. */
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(use(HiddenThreadContext));
  const { mode, onModeChange, onClear, disabled = false } = props;
  const [modeState, setModeState] = useState({ mode, changed: false });
  if (modeState.mode !== mode) {
    setModeState({ mode, changed: true });
  }
  const current = MODE_COPY[mode];
  const CurrentIcon = current.icon;
  const label = messages(current.label);
  const active = mode !== "default";
  if (!active) return null;
  const tooltip =
    mode === "plan"
      ? gt("Plan mode: edits wait until you approve the plan")
      : mode === "goal"
        ? gt("Goal mode: works on its own until the task is verified complete")
        : gt("Interaction mode");
  return (
    <span
      data-matter-mode-control=""
      data-mode={mode}
      className={cn(
        "inline-flex shrink-0 items-center rounded-(--control-radius)",
        mode === "plan" && "bg-success/10 text-success-foreground",
        mode === "goal" && "bg-warning/12 text-warning-foreground",
      )}
    >
      <Menu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <ComposerControl
                    className={cn("shrink-0", active && "text-inherit hover:text-inherit")}
                    aria-label={gt("Interaction mode: {label}", { label })}
                    data-matter-mode-trigger=""
                    disabled={disabled}
                  />
                }
              />
            }
          >
            <span
              key={`icon:${modeState.mode}`}
              data-matter-mode-icon=""
              data-matter-mode-changed={modeState.changed ? "" : undefined}
              className="inline-flex shrink-0 items-center"
            >
              <CurrentIcon
                aria-hidden="true"
                data-composer-control-icon=""
                className={cn("size-4", active && "text-current")}
              />
            </span>
            {active ? (
              <span
                key={`label:${modeState.mode}`}
                data-matter-mode-label=""
                data-matter-mode-changed={modeState.changed ? "" : undefined}
              >
                {label}
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {tooltip} · {MATTER_MODE_SHORTCUT_LABEL}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="start" {...composerMenuProps}>
          <MatterModeMenuItems mode={mode} onModeChange={onModeChange} />
        </MenuPopup>
      </Menu>
      {active ? (
        <ComposerControl
          className="shrink-0 px-1 text-inherit hover:text-inherit"
          aria-label={gt("Leave {label} mode", { label })}
          data-matter-mode-clear=""
          disabled={disabled}
          onClick={onClear}
        >
          <XIcon aria-hidden="true" className="size-3.5 text-current" />
        </ComposerControl>
      ) : null}
    </span>
  );
}

/** A tiny target on threads running in Goal mode, for the sidebars. */
export function MatterGoalModeGlyph(props: { readonly mode: ProviderInteractionMode | undefined }) {
  const gt = useGT();
  if (props.mode !== "goal") return null;
  return (
    <TargetIcon
      role="img"
      aria-label={gt("Goal mode")}
      data-matter-goal-glyph=""
      className="size-3 shrink-0 text-warning-foreground"
    />
  );
}

/** The mode menu in the model picker's footer, styled like its Permissions menu beside it. */
export function MatterComposerModePickerMenu(props: {
  readonly mode: ProviderInteractionMode;
  readonly onModeChange: (mode: ProviderInteractionMode) => void;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const current = MODE_COPY[props.mode];
  const CurrentIcon = current.icon;
  const label = messages(current.label);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  data-matter-mode-picker-trigger=""
                  data-mode={props.mode}
                  disabled={props.disabled}
                  aria-label={gt("Interaction mode: {label}", { label })}
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 data-popup-open:bg-foreground/[0.09] data-popup-open:text-foreground"
                />
              }
            />
          }
        >
          <CurrentIcon
            aria-hidden="true"
            className={cn(
              "size-3.5",
              props.mode === "plan" && "text-success-foreground",
              props.mode === "goal" && "text-warning-foreground",
            )}
          />
          {label}
          <ChevronUpIcon aria-hidden="true" className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {gt("Interaction mode")} · {MATTER_MODE_SHORTCUT_LABEL}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="start" {...composerFloatingLayerProps}>
        <MatterModeMenuItems mode={props.mode} onModeChange={props.onModeChange} />
      </MenuPopup>
    </Menu>
  );
}
