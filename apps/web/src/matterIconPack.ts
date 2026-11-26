import { useSyncExternalStore } from "react";

import {
  getIconPack,
  getIconPackState,
  subscribeIconPack,
} from "../../../antimatter/icons/iconPack";

/** The icon pack chosen on this device; every lucide-react icon in the app follows it live. */
export function useMattrIconPack() {
  return useSyncExternalStore(subscribeIconPack, getIconPack, getIconPack);
}

/** The whole icon pack store, including which lazy pack chunks have loaded. */
export function useMattrIconPackState() {
  return useSyncExternalStore(subscribeIconPack, getIconPackState, getIconPackState);
}
