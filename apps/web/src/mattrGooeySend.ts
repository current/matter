import * as Schema from "effect/Schema";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "./hooks/useLocalStorage";

export const MATTR_GOOEY_SEND_STORAGE_KEY = "mattr:composer:gooey-send:v1";
export const DEFAULT_MATTR_GOOEY_SEND = true;

export function readMattrGooeySend(): boolean {
  return readLocalStorageValue(
    MATTR_GOOEY_SEND_STORAGE_KEY,
    DEFAULT_MATTR_GOOEY_SEND,
    Schema.Boolean,
  );
}

export function writeMattrGooeySend(enabled: boolean): void {
  writeLocalStorageValue(
    MATTR_GOOEY_SEND_STORAGE_KEY,
    enabled,
    DEFAULT_MATTR_GOOEY_SEND,
    Schema.Boolean,
  );
}

export function useMattrGooeySendSetting() {
  return useLocalStorage(MATTR_GOOEY_SEND_STORAGE_KEY, DEFAULT_MATTR_GOOEY_SEND, Schema.Boolean);
}
