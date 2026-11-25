import type {
  ClaudeCloudAddonSettings,
  ClaudeCloudEligibility,
  ClaudeCloudEligibilityRequest,
  ClaudeCloudFollowUpRequest,
  ClaudeCloudFollowUpResult,
  ClaudeCloudLaunchRequest,
  ClaudeCloudLaunchResult,
  ClaudeCloudSettingsPatch,
  ClaudeCloudStatus,
  ClaudeCloudTeleportRequest,
  ClaudeCloudTeleportResult,
  ProjectId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { type MattrApiConfig, mattrApiRequest } from "./mattrApi";

/** Client for `/api/mattr/claude-cloud/*`, plus the state of the global Claude Cloud dialog. */

const BASE = "/api/mattr/claude-cloud";

export function fetchClaudeCloudStatus(
  config: MattrApiConfig,
  options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<ClaudeCloudStatus> {
  return mattrApiRequest<ClaudeCloudStatus>(
    config,
    `${BASE}/status${options.refresh ? "?refresh=1" : ""}`,
    options.signal ? { signal: options.signal } : {},
  );
}

export async function updateClaudeCloudSettings(
  config: MattrApiConfig,
  patch: ClaudeCloudSettingsPatch,
): Promise<ClaudeCloudAddonSettings> {
  const response = await mattrApiRequest<{ readonly settings: ClaudeCloudAddonSettings }>(
    config,
    `${BASE}/settings`,
    { method: "POST", body: patch },
  );
  return response.settings;
}

export function checkClaudeCloudEligibility(
  config: MattrApiConfig,
  request: ClaudeCloudEligibilityRequest,
): Promise<ClaudeCloudEligibility> {
  return mattrApiRequest(config, `${BASE}/eligibility`, { method: "POST", body: request });
}

export function launchClaudeCloudSession(
  config: MattrApiConfig,
  request: ClaudeCloudLaunchRequest,
): Promise<ClaudeCloudLaunchResult> {
  return mattrApiRequest(config, `${BASE}/launch`, { method: "POST", body: request });
}

export function sendClaudeCloudFollowUp(
  config: MattrApiConfig,
  request: ClaudeCloudFollowUpRequest,
): Promise<ClaudeCloudFollowUpResult> {
  return mattrApiRequest(config, `${BASE}/followup`, { method: "POST", body: request });
}

export function teleportClaudeCloudSession(
  config: MattrApiConfig,
  request: ClaudeCloudTeleportRequest,
): Promise<ClaudeCloudTeleportResult> {
  return mattrApiRequest(config, `${BASE}/teleport`, { method: "POST", body: request });
}

export async function forgetClaudeCloudSession(
  config: MattrApiConfig,
  sessionId: string,
): Promise<void> {
  await mattrApiRequest(config, `${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

/** A request's value or its error text, so components need no try/finally (React Compiler). */
export async function settle<A>(
  request: Promise<A>,
): Promise<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }
> {
  try {
    return { ok: true, value: await request };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export type ClaudeCloudDialogMode = "launch" | "teleport" | "followup";

export interface ClaudeCloudDialogState {
  readonly mode: ClaudeCloudDialogMode;
  readonly projectId: ProjectId | null;
  readonly sessionId: string;
}

let dialog: ClaudeCloudDialogState | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function openClaudeCloudDialog(input: {
  readonly mode: ClaudeCloudDialogMode;
  readonly projectId?: ProjectId | null;
  readonly sessionId?: string;
}): void {
  dialog = {
    mode: input.mode,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? "",
  };
  emit();
}

export function closeClaudeCloudDialog(): void {
  dialog = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getDialog = () => dialog;

export function useClaudeCloudDialog(): ClaudeCloudDialogState | null {
  return useSyncExternalStore(subscribe, getDialog, getDialog);
}
