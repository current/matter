import { T, useGT } from "gt-react";
import { FolderIcon, PlusIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The final-choice composer's attach control: a plus, where upstream draws a paperclip. */
export function MattrComposerAttachButton({ onOpenPicker }: { readonly onOpenPicker: () => void }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-mattr-composer-attach=""
            onPointerDown={(event) => event.preventDefault()}
            onClick={onOpenPicker}
            aria-label={gt("Attach files")}
          />
        }
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipPopup>
        <T>Attach files</T>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The project name leading the composer's under-tray. */
export function MattrComposerProjectLabel({ title }: { readonly title: string }) {
  return (
    <span data-mattr-composer-project="">
      <FolderIcon aria-hidden="true" />
      <span data-mattr-composer-project-name="">{title}</span>
    </span>
  );
}
