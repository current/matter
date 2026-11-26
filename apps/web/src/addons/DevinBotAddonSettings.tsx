import {
  DEVIN_BOT_CDP_PORT_CONFIG_KEY,
  DEVIN_BOT_DEFAULT_CDP_PORT,
  devinBotCdpPortFromConfig,
  devinBotLaunchCommand,
  type AddonRuntimeStatus,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { getAddonConfig, updateAddonConfig } from "./addonStore";
import { useMatterApiConfig } from "./matterApi";

const parsePort = (raw: string) => {
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
};

/**
 * Devin Bot's connection card in Settings → Add-ons: the loopback debug port, the command that
 * reopens Devin with it, and a connection test. Matter never launches or restarts Devin.
 */
export function DevinBotAddonSettings({
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
  const config = useMatterApiConfig();
  const [savedPort, setSavedPort] = useState(DEVIN_BOT_DEFAULT_CDP_PORT);
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the saved debug port from the server's add-on config
  useEffect(() => {
    if (config === null) return;
    const controller = new AbortController();
    void getAddonConfig(config, "devin-bot", controller.signal)
      .then((saved) => setSavedPort(devinBotCdpPortFromConfig(saved)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [config]);

  const portText = draft ?? String(savedPort);
  const port = parsePort(portText);
  const command = devinBotLaunchCommand(port ?? savedPort);

  const testConnection = async () => {
    if (config === null || port === null) return;
    setSaveError(null);
    if (port !== savedPort) {
      try {
        const saved = await updateAddonConfig(config, "devin-bot", {
          [DEVIN_BOT_CDP_PORT_CONFIG_KEY]: port === DEVIN_BOT_DEFAULT_CDP_PORT ? null : port,
        });
        setSavedPort(devinBotCdpPortFromConfig(saved));
        setDraft(null);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    await onReconnect();
  };

  return (
    <div className="flex flex-col gap-3 text-sm" data-devin-bot-settings="">
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
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <Button
          size="xs"
          variant="outline"
          disabled={!canWrite || busy || port === null}
          onClick={() => void testConnection()}
        >
          {busy ? <T>Testing…</T> : <T>Test connection</T>}
        </Button>
      </div>
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
      {status.kind === "app_unavailable" ? (
        <p className="text-muted-foreground">
          <T>Install Devin on this Mac, then test the connection.</T>
        </p>
      ) : status.kind !== "connected" ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground">
            {status.kind === "enabled_unconfigured" ? (
              <T>
                Devin is installed but its debug port isn't open. Quit Devin, run this in Terminal,
                then test the connection:
              </T>
            ) : (
              <T>Start Devin with its debug port open by running this in Terminal:</T>
            )}
          </p>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 ps-3 pe-1">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" data-devin-bot-command="">
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
          {status.kind !== "enabled_unconfigured" &&
          status.kind !== "connecting" &&
          status.detail ? (
            <p className="text-muted-foreground">{status.detail}</p>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <T>
          Matter never opens, quits or restarts Devin. It only connects to the debug port on this
          Mac while Devin is running, and uses Devin's own signed-in session.
        </T>
      </p>
      <Alert variant="warning" data-devin-bot-warning="">
        <ShieldAlertIcon />
        <AlertDescription>
          <T>
            While the debug port is open, any app running as your user on this Mac can control
            Devin's window, including your signed-in session. Only open it on a Mac you trust, and
            quit Devin to close it.
          </T>
        </AlertDescription>
      </Alert>
    </div>
  );
}
