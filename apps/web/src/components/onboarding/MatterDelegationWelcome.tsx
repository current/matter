import type { EnvironmentId } from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName as agentName } from "@t3tools/client-runtime/state/provider-instance-display";
import { T, useGT } from "gt-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { welcomeAgentState } from "../../onboarding/welcomePage.logic";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Switch } from "../ui/switch";
import { useWelcomeAgents, WelcomeSection } from "./WelcomePage";

/** Matter: offers multi-provider delegation once two or more subscriptions are signed in. */
export function MatterDelegationWelcome({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const { serverConfig, found } = useWelcomeAgents(environmentId);
  const signedIn = found.filter(
    (provider) => welcomeAgentState(provider, serverConfig?.settings) === "ready",
  );
  if (serverConfig === null || signedIn.length < 2) return null;
  return (
    <WelcomeSection title={gt("Subscriptions")}>
      <div className="flex min-h-10 items-center gap-3 py-1 pl-8">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="truncate text-sm font-medium text-foreground">
              <T>Multi-provider delegation</T>
            </span>
            <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
              {signedIn.map((provider) => (
                <ProviderInstanceIcon
                  key={provider.instanceId}
                  driverKind={provider.driver}
                  displayName={agentName(provider)}
                  iconClassName="size-3.5"
                />
              ))}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <T>
              T3 Code spreads parallel subagents across your subscriptions at once, using whichever
              has the most usage left.
            </T>
          </p>
        </div>
        <DelegationSwitch
          environmentId={environmentId}
          checked={serverConfig.settings.mattrMultiProviderDelegation}
        />
      </div>
    </WelcomeSection>
  );
}

// Mounted only once the row shows, so the settings writer never runs for a single-agent page.
function DelegationSwitch({
  environmentId,
  checked,
}: {
  readonly environmentId: EnvironmentId;
  readonly checked: boolean;
}) {
  const gt = useGT();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return (
    <Switch
      aria-label={gt("Multi-provider delegation")}
      checked={checked}
      onCheckedChange={(enabled) => updateSettings({ mattrMultiProviderDelegation: enabled })}
    />
  );
}
