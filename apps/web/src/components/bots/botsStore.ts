import type {
  AddonRuntimeStatus,
  BotEvent,
  BotIdentity,
  BotListResponse,
  BotPendingRequest,
  BotPendingRequestsResponse,
  BotProviderDescriptor,
  BotProvidersResponse,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { getAddonStoreState, reconnectAddon } from "../../addons/addonStore";
import { mattrApiRequest, mattrFetchCredentials, type MattrApiConfig } from "../../addons/mattrApi";

export interface BotsState {
  readonly providers: ReadonlyArray<BotProviderDescriptor>;
  readonly botsByProvider: Readonly<Record<string, ReadonlyArray<BotIdentity>>>;
  readonly pending: ReadonlyArray<BotPendingRequest>;
  readonly loaded: boolean;
  readonly error: string | null;
}

const EMPTY: BotsState = {
  providers: [],
  botsByProvider: {},
  pending: [],
  loaded: false,
  error: null,
};

let state: BotsState = EMPTY;
const listeners = new Set<() => void>();
const eventListeners = new Set<(event: BotEvent) => void>();

function emit(next: BotsState) {
  state = next;
  for (const listener of listeners) listener();
}

function getBotsState(): BotsState {
  return state;
}

function subscribeBots(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBotsState(): BotsState {
  return useSyncExternalStore(subscribeBots, getBotsState, getBotsState);
}

/** Raw events, for views that track one conversation. */
export function subscribeBotEvents(listener: (event: BotEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function applyBotEvent(current: BotsState, event: BotEvent): BotsState {
  switch (event.type) {
    case "provider-status":
      return {
        ...current,
        providers: current.providers.map((provider) =>
          provider.providerId === event.providerId
            ? { ...provider, status: event.status }
            : provider,
        ),
      };
    case "bots-changed":
      return {
        ...current,
        botsByProvider: { ...current.botsByProvider, [event.providerId]: event.bots },
      };
    case "activity": {
      const bots = current.botsByProvider[event.providerId];
      if (!bots) return current;
      return {
        ...current,
        botsByProvider: {
          ...current.botsByProvider,
          [event.providerId]: bots.map((bot) =>
            bot.remoteBotId === event.botId ? { ...bot, status: event.state } : bot,
          ),
        },
      };
    }
    case "pending-request":
      return {
        ...current,
        pending: [
          ...current.pending.filter(
            (request) =>
              request.providerId !== event.request.providerId ||
              request.requestId !== event.request.requestId,
          ),
          event.request,
        ],
      };
    case "pending-request-resolved":
      return {
        ...current,
        pending: current.pending.filter(
          (request) =>
            request.providerId !== event.providerId || request.requestId !== event.requestId,
        ),
      };
    default:
      return current;
  }
}

async function loadSnapshot(config: MattrApiConfig, signal: AbortSignal) {
  const { providers } = await mattrApiRequest<BotProvidersResponse>(
    config,
    "/api/mattr/bots/providers",
    { signal },
  );
  const lists = await Promise.all(
    providers.map(async (provider) => {
      if (provider.status.kind !== "connected") return [provider.providerId, []] as const;
      const response = await mattrApiRequest<BotListResponse>(
        config,
        `/api/mattr/bots/bots?providerId=${encodeURIComponent(provider.providerId)}`,
        { signal },
      ).catch((): BotListResponse => ({ bots: [] }));
      return [provider.providerId, response.bots] as const;
    }),
  );
  const { requests } = await mattrApiRequest<BotPendingRequestsResponse>(
    config,
    "/api/mattr/bots/pending",
    { signal },
  );
  emit({
    providers,
    botsByProvider: Object.fromEntries(lists),
    pending: requests,
    loaded: true,
    error: null,
  });
}

/** Reads server-sent events from a fetch body, since EventSource can't send auth headers. */
async function readEventStream(config: MattrApiConfig, signal: AbortSignal) {
  const response = await fetch(`${config.baseUrl}/api/mattr/bots/events`, {
    headers: { ...config.headers, accept: "text/event-stream" },
    credentials: mattrFetchCredentials(config.headers),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`events_${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (!data) continue;
      const event = JSON.parse(data) as BotEvent;
      // A provider that changed state may now list different Bots.
      if (event.type === "provider-status" && event.status.kind === "connected") {
        void loadSnapshot(config, signal).catch(() => undefined);
      }
      emit(applyBotEvent(state, event));
      for (const listener of eventListeners) listener(event);
    }
  }
}

const MAX_RECONNECT_MS = 60_000;

let retainers = 0;
let controller: AbortController | null = null;

/**
 * Keeps Bots in sync while at least one view needs them. Only mounted when a Bots add-on is
 * enabled, so a workspace without one opens no stream and sends no requests.
 */
export function retainBotsSync(config: MattrApiConfig): () => void {
  retainers += 1;
  if (retainers === 1) {
    const current = new AbortController();
    controller = current;
    void (async () => {
      let failures = 0;
      while (!current.signal.aborted) {
        try {
          await loadSnapshot(config, current.signal);
          failures = 0;
          await readEventStream(config, current.signal);
        } catch (error) {
          if (current.signal.aborted) return;
          emit({ ...state, error: error instanceof Error ? error.message : String(error) });
        }
        failures += 1;
        const delay = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** Math.min(failures, 6));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
  }
  return () => {
    retainers = Math.max(0, retainers - 1);
    if (retainers === 0) {
      controller?.abort();
      controller = null;
      emit(EMPTY);
    }
  };
}

/**
 * Asks the server to reconnect a provider's add-on and applies the status it settles on, so the
 * page updates even before the event stream reports it. Returns that status, or null when the
 * request failed.
 */
export async function reconnectBotProvider(
  config: MattrApiConfig,
  provider: Pick<BotProviderDescriptor, "providerId" | "addonId">,
): Promise<AddonRuntimeStatus | null> {
  await reconnectAddon(config, provider.addonId);
  const addons = getAddonStoreState();
  const entry = addons.entries.find((candidate) => candidate.manifest.id === provider.addonId);
  if (addons.error !== null || !entry) return null;
  const status = entry.state.status;
  emit(applyBotEvent(state, { type: "provider-status", providerId: provider.providerId, status }));
  if (status.kind === "connected" && controller !== null) {
    void loadSnapshot(config, controller.signal).catch(() => undefined);
  }
  return status;
}

export function findBot(
  current: BotsState,
  providerId: string,
  botId: string,
): BotIdentity | undefined {
  return current.botsByProvider[providerId]?.find((bot) => bot.remoteBotId === botId);
}

export function resetBotsStoreForTests() {
  controller?.abort();
  controller = null;
  retainers = 0;
  state = EMPTY;
}
