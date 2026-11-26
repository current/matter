import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Switch } from "../ui/switch";
import { MattrSwitchableAccounts } from "./MattrSwitchableAccounts";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** mattr: whether agents spread parallel subagents across every signed-in subscription. */
export function MattrDelegationSettings({
  entries,
  disabled,
}: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mattrMultiProviderDelegation"]);
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const enabled = settings.mattrMultiProviderDelegation;
  const defaultEnabled = DEFAULT_SERVER_SETTINGS.mattrMultiProviderDelegation;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["mattrMultiProviderDelegation"]}
      mixed={mixed}
      {...searchableSetting("mattr-multi-provider-delegation")}
      description={gt(
        "Spread parallel subagents across all signed-in subscriptions based on remaining usage.",
      )}
      resetAction={
        enabled !== defaultEnabled ? (
          <SettingResetButton
            ariaLabel={gt("Reset multi-provider delegation to default")}
            onClick={() => updateSettings({ mattrMultiProviderDelegation: defaultEnabled })}
          />
        ) : null
      }
      control={
        <Switch
          aria-label={gt("Multi-provider delegation")}
          mixed={mixed}
          checked={mixed ? false : enabled}
          onCheckedChange={(next) => updateSettings({ mattrMultiProviderDelegation: next })}
        />
      }
    >
      {enabled && !mixed ? (
        <MattrSwitchableAccounts
          entries={entries}
          excludedInstanceIds={settings.mattrDelegationExcludedInstanceIds}
          disabled={disabled}
          legend={gt("Delegation pool")}
          onChange={(ids) => updateSettings({ mattrDelegationExcludedInstanceIds: ids })}
        />
      ) : null}
    </SettingsRow>
  );
}
