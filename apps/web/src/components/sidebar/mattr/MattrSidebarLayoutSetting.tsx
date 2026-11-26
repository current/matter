import { useGT } from "gt-react";

import { SettingResetButton, SettingsRow } from "../../settings/settingsLayout";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  DEFAULT_MATTR_SIDEBAR_LAYOUT,
  MattrSidebarLayout,
  useMattrSidebarLayout,
} from "./mattrSidebarStore";
import * as Schema from "effect/Schema";

const isMattrSidebarLayout = Schema.is(MattrSidebarLayout);

/** Settings → Appearance row choosing the sidebar body; saved on this device. */
export function MattrSidebarLayoutSetting() {
  const gt = useGT();
  const [layout, setLayout] = useMattrSidebarLayout();
  return (
    <SettingsRow
      id="mattr-sidebar-layout"
      title={gt("Sidebar layout")}
      description={gt(
        "The default groups threads by project with their subagents nested. Spaces shows one project at a time. Classic keeps the original sidebar.",
      )}
      devicePreference
      resetAction={
        layout !== DEFAULT_MATTR_SIDEBAR_LAYOUT ? (
          <SettingResetButton
            ariaLabel={gt("Reset sidebar layout to default")}
            onClick={() => setLayout(DEFAULT_MATTR_SIDEBAR_LAYOUT)}
          />
        ) : null
      }
      control={
        <ToggleGroup
          aria-label={gt("Sidebar layout")}
          variant="segmented"
          value={[layout]}
          onValueChange={(next) => {
            const value = next[0];
            if (isMattrSidebarLayout(value)) setLayout(value);
          }}
        >
          <Toggle value="inbox">{gt("Default")}</Toggle>
          <Toggle value="spaces">{gt("Spaces")}</Toggle>
          <Toggle value="classic">{gt("Classic")}</Toggle>
        </ToggleGroup>
      }
    />
  );
}
