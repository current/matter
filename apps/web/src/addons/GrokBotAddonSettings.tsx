import {
  GROK_BOT_CDP_PORT_CONFIG_KEY,
  GROK_BOT_DEFAULT_CDP_PORT,
  grokBotCdpPortFromConfig,
  grokBotLaunchCommand,
  type AddonRuntimeStatus,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import { ADDON_STATUS_LABELS } from "./addonRegistry";
import { getAddonConfig, updateAddonConfig } from "./addonStore";
import { useMattrApiConfig } from "./mattrApi";

const parsePort = (raw: string) => {
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
};

const STATUS_DOT: Readonly<Partial<Record<AddonRuntimeStatus["kind"], string>>> = {
  connected: "bg-success",
  connecting: "bg-info",
  error: "bg-destructive",
};

/**
 * Grok Bot's connection card in Settings → Add-ons: the live connection, the loopback debug port,
 * the command that reopens Grok Bot with it, and a connection test. mattr never launches or
 * restarts Grok Bot.
 */
export function GrokBotAddonSettings({
  status,
  busy,
  canWrite,
  onReconnect,
}: {
  status: AddonRuntimeStatus;
  busy: boolean;
  canWrite: boolean;
  onReconnect: () => Promise<void>;
}) {
  const gt = useGT();
  const m = useMessages();
  const config = useMattrApiConfig();
  const [savedPort, setSavedPort] = useState(GROK_BOT_DEFAULT_CDP_PORT);
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the saved debug port from the server's add-on config
  useEffect(() => {
    if (config === null) return;
    const controller = new AbortController();
    void getAddonConfig(config, "grok-bot", controller.signal)
      .then((saved) => setSavedPort(grokBotCdpPortFromConfig(saved)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [config]);

  const portText = draft ?? String(savedPort);
  const port = parsePort(portText);
  const command = grokBotLaunchCommand(port ?? savedPort);
  const connected = status.kind === "connected";
  const showCommand = status.kind === "enabled_unconfigured" || status.kind === "disconnected";

  const testConnection = async () => {
    if (config === null || port === null) return;
    setSaveError(null);
    setTested(false);
    if (port !== savedPort) {
      try {
        const saved = await updateAddonConfig(config, "grok-bot", {
          [GROK_BOT_CDP_PORT_CONFIG_KEY]: port === GROK_BOT_DEFAULT_CDP_PORT ? null : port,
        });
        setSavedPort(grokBotCdpPortFromConfig(saved));
        setDraft(null);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    await onReconnect();
    setTested(true);
  };

  const statusText = busy
    ? gt("Testing the connection…")
    : connected
      ? (status.detail ?? gt("Grok Bot is ready."))
      : status.kind === "connecting"
        ? gt("Connecting to Grok Bot…")
        : status.kind === "app_unavailable"
          ? gt("Install Grok Bot on this Mac, then test the connection.")
          : status.kind === "enabled_unconfigured"
            ? gt("Grok Bot is installed but its debug port isn't open.")
            : (status.detail ?? m(ADDON_STATUS_LABELS[status.kind]));

  return (
    <div className="flex flex-col gap-3 pb-3 text-sm" data-grok-bot-settings="">
      <p
        role="status"
        data-grok-bot-status={status.kind}
        className={cn("flex min-w-0 items-center gap-2", "text-muted-foreground")}
      >
        {busy ? (
          <Spinner size="xs" aria-hidden="true" />
        ) : connected ? null : (
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATUS_DOT[status.kind] ?? "bg-warning",
            )}
          />
        )}
        <span className="min-w-0">{statusText}</span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            <T>Debug port</T>
          </span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={65_535}
            size="sm"
            className="w-28"
            value={portText}
            disabled={!canWrite}
            aria-invalid={port === null}
            onChange={(event) => {
              setDraft(event.target.value);
              setTested(false);
            }}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || busy || port === null}
          onClick={() => void testConnection()}
        >
          {busy ? <Spinner size="xs" aria-hidden="true" /> : null}
          {busy ? (
            <T>Testing…</T>
          ) : port !== null && port !== savedPort ? (
            <T>Save and test</T>
          ) : (
            <T>Test connection</T>
          )}
        </Button>
      </div>
      {tested && !busy ? (
        connected ? (
          <p className="text-xs text-success-foreground" data-grok-bot-test-result="ok">
            <T>Connection works.</T>
          </p>
        ) : (
          <p
            className="text-xs text-destructive-foreground"
            role="alert"
            data-grok-bot-test-result="failed"
          >
            <T>
              Couldn't connect. Check that Grok Bot is open with its debug port, then try again.
            </T>
          </p>
        )
      ) : null}
      {port === null ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          <T>Enter a port from 1 to 65535.</T>
        </p>
      ) : null}
      {saveError ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {saveError}
        </p>
      ) : null}
      {showCommand ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground">
            <T>
              Quit Grok Bot, run this in Terminal to reopen it with its debug port, then test the
              connection:
            </T>
          </p>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 ps-3 pe-1">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" data-grok-bot-command="">
              {command}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={isCopied ? gt("Copied") : gt("Copy command")}
              onClick={() => copyToClipboard(command, undefined)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
