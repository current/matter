import {
  MATTER_ADDON_MANIFESTS,
  type AddonConfig,
  type AddonConfigResponse,
  type AddonEntry,
  type AddonId,
  type AddonListResponse,
  type AddonManifest,
  type AddonRuntimeStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { matterApiRequest, type MatterApiConfig } from "./matterApi";

/** Last enablement the server reported, so the first paint matches before the request returns. */
const CACHE_KEY = "mattr:addons:v1";
const LEGACY_ISLAND_SETTINGS_KEY = "mattr:island:settings:v1";

const AddonCache = Schema.Struct({ enabled: Schema.Record(Schema.String, Schema.Boolean) });

export interface AddonStoreState {
  readonly entries: ReadonlyArray<AddonEntry>;
  /** `local` until the server answers: entries come from the cache and manifest defaults. */
  readonly source: "local" | "server";
  readonly loading: boolean;
  readonly error: string | null;
  readonly pendingIds: ReadonlyArray<string>;
}

const readCache = (): Record<string, boolean> => {
  try {
    return getLocalStorageItem(CACHE_KEY, AddonCache)?.enabled ?? {};
  } catch {
    return {};
  }
};

const writeCache = (entries: ReadonlyArray<AddonEntry>) => {
  try {
    setLocalStorageItem(
      CACHE_KEY,
      {
        enabled: Object.fromEntries(
          entries.map((entry) => [entry.manifest.id, entry.state.enabled]),
        ),
      },
      AddonCache,
    );
  } catch {
    // Storage can be unavailable (private mode); the server stays the source of truth.
  }
};

/** The voice assistant shipped before add-ons; saved Island settings mean the user set it up. */
export function hasLegacyVoiceAssistantPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(LEGACY_ISLAND_SETTINGS_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "voiceAssistant" in parsed &&
      typeof parsed.voiceAssistant === "object" &&
      parsed.voiceAssistant !== null
    );
  } catch {
    return false;
  }
}

const localStatus = (manifest: AddonManifest, enabled: boolean): AddonRuntimeStatus =>
  !enabled
    ? { kind: "disabled" }
    : manifest.contributions.includes("bots-provider")
      ? { kind: "connecting" }
      : { kind: "connected" };

function localEntries(): ReadonlyArray<AddonEntry> {
  const cache = readCache();
  return MATTER_ADDON_MANIFESTS.map((manifest) => {
    const cached = cache[manifest.id];
    const legacy = manifest.id === "voice-assistant" && hasLegacyVoiceAssistantPreference();
    const enabled = cached ?? (legacy || manifest.defaultEnabled);
    return {
      manifest,
      state: {
        id: manifest.id,
        enabled,
        enablementSource: cached === undefined ? (legacy ? "migrated" : "default") : "user",
        updatedAt: null,
        status: localStatus(manifest, enabled),
      },
    };
  });
}

const initialState = (): AddonStoreState => ({
  entries: localEntries(),
  source: "local",
  loading: false,
  error: null,
  pendingIds: [],
});

let state: AddonStoreState = initialState();
const listeners = new Set<() => void>();

function emit(patch: Partial<AddonStoreState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getAddonStoreState(): AddonStoreState {
  return state;
}

export function subscribeAddonStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAddonStore(): AddonStoreState {
  return useSyncExternalStore(subscribeAddonStore, getAddonStoreState, getAddonStoreState);
}

export function isAddonEnabled(id: AddonId): boolean {
  return state.entries.some((entry) => entry.manifest.id === id && entry.state.enabled);
}

export function enabledBotProviderAddonIds(
  current: AddonStoreState = state,
): ReadonlyArray<string> {
  return current.entries
    .filter(
      (entry) => entry.state.enabled && entry.manifest.contributions.includes("bots-provider"),
    )
    .map((entry) => entry.manifest.id);
}

function applyServerResponse(response: AddonListResponse) {
  writeCache(response.addons);
  emit({ entries: response.addons, source: "server", error: null });
}

let inflight: Promise<void> | null = null;

export function loadAddons(config: MatterApiConfig): Promise<void> {
  if (inflight) return inflight;
  emit({ loading: true });
  inflight = (async () => {
    try {
      const response = await matterApiRequest<AddonListResponse>(config, "/api/mattr/addons");
      applyServerResponse(response);
      await migrateLegacyVoiceAssistant(config, response);
    } catch (error) {
      emit({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      inflight = null;
      emit({ loading: false });
    }
  })();
  return inflight;
}

async function migrateLegacyVoiceAssistant(config: MatterApiConfig, response: AddonListResponse) {
  const voice = response.addons.find((entry) => entry.manifest.id === "voice-assistant");
  if (!voice || voice.state.enablementSource !== "default" || voice.state.enabled) return;
  if (!hasLegacyVoiceAssistantPreference()) return;
  const migrated = await matterApiRequest<AddonListResponse>(config, "/api/mattr/addons/enabled", {
    method: "POST",
    body: { id: "voice-assistant", enabled: true, source: "migrated" },
  });
  applyServerResponse(migrated);
}

export async function setAddonEnabled(
  config: MatterApiConfig,
  id: AddonId,
  enabled: boolean,
): Promise<void> {
  const previous = state.entries;
  emit({
    pendingIds: [...state.pendingIds, id],
    entries: previous.map((entry) =>
      entry.manifest.id === id
        ? {
            ...entry,
            state: {
              ...entry.state,
              enabled,
              enablementSource: "user",
              status: localStatus(entry.manifest, enabled),
            },
          }
        : entry,
    ),
  });
  try {
    const response = await matterApiRequest<AddonListResponse>(
      config,
      "/api/mattr/addons/enabled",
      {
        method: "POST",
        body: { id, enabled, source: "user" },
      },
    );
    applyServerResponse(response);
  } catch (error) {
    emit({ entries: previous, error: error instanceof Error ? error.message : String(error) });
  } finally {
    emit({ pendingIds: state.pendingIds.filter((pendingId) => pendingId !== id) });
  }
}

/** Reconnects an enabled add-on now and applies the status it settles on. */
export async function reconnectAddon(config: MatterApiConfig, id: AddonId): Promise<void> {
  emit({ pendingIds: [...state.pendingIds, id] });
  try {
    applyServerResponse(
      await matterApiRequest<AddonListResponse>(config, "/api/mattr/addons/reconnect", {
        method: "POST",
        body: { id },
      }),
    );
  } catch (error) {
    emit({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    emit({ pendingIds: state.pendingIds.filter((pendingId) => pendingId !== id) });
  }
}

export async function getAddonConfig(
  config: MatterApiConfig,
  id: AddonId,
  signal?: AbortSignal,
): Promise<AddonConfig> {
  const response = await matterApiRequest<AddonConfigResponse>(
    config,
    `/api/mattr/addons/config?id=${encodeURIComponent(id)}`,
    signal ? { signal } : {},
  );
  return response.config;
}

/** Merges a patch into an add-on's non-secret config; a null value removes that key. */
export async function updateAddonConfig(
  config: MatterApiConfig,
  id: AddonId,
  patch: AddonConfig,
): Promise<AddonConfig> {
  const response = await matterApiRequest<AddonConfigResponse>(config, "/api/mattr/addons/config", {
    method: "POST",
    body: { id, config: patch },
  });
  return response.config;
}

export function resetAddonStoreForTests() {
  inflight = null;
  state = initialState();
  for (const listener of listeners) listener();
}
