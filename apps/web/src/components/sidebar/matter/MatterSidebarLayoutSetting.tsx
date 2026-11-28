import { useGT } from "gt-react";

import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../../state/environments";
import { SettingResetButton, SettingsRow } from "../../settings/settingsLayout";
import { Switch } from "../../ui/switch";
import { Checkbox } from "../../ui/checkbox";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { MatterProviderMark } from "./MatterDefaultSidebarParts";
import { pickUsageMeters } from "./matterFinalSidebar.logic";
import {
  DEFAULT_MATTER_SIDEBAR_LAYOUT,
  MatterSidebarLayout,
  useMatterHiddenUsageMeters,
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
      {layout === "inbox" || layout === "timeline" ? <MatterUsageMetersSetting /> : null}
    </>
  );
}

/** Which providers' limits the Default and Timeline footers show; saved on this device. */
function MatterUsageMetersSetting() {
  const gt = useGT();
  const [hidden, setHidden] = useMatterHiddenUsageMeters();
  const primaryId = usePrimaryEnvironmentId();
  const providers = useEnvironmentProviders();
  // By name, so the list doesn't reorder as usage moves.
  const available = pickUsageMeters(
    primaryId === null ? [] : (providers.get(primaryId) ?? []),
    Number.POSITIVE_INFINITY,
  ).toSorted((left, right) => left.providerName.localeCompare(right.providerName));
  if (available.length === 0) return null;
  const shownCount = available.filter((meter) => !hidden.includes(meter.driver)).length;
  return (
    <SettingsRow
      id="matter-usage-meters"
      title={gt("Usage meters")}
      description={gt("Choose which providers' limits show at the bottom of the sidebar.")}
      devicePreference
      resetAction={
        hidden.length > 0 ? (
          <SettingResetButton
            ariaLabel={gt("Show every usage meter")}
            onClick={() => setHidden([])}
          />
        ) : null
      }
    >
      <fieldset className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
        <legend className="pb-1 text-xs text-muted-foreground">{gt("Show in the sidebar")}</legend>
        <ul>
          {available.map((meter) => {
            const shown = !hidden.includes(meter.driver);
            return (
              <li key={meter.driver}>
                <label className="flex cursor-pointer items-center gap-2.5 py-1 text-sm has-data-disabled:cursor-default">
                  <Checkbox
                    checked={shown}
                    // The last one stays, so the footer never goes blank without a reason.
                    disabled={shown && shownCount === 1}
                    onCheckedChange={(next) =>
                      setHidden(
                        next
                          ? hidden.filter((driver) => driver !== meter.driver)
                          : [...hidden, meter.driver],
                      )
                    }
                  />
                  <span className={shown ? undefined : "opacity-50 grayscale"}>
                    <MatterProviderMark driver={meter.driver} />
                  </span>
                  <span
                    className={
                      shown ? "min-w-0 truncate" : "min-w-0 truncate text-muted-foreground"
                    }
                  >
                    {meter.providerName}
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
                    {gt("{percent}% used", { percent: meter.usedPercent })}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </SettingsRow>
  );
}
