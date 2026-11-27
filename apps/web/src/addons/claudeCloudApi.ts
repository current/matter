import type {
  ClaudeCloudAddonSettings,
  ClaudeCloudEligibility,
  ClaudeCloudEligibilityRequest,
  ClaudeCloudFollowUpRequest,
  ClaudeCloudFollowUpResult,
  ClaudeCloudInterruptRequest,
  ClaudeCloudLaunchRequest,
  ClaudeCloudLaunchResult,
  ClaudeCloudRemoteSessionsResponse,
  ClaudeCloudSettingsPatch,
  ClaudeCloudStatus,
  ClaudeCloudTeleportRequest,
  ClaudeCloudTeleportResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { ClaudeCloudTranscriptResponse } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { type MatterApiConfig, matterApiRequest } from "./matterApi";

/** Client for `/api/mattr/claude-cloud/*`, plus the state of the global Claude Cloud dialog. */

const BASE = "/api/mattr/claude-cloud";

export function fetchClaudeCloudStatus(
  config: MatterApiConfig,
  options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<ClaudeCloudStatus> {
  return matterApiRequest<ClaudeCloudStatus>(
    config,
    `${BASE}/status${options.refresh ? "?refresh=1" : ""}`,
    options.signal ? { signal: options.signal } : {},
  );
}

export async function updateClaudeCloudSettings(
  config: MatterApiConfig,
  patch: ClaudeCloudSettingsPatch,
): Promise<ClaudeCloudAddonSettings> {
  const response = await matterApiRequest<{ readonly settings: ClaudeCloudAddonSettings }>(
    config,
    `${BASE}/settings`,
    { method: "POST", body: patch },
  );
  return response.settings;
}

export function checkClaudeCloudEligibility(
  config: MatterApiConfig,
  request: ClaudeCloudEligibilityRequest,
): Promise<ClaudeCloudEligibility> {
  return matterApiRequest(config, `${BASE}/eligibility`, { method: "POST", body: request });
}

export function launchClaudeCloudSession(
  config: MatterApiConfig,
  request: ClaudeCloudLaunchRequest,
): Promise<ClaudeCloudLaunchResult> {
  return matterApiRequest(config, `${BASE}/launch`, { method: "POST", body: request });
}

export function sendClaudeCloudFollowUp(
  config: MatterApiConfig,
  request: ClaudeCloudFollowUpRequest,
): Promise<ClaudeCloudFollowUpResult> {
  return matterApiRequest(config, `${BASE}/followup`, { method: "POST", body: request });
}

export function teleportClaudeCloudSession(
  config: MatterApiConfig,
  request: ClaudeCloudTeleportRequest,
): Promise<ClaudeCloudTeleportResult> {
  return matterApiRequest(config, `${BASE}/teleport`, { method: "POST", body: request });
}

export async function forgetClaudeCloudSession(
  config: MatterApiConfig,
  sessionId: string,
): Promise<void> {
  await matterApiRequest(config, `${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function fetchClaudeCloudRemoteSessions(
  config: MatterApiConfig,
  options: { readonly archived?: boolean; readonly signal?: AbortSignal } = {},
): Promise<ClaudeCloudRemoteSessionsResponse> {
  return matterApiRequest<ClaudeCloudRemoteSessionsResponse>(
    config,
    `${BASE}/remote-sessions${options.archived ? "?archived=1" : ""}`,
    options.signal ? { signal: options.signal } : {},
  );
}

const decodeTranscript = Schema.decodeUnknownSync(
  Schema.toCodecJson(ClaudeCloudTranscriptResponse),
);

/** Turn items carry DateTimes, so the response is decoded rather than cast. */
export async function fetchClaudeCloudTranscript(
  config: MatterApiConfig,
  sessionId: string,
  options: {
    readonly sinceRev?: number | null;
    readonly instanceId?: string | null;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ClaudeCloudTranscriptResponse> {
  const query = new URLSearchParams();
  if (options.sinceRev != null) query.set("sinceRev", String(options.sinceRev));
  if (options.instanceId) query.set("instanceId", options.instanceId);
  const search = query.size > 0 ? `?${query.toString()}` : "";
  const raw = await matterApiRequest<unknown>(
    config,
    `${BASE}/remote-sessions/${encodeURIComponent(sessionId)}/transcript${search}`,
    options.signal ? { signal: options.signal } : {},
  );
  return decodeTranscript(raw);
}

export async function interruptClaudeCloudSession(
  config: MatterApiConfig,
  request: ClaudeCloudInterruptRequest,
): Promise<void> {
  await matterApiRequest(config, `${BASE}/interrupt`, { method: "POST", body: request });
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
  readonly threadId: ThreadId | null;
  readonly instanceId: ProviderInstanceId | null;
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
  readonly threadId?: ThreadId | null;
  readonly instanceId?: ProviderInstanceId | null;
}): void {
  dialog = {
    mode: input.mode,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? "",
    threadId: input.threadId ?? null,
    instanceId: input.instanceId ?? null,
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
