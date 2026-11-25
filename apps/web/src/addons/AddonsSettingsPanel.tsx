import type { AddonEntry, AddonRuntimeStatusKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { ADDON_STATUS_LABELS, addonPresentation } from "./addonRegistry";
import { useAddonRegistry } from "./useAddonRegistry";

const STATUS_VARIANT: Readonly<
  Record<AddonRuntimeStatusKind, "outline" | "success" | "info" | "warning" | "error">
> = {
  disabled: "outline",
  enabled_unconfigured: "warning",
  app_unavailable: "warning",
  connecting: "info",
  connected: "success",
  disconnected: "warning",
  auth_required: "warning",
  incompatible_version: "warning",
  error: "error",
};

const ADDONS_PAGE = "/settings/addons";

/** Settings → Add-ons: turn optional features on or off. Off means no UI and no background work. */
export function AddonsSettingsPanel() {
  const gt = useGT();
  const registry = useAddonRegistry();
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="addons"
        title={gt("Add-ons")}
        headerAction={
          registry.source === "local" && registry.loading ? (
            <span className="text-xs text-muted-foreground" role="status">
              <T>Checking the server…</T>
            </span>
          ) : null
        }
      >
        {registry.entries.map((entry) => (
          <AddonRow
            key={entry.manifest.id}
            entry={entry}
            pending={registry.pendingIds.includes(entry.manifest.id)}
            canWrite={registry.canWrite}
            onToggle={(enabled) => void registry.setEnabled(entry.manifest.id, enabled)}
          />
        ))}
      </SettingsSection>
      {registry.error ? (
        <p className="px-3 text-sm text-destructive-foreground sm:px-4" role="alert">
          {gt("Could not reach the server's add-on settings: {error}", { error: registry.error })}
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}

function AddonRow({
  entry,
  pending,
  canWrite,
  onToggle,
}: {
  entry: AddonEntry;
  pending: boolean;
  canWrite: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { manifest, state } = entry;
  const presentation = addonPresentation(manifest);
  const title = m(presentation.title);
  const [configurePath, configureHash] = manifest.settingsRoute.split("#");
  const showConfigure =
    state.enabled && configurePath !== undefined && configurePath !== ADDONS_PAGE;
  return (
    <SettingsRow
      id={`addon-${manifest.id}`}
      title={
        <span className="inline-flex items-center gap-2">
          <presentation.Icon className="size-4 shrink-0 text-muted-foreground" />
          {title}
          {manifest.experimental ? (
            <Badge variant="outline" size="sm">
              <T>Experimental</T>
            </Badge>
          ) : null}
        </span>
      }
      description={
        <>
          {m(presentation.description)}
          {state.enabled && state.status.detail ? (
            <span className="mt-1 block text-muted-foreground">{state.status.detail}</span>
          ) : null}
        </>
      }
      status={
        <Badge variant={STATUS_VARIANT[state.status.kind]} size="sm" data-addon-status="">
          {m(ADDON_STATUS_LABELS[state.status.kind])}
        </Badge>
      }
      control={
        <div className="flex items-center gap-2">
          {showConfigure ? (
            <Button
              size="xs"
              variant="outline"
              render={
                <Link to={configurePath} {...(configureHash ? { hash: configureHash } : {})} />
              }
            >
              <T>Configure</T>
            </Button>
          ) : null}
          <Switch
            checked={state.enabled}
            disabled={pending || !canWrite}
            onCheckedChange={(checked) => onToggle(Boolean(checked))}
            aria-label={gt("Enable {name}", { name: title })}
          />
        </div>
      }
    />
  );
}
