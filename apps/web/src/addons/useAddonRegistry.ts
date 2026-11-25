import type { AddonId } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import {
  enabledBotProviderAddonIds,
  getAddonStoreState,
  isAddonEnabled,
  loadAddons,
  setAddonEnabled,
  subscribeAddonStore,
  useAddonStore,
} from "./addonStore";
import { useMattrApiConfig } from "./mattrApi";

/** Loads the registry from the primary environment once its connection is ready. */
function useAddonRegistryLoader() {
  const config = useMattrApiConfig();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the server's add-on registry when the primary connection becomes available or changes
  useEffect(() => {
    if (config === null) return;
    void loadAddons(config);
  }, [config]);
  return config;
}

export function useAddonRegistry() {
  const config = useAddonRegistryLoader();
  const state = useAddonStore();
  return {
    ...state,
    canWrite: config !== null,
    setEnabled: (id: AddonId, enabled: boolean) =>
      config === null ? Promise.resolve() : setAddonEnabled(config, id, enabled),
    reload: () => (config === null ? Promise.resolve() : loadAddons(config)),
  };
}

/** @public For gated surfaces that live outside this module, such as the Island and voice UI. */
export function useIsAddonEnabled(id: AddonId): boolean {
  return useSyncExternalStore(
    subscribeAddonStore,
    () => isAddonEnabled(id),
    () => isAddonEnabled(id),
  );
}

const selectBotProviderKey = () => enabledBotProviderAddonIds(getAddonStoreState()).join(",");

/** Enabled add-ons that provide Bots, kept in sync with the server. */
export function useEnabledBotProviderAddons(): ReadonlyArray<string> {
  useAddonRegistryLoader();
  const key = useSyncExternalStore(subscribeAddonStore, selectBotProviderKey, selectBotProviderKey);
  return key === "" ? [] : key.split(",");
}
