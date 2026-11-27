import type {
  ClaudeCloudAccountStatus,
  ClaudeCloudAddonSettings as ClaudeCloudSettingsValue,
  ClaudeCloudOffloadAdvice,
  ClaudeCloudOffloadPolicy,
  ClaudeCloudSettingsPatch,
  ClaudeCloudStatus,
  TrackedClaudeCloudSession,
} from "@t3tools/contracts";
import {
  CLAUDE_CLOUD_DELEGATION_RULES_MAX_LENGTH,
  ClaudeCloudOffloadPolicy as OffloadPolicySchema,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import {
  fetchClaudeCloudStatus,
  forgetClaudeCloudSession,
  openClaudeCloudDialog,
  settle,
  updateClaudeCloudSettings,
} from "./claudeCloudApi";
import { useMatterApiConfig } from "./matterApi";

const AUTOMATIC_ACCOUNT = "__automatic__";
const OFFLOAD_POLICY_ORDER: ReadonlyArray<ClaudeCloudOffloadPolicy> = [
  "balanced",
  "battery_saver",
  "cloud_first",
  "ask",
  "off",
];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Claude Cloud's card in Settings → Add-ons: account readiness, which account runs cloud
 * sessions, when agents offload heavy work, the user's rules for them, and the tracked sessions.
 */
export function ClaudeCloudAddonSettings({ canWrite }: { canWrite: boolean }) {
  const gt = useGT();
  const config = useMatterApiConfig();
  const [status, setStatus] = useState<ClaudeCloudStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rulesDraft, setRulesDraft] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the add-on's settings and tracked sessions from the server; it never probes the CLI
  useEffect(() => {
    if (config === null) return;
    const controller = new AbortController();
    void fetchClaudeCloudStatus(config, { signal: controller.signal })
      .then(setStatus)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorText(cause));
      });
    return () => controller.abort();
  }, [config]);

  if (status === null) {
    return error ? (
      <p className="text-xs text-destructive-foreground" role="alert">
        {error}
      </p>
    ) : (
      <p className="text-xs text-muted-foreground" role="status">
        <T>Loading Claude Cloud…</T>
      </p>
    );
  }

  const settings = status.settings;
  const rules = rulesDraft ?? settings.delegationRules;

  const refresh = async () => {
    if (config === null) return;
    setRefreshing(true);
    setError(null);
    const result = await settle(fetchClaudeCloudStatus(config, { refresh: true }));
    if (result.ok) setStatus(result.value);
    else setError(result.error);
    setRefreshing(false);
  };

  const save = async (patch: ClaudeCloudSettingsPatch) => {
    if (config === null) return;
    setSaving(true);
    setError(null);
    const result = await settle(updateClaudeCloudSettings(config, patch));
    if (result.ok) {
      const next: ClaudeCloudSettingsValue = result.value;
      setStatus((current) => (current === null ? current : { ...current, settings: next }));
      // The advice depends on the policy, so re-read it from the server.
      if (patch.offloadPolicy !== undefined) {
        void settle(fetchClaudeCloudStatus(config)).then((fresh) => {
          if (fresh.ok) setStatus(fresh.value);
        });
      }
      if (patch.delegationRules !== undefined) setRulesDraft(null);
    } else {
      setError(result.error);
    }
    setSaving(false);
  };

  const forget = async (session: TrackedClaudeCloudSession) => {
    if (config === null) return;
    setError(null);
    const result = await settle(forgetClaudeCloudSession(config, session.id));
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStatus((current) =>
      current === null
        ? current
        : { ...current, sessions: current.sessions.filter((entry) => entry.id !== session.id) },
    );
  };

  const policyLabels: Record<ClaudeCloudOffloadPolicy, string> = {
    balanced: gt("Balanced", { $context: "Claude Cloud offload policy" }),
    battery_saver: gt("Battery saver", { $context: "Claude Cloud offload policy" }),
    cloud_first: gt("Cloud first", { $context: "Claude Cloud offload policy" }),
    ask: gt("Ask first", { $context: "agents ask before offloading to Claude Cloud" }),
    off: gt("Manual only", { $context: "only the user launches Claude Cloud sessions" }),
  };
  const policyHints: Record<ClaudeCloudOffloadPolicy, string> = {
    balanced: gt("Long jobs, plus the rest on battery"),
    battery_saver: gt("Only on battery or when hot"),
    cloud_first: gt("All heavy work"),
    ask: gt("Agents ask you each time"),
    off: gt("Only when you send it"),
  };
  const policyDescriptions: Record<ClaudeCloudOffloadPolicy, string> = {
    balanced: gt(
      "Long builds and test suites run in the cloud. Other heavy work moves there on battery or when this machine runs hot.",
    ),
    battery_saver: gt(
      "Heavy work runs in the cloud on battery or when this machine runs hot, and stays here while plugged in.",
    ),
    cloud_first: gt("Heavy work runs in the cloud whenever it can."),
    ask: gt("Agents ask you before moving work to the cloud."),
    off: gt("Agents never offload. You can still send work to the cloud yourself."),
  };
  const accountLabel = (instanceId: string) =>
    status.instances.find((instance) => instance.instanceId === instanceId)?.displayName ??
    instanceId;
  const selectedAccount = settings.defaultInstanceId ?? AUTOMATIC_ACCOUNT;
  const disabled = !canWrite || saving;

  return (
    <div className="flex flex-col gap-4 text-sm" data-claude-cloud-settings="">
      <section className="flex flex-col gap-2" aria-label={gt("Claude accounts")}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            <T>Claude accounts</T>
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={!canWrite || refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? <T>Checking…</T> : <T>Refresh</T>}
          </Button>
        </div>
        {status.instances.length === 0 ? (
          <p className="text-muted-foreground">
            <T>No Claude instance is set up. Add one under Providers.</T>
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {status.instances.map((instance) => (
              <AccountRow
                key={instance.instanceId}
                displayName={instance.displayName}
                account={status.accounts.find(
                  (account) => account.instanceId === instance.instanceId,
                )}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1.5" data-claude-cloud-offload="">
        <span className="text-xs text-muted-foreground">
          <T>Offload heavy work</T>
        </span>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <Select
            value={settings.offloadPolicy}
            disabled={disabled}
            onValueChange={(value) => {
              if (OffloadPolicySchema.literals.includes(value as ClaudeCloudOffloadPolicy)) {
                void save({ offloadPolicy: value as ClaudeCloudOffloadPolicy });
              }
            }}
          >
            <SelectTrigger size="sm" className="sm:w-56" aria-label={gt("Offload heavy work")}>
              <SelectValue>{policyLabels[settings.offloadPolicy]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {OFFLOAD_POLICY_ORDER.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  <span className="flex flex-col py-0.5">
                    <span>{policyLabels[policy]}</span>
                    <span className="text-xs text-muted-foreground">{policyHints[policy]}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {status.advice === undefined || settings.offloadPolicy === "off" ? null : (
            <OffloadAdviceLine advice={status.advice} />
          )}
        </div>
        <p className="max-w-prose text-xs text-muted-foreground">
          {policyDescriptions[settings.offloadPolicy]}
        </p>
      </section>
      <label className="flex flex-col gap-1 sm:w-56">
        <span className="text-xs text-muted-foreground">
          <T>Account for cloud sessions</T>
        </span>
        <Select
          value={selectedAccount}
          disabled={disabled}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            void save({
              defaultInstanceId:
                value === AUTOMATIC_ACCOUNT
                  ? null
                  : (value as ClaudeCloudSettingsValue["defaultInstanceId"]),
            });
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Account for cloud sessions")}>
            <SelectValue>
              {selectedAccount === AUTOMATIC_ACCOUNT
                ? gt("First ready account")
                : accountLabel(selectedAccount)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={AUTOMATIC_ACCOUNT}>{gt("First ready account")}</SelectItem>
            {status.instances.map((instance) => (
              <SelectItem key={instance.instanceId} value={instance.instanceId}>
                {instance.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>

      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            <T>Custom delegation rules</T>
          </span>
          <Textarea
            size="sm"
            value={rules}
            maxLength={CLAUDE_CLOUD_DELEGATION_RULES_MAX_LENGTH}
            disabled={disabled || settings.offloadPolicy === "off"}
            placeholder={gt("Example: Only offload test suites that take over five minutes.")}
            onChange={(event) => setRulesDraft(event.target.value)}
          />
        </label>
        <span className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            <T>Agents see these rules and must give a reason that fits them.</T>
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || rulesDraft === null || rulesDraft === settings.delegationRules}
            onClick={() => void save({ delegationRules: rules.trim() })}
          >
            <T>Save rules</T>
          </Button>
        </span>
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span>
            <T>Push before launching</T>
          </span>
          <span className="text-xs text-muted-foreground">
            <T>Cloud sessions clone from GitHub, so unpushed commits are pushed first.</T>
          </span>
        </span>
        <Switch
          checked={settings.autoPushBeforeLaunch}
          disabled={disabled}
          onCheckedChange={(checked) => void save({ autoPushBeforeLaunch: Boolean(checked) })}
          aria-label={gt("Push before launching")}
        />
      </label>

      <section className="flex flex-col gap-2" aria-label={gt("Cloud sessions")}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            <T>Cloud sessions</T>
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={!canWrite}
            onClick={() => openClaudeCloudDialog({ mode: "launch" })}
          >
            <T>Send to Claude Cloud…</T>
          </Button>
        </div>
        {status.sessions.length === 0 ? (
          <p className="text-muted-foreground">
            <T>No cloud sessions yet.</T>
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {status.sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-col gap-1.5 rounded-lg border px-3 py-2"
                data-claude-cloud-session={session.id}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{session.title}</span>
                  {session.createdBy === "agent" ? (
                    <Badge variant="info" size="sm">
                      <T>By an agent</T>
                    </Badge>
                  ) : null}
                </div>
                {session.lastReplyPreview ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {session.lastReplyPreview}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    render={<a href={session.url} target="_blank" rel="noreferrer" />}
                  >
                    <ExternalLinkIcon />
                    <T>Open in claude.ai</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canWrite}
                    onClick={() =>
                      openClaudeCloudDialog({ mode: "followup", sessionId: session.id })
                    }
                  >
                    <T>Send follow-up</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canWrite}
                    onClick={() =>
                      openClaudeCloudDialog({
                        mode: "teleport",
                        sessionId: session.id,
                        projectId: session.projectId,
                      })
                    }
                  >
                    {session.teleportedThreadId ? (
                      <T>Pull again to a local worktree</T>
                    ) : (
                      <T>Pull to local worktree</T>
                    )}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost-destructive"
                    disabled={!canWrite}
                    onClick={() => void forget(session)}
                  >
                    <T>Remove</T>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AccountRow({
  displayName,
  account,
}: {
  displayName: string;
  account: ClaudeCloudAccountStatus | undefined;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2" data-claude-cloud-account="">
      <span className="min-w-0 flex-1 truncate">{displayName}</span>
      {account === undefined ? (
        <Badge variant="outline" size="sm">
          <T>Not checked</T>
        </Badge>
      ) : account.ready ? (
        <Badge variant="success" size="sm">
          {account.planTier ? (
            <T>
              Ready · <Var>{account.planTier}</Var>
            </T>
          ) : (
            <T>Ready</T>
          )}
        </Badge>
      ) : (
        <Badge variant="warning" size="sm" title={account.detail}>
          {account.problem === "signed_out" ? (
            <T>Signed out</T>
          ) : account.problem === "cli_unavailable" ? (
            <T>Claude CLI not found</T>
          ) : account.problem === "api_key_auth" || account.problem === "not_claude_ai" ? (
            <T>Needs a claude.ai login</T>
          ) : (
            <T>Not ready</T>
          )}
        </Badge>
      )}
    </li>
  );
}

function OffloadAdviceLine({ advice }: { advice: ClaudeCloudOffloadAdvice }) {
  const reasons = advice.reasons.join(" · ");
  return (
    <p
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      data-claude-cloud-advice={advice.level}
    >
      <span className="text-muted-foreground">
        <T>Right now</T>
      </span>
      {advice.level === "prefer_cloud" ? (
        <Badge variant="info" size="sm">
          <T>Prefers cloud</T>
        </Badge>
      ) : advice.level === "cloud_ok" ? (
        <Badge variant="info" size="sm">
          <T>Cloud for long jobs</T>
        </Badge>
      ) : advice.level === "prefer_local" ? (
        <Badge variant="outline" size="sm">
          <T>Stays local</T>
        </Badge>
      ) : (
        <Badge variant="warning" size="sm">
          <T>Unavailable</T>
        </Badge>
      )}
      {reasons === "" ? null : <span className="text-muted-foreground">{reasons}</span>}
    </p>
  );
}
