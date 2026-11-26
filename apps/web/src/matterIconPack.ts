import { useSyncExternalStore } from "react";

import { getIconPack, getIconPackState, subscribeIconPack } from "../../../matter/icons/iconPack";

/** The icon pack chosen on this device; every lucide-react icon in the app follows it live. */
export function useMatterIconPack() {
  return useSyncExternalStore(subscribeIconPack, getIconPack, getIconPack);
}

/** The whole icon pack store, including which lazy pack chunks have loaded. */
export function useMatterIconPackState() {
  return useSyncExternalStore(subscribeIconPack, getIconPackState, getIconPackState);
}
