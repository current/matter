import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Switch } from "../ui/switch";
import { MatterSwitchableAccounts } from "./MatterSwitchableAccounts";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Matter: whether agents spread parallel subagents across every signed-in subscription. */
export function MatterDelegationSettings({
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
  const paceMixed = useScopedSettingsMixed(["mattrDelegationBalanceByPace"]);
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const enabled = settings.mattrMultiProviderDelegation;
  const defaultEnabled = DEFAULT_SERVER_SETTINGS.mattrMultiProviderDelegation;
  const byPace = settings.mattrDelegationBalanceByPace;
  const defaultByPace = DEFAULT_SERVER_SETTINGS.mattrDelegationBalanceByPace;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["mattrMultiProviderDelegation", "mattrDelegationBalanceByPace"]}
      mixed={mixed}
      {...searchableSetting("matter-multi-provider-delegation")}
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
        <>
          <MatterSwitchableAccounts
            entries={entries}
            excludedInstanceIds={settings.mattrDelegationExcludedInstanceIds}
            disabled={disabled}
            legend={gt("Delegation pool")}
            onChange={(ids) => updateSettings({ mattrDelegationExcludedInstanceIds: ids })}
          />
          {/* -mt-2 cancels the pool's bottom margin so the two rails read as one. */}
          <div className="-mt-2 mb-2 border-l-2 border-border/60 ps-3 pt-1">
            <div className="flex items-start justify-between gap-3 border-t border-border/40 pt-2">
              <span className={disabled ? "min-w-0 opacity-64" : "min-w-0"}>
                <span className="flex items-center gap-1 text-sm text-foreground">
                  {gt("Balance by usage pace")}
                  {byPace !== defaultByPace && !paceMixed ? (
                    <SettingResetButton
                      ariaLabel={gt("Reset balance by usage pace to default")}
                      onClick={() =>
                        updateSettings({ mattrDelegationBalanceByPace: defaultByPace })
                      }
                    />
                  ) : null}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {gt(
                    "Prefer accounts that can spend the most usage per hour before their limits reset.",
                  )}
                </span>
              </span>
              <Switch
                size="sm"
                aria-label={gt("Balance by usage pace")}
                mixed={paceMixed}
                checked={paceMixed ? false : byPace}
                disabled={disabled}
                onCheckedChange={(next) => updateSettings({ mattrDelegationBalanceByPace: next })}
              />
            </div>
          </div>
        </>
      ) : null}
    </SettingsRow>
  );
}
