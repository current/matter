import {
  CLAUDE_CLOUD_ADDON_ID,
  ClaudeCloudOffloadPolicy as OffloadPolicySchema,
  type ClaudeCloudOffloadPolicy,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useEffect, useState } from "react";

import {
  fetchClaudeCloudStatus,
  settle,
  updateClaudeCloudSettings,
} from "../../addons/claudeCloudApi";
import { useMatterApiConfig } from "../../addons/matterApi";
import { useAddonRegistry, useIsAddonEnabled } from "../../addons/useAddonRegistry";
import { welcomeAgentState } from "../../onboarding/welcomePage.logic";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  CLAUDE_CLOUD_OFFLOAD_POLICY_DESCRIPTIONS,
  CLAUDE_CLOUD_OFFLOAD_POLICY_HINTS,
  CLAUDE_CLOUD_OFFLOAD_POLICY_LABELS,
  CLAUDE_CLOUD_OFFLOAD_POLICY_ORDER,
} from "../cloud/claudeCloudCopy";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useWelcomeAgents, WelcomeSection } from "./WelcomePage";

/** Matter: the Claude Cloud offload preset, beside multi-provider delegation on the welcome page. */
export function MatterClaudeCloudWelcome({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const enabled = useIsAddonEnabled(CLAUDE_CLOUD_ADDON_ID);
  const { serverConfig, found } = useWelcomeAgents(environmentId);
  const hasClaudeAccount = found.some(
    (provider) =>
      provider.driver === "claudeAgent" &&
      welcomeAgentState(provider, serverConfig?.settings) === "ready",
  );
  if (
    !enabled ||
    serverConfig === null ||
    !hasClaudeAccount ||
    (primaryEnvironmentId !== null && environmentId !== primaryEnvironmentId)
  ) {
    return null;
  }
  return <OffloadPresetRow />;
}

// Mounted only when the row shows, so other welcome pages never read Claude Cloud settings.
function OffloadPresetRow() {
  const gt = useGT();
  const m = useMessages();
  const { canWrite } = useAddonRegistry();
  const config = useMatterApiConfig();
  const [policy, setPolicy] = useState<ClaudeCloudOffloadPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the saved preset from the server once; it never probes the CLI
  useEffect(() => {
    if (config === null) return;
    const controller = new AbortController();
    void fetchClaudeCloudStatus(config, { signal: controller.signal })
      .then((status) => setPolicy(status.settings.offloadPolicy))
      .catch(() => {
        if (!controller.signal.aborted) setPolicy("balanced");
      });
    return () => controller.abort();
  }, [config]);

  const choose = async (next: ClaudeCloudOffloadPolicy) => {
    if (config === null) return;
    const previous = policy;
    setPolicy(next);
    setError(null);
    const result = await settle(updateClaudeCloudSettings(config, { offloadPolicy: next }));
    if (!result.ok) {
      setPolicy(previous);
      setError(result.error);
    }
  };

  return (
    <WelcomeSection title={gt("Claude Cloud")}>
      <div className="flex min-h-10 items-center gap-3 py-1 pl-8" data-claude-cloud-welcome="">
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium text-foreground">
            <T>Offload heavy work</T>
          </span>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {policy === null ? (
              <T>Agents can move long builds and test suites to a cloud VM on your Claude plan.</T>
            ) : (
              m(CLAUDE_CLOUD_OFFLOAD_POLICY_DESCRIPTIONS[policy])
            )}
          </p>
          {error ? (
            <p className="text-xs text-destructive-foreground" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <Select
          value={policy ?? "balanced"}
          disabled={!canWrite || config === null || policy === null}
          onValueChange={(value) => {
            if (OffloadPolicySchema.literals.includes(value as ClaudeCloudOffloadPolicy)) {
              void choose(value as ClaudeCloudOffloadPolicy);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-40 shrink-0" aria-label={gt("Offload heavy work")}>
            <SelectValue>{m(CLAUDE_CLOUD_OFFLOAD_POLICY_LABELS[policy ?? "balanced"])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end">
            {CLAUDE_CLOUD_OFFLOAD_POLICY_ORDER.map((option) => (
              <SelectItem key={option} value={option} data-claude-cloud-preset={option}>
                <span className="flex flex-col py-0.5">
                  <span>{m(CLAUDE_CLOUD_OFFLOAD_POLICY_LABELS[option])}</span>
                  <span className="text-xs text-muted-foreground">
                    {m(CLAUDE_CLOUD_OFFLOAD_POLICY_HINTS[option])}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </WelcomeSection>
  );
}
