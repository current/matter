import { useGT } from "gt-react";

import { SettingResetButton, SettingsRow } from "../../settings/settingsLayout";
import { Switch } from "../../ui/switch";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  DEFAULT_MATTER_SIDEBAR_LAYOUT,
  MatterSidebarLayout,
  useMatterSidebarLayout,
  useMatterTimelineSubagents,
} from "./matterSidebarStore";
import * as Schema from "effect/Schema";

const isMatterSidebarLayout = Schema.is(MatterSidebarLayout);

/** Settings → Appearance rows choosing the sidebar body; saved on this device. */
export function MatterSidebarLayoutSetting() {
  const gt = useGT();
  const [layout, setLayout] = useMatterSidebarLayout();
  const [showSubagents, setShowSubagents] = useMatterTimelineSubagents();
  return (
    <>
      <SettingsRow
        id="matter-sidebar-layout"
        title={gt("Sidebar layout")}
        description={gt(
          "The default groups threads by project with their subagents nested. Spaces shows one project at a time. Timeline lists threads by day with their branch and pull request. Classic keeps the original sidebar.",
        )}
        devicePreference
        resetAction={
          layout !== DEFAULT_MATTER_SIDEBAR_LAYOUT ? (
            <SettingResetButton
              ariaLabel={gt("Reset sidebar layout to default")}
              onClick={() => setLayout(DEFAULT_MATTER_SIDEBAR_LAYOUT)}
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
              if (isMatterSidebarLayout(value)) setLayout(value);
            }}
          >
            <Toggle value="inbox">{gt("Default")}</Toggle>
            <Toggle value="spaces">{gt("Spaces")}</Toggle>
            <Toggle value="timeline">{gt("Timeline")}</Toggle>
            <Toggle value="classic">{gt("Classic")}</Toggle>
          </ToggleGroup>
        }
      />
      {layout === "timeline" ? (
        <SettingsRow
          id="matter-timeline-subagents"
          title={gt("Show active subagents")}
          description={gt(
            "Nest a thread's running subagents under it. Each one leaves the list when it finishes.",
          )}
          devicePreference
          resetAction={
            showSubagents ? null : (
              <SettingResetButton
                ariaLabel={gt("Reset show active subagents to default")}
                onClick={() => setShowSubagents(true)}
              />
            )
          }
          control={
            <Switch
              checked={showSubagents}
              onCheckedChange={(checked) => setShowSubagents(Boolean(checked))}
              aria-label={gt("Show active subagents")}
            />
          }
        />
      ) : null}
    </>
  );
}
