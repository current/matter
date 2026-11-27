import {
  CLAUDE_CLOUD_ADDON_ID,
  type ClaudeCloudOffloadPolicy,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { settle, updateClaudeCloudSettings } from "../../addons/claudeCloudApi";
import { useMatterApiConfig } from "../../addons/matterApi";
import { useAddonRegistry, useIsAddonEnabled } from "../../addons/useAddonRegistry";
import { cn } from "../../lib/utils";
import { welcomeAgentState } from "../../onboarding/welcomePage.logic";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  CLAUDE_CLOUD_OFFLOAD_POLICY_HINTS,
  CLAUDE_CLOUD_OFFLOAD_POLICY_LABELS,
  CLAUDE_CLOUD_OFFLOAD_POLICY_ORDER,
} from "../cloud/claudeCloudCopy";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useWelcomeAgents, WelcomeSection } from "./WelcomePage";

export const CLAUDE_CLOUD_WELCOME_DISMISSED_KEY = "mattr:claude-cloud:welcome-dismissed:v1";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(CLAUDE_CLOUD_WELCOME_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(CLAUDE_CLOUD_WELCOME_DISMISSED_KEY, "1");
  } catch {
    // Storage can be unavailable (private mode).
  }
}

/**
 * Matter: offers Claude Cloud offload presets on onboarding when the user has a ready Claude
 * account and the add-on is enabled, then dismisses itself once chosen or dismissed.
 */
export function MatterClaudeCloudWelcome({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { serverConfig, found } = useWelcomeAgents(environmentId);
  const hasClaudeAccount = found.some(
    (provider) =>
      provider.driver === "claudeAgent" &&
      welcomeAgentState(provider, serverConfig?.settings) === "ready",
  );
  if (
    dismissed ||
    serverConfig === null ||
    !hasClaudeAccount ||
    (primaryEnvironmentId !== null && environmentId !== primaryEnvironmentId)
  ) {
    return null;
  }
  return (
    <ClaudeCloudWelcomeCard
      onDismiss={() => {
        writeDismissed();
        setDismissed(true);
      }}
    />
  );
}

// Mounted only when a Claude account is ready and the card has not been dismissed, so other
// onboarding paths never fetch add-on state.
function ClaudeCloudWelcomeCard({ onDismiss }: { readonly onDismiss: () => void }) {
  const gt = useGT();
  const m = useMessages();
  const { canWrite } = useAddonRegistry();
  const enabled = useIsAddonEnabled(CLAUDE_CLOUD_ADDON_ID);
  const config = useMatterApiConfig();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!enabled) return null;

  const choose = async (policy: ClaudeCloudOffloadPolicy) => {
    if (config === null || saving) return;
    setSaving(true);
    setError(null);
    const result = await settle(updateClaudeCloudSettings(config, { offloadPolicy: policy }));
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDismiss();
  };

  return (
    <WelcomeSection title={gt("Claude Cloud")}>
      <div className="flex flex-col gap-3 py-1 pl-8" data-claude-cloud-welcome="">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground">
              <T>Offload heavy work to Claude Cloud</T>
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              <T>
                Choose when agents move long builds and test suites to a cloud VM on your Claude
                plan.
              </T>
            </p>
          </div>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={saving}
            aria-label={gt("Dismiss Claude Cloud setup")}
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        <div
          className="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
          role="group"
          aria-label={gt("Offload presets")}
        >
          {CLAUDE_CLOUD_OFFLOAD_POLICY_ORDER.map((policy) => (
            <Button
              key={policy}
              type="button"
              variant="outline"
              size="multiline"
              disabled={!canWrite || config === null || saving}
              data-claude-cloud-preset={policy}
              className={cn(
                "h-auto w-full justify-start",
                policy === "balanced" && "sm:col-span-2",
              )}
              onClick={() => void choose(policy)}
            >
              <span className="flex w-full flex-col items-start gap-0.5 py-0.5 text-left font-normal">
                <span className="flex w-full items-center gap-1.5 font-medium text-foreground">
                  <span>{m(CLAUDE_CLOUD_OFFLOAD_POLICY_LABELS[policy])}</span>
                  {policy === "balanced" ? (
                    <Badge variant="info" size="sm">
                      <T>Recommended</T>
                    </Badge>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {m(CLAUDE_CLOUD_OFFLOAD_POLICY_HINTS[policy])}
                </span>
              </span>
            </Button>
          ))}
        </div>
        {error ? (
          <p className="text-xs text-destructive-foreground" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </WelcomeSection>
  );
}
