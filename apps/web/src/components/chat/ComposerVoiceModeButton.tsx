import { useGT } from "gt-react";
import type { PointerEvent } from "react";

import { MatterVoiceModeIcon } from "./MatterComposerParts.matter";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const keepFocus = (event: PointerEvent) => event.preventDefault();

/** Native composer trigger that opens hands-free Voice Mode scoped to the active thread. */
export function ComposerVoiceModeButton(props: {
  readonly disabled?: boolean;
  /** Compact matches the `xs` buttons beside text-field editors. */
  readonly size?: "default" | "compact";
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const label = gt("Start voice mode");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={props.size === "compact" ? "icon-xs" : "icon-sm"}
            variant="ghost"
            aria-label={label}
            disabled={props.disabled}
            onPointerDown={keepFocus}
            onClick={() => {
              if (!props.disabled) props.onOpen();
            }}
            className="shrink-0"
          >
            <MatterVoiceModeIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">{gt("Voice mode")}</TooltipPopup>
    </Tooltip>
  );
}
