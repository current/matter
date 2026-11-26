import { useGT } from "gt-react";
import { ChevronsUpDownIcon, InboxIcon, LayoutGridIcon } from "lucide-react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../ui/menu";
import { useMattrSidebarLayout } from "./mattrSidebarStore";

/**
 * One quiet line that names the rail's layout and opens a menu to switch it, in place of a
 * permanent switcher pill. Spaces uses it; the default rail switches from its mattr menu.
 */
export function MattrScopeLine() {
  const gt = useGT();
  const [layout, setLayout] = useMattrSidebarLayout();
  const isDefault = layout !== "spaces";

  return (
    <div className="shrink-0 px-2 pb-0.5">
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={isDefault ? gt("Sidebar view: Default") : gt("Sidebar view: Spaces")}
              className="flex h-6.5 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset data-popup-open:bg-sidebar-row-active [&_svg]:size-3.5 [&_svg]:shrink-0"
            />
          }
        >
          {isDefault ? <InboxIcon aria-hidden /> : <LayoutGridIcon aria-hidden />}
          <span className="shrink-0 font-semibold text-sidebar-foreground">
            {isDefault ? gt("Default") : gt("Spaces")}
          </span>
          <ChevronsUpDownIcon aria-hidden className="ml-auto size-3! opacity-75" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>{gt("View")}</MenuGroupLabel>
            <MenuRadioGroup
              value={isDefault ? "inbox" : "spaces"}
              onValueChange={(value) =>
                setLayout(value === "spaces" || value === "timeline" ? value : "inbox")
              }
            >
              <MenuRadioItem closeOnClick value="inbox">
                {gt("Default")}
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="spaces">
                {gt("Spaces")}
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="timeline">
                {gt("Timeline")}
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
