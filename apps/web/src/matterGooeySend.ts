import * as Schema from "effect/Schema";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "./hooks/useLocalStorage";

export const MATTER_GOOEY_SEND_STORAGE_KEY = "mattr:composer:gooey-send:v1";
export const DEFAULT_MATTER_GOOEY_SEND = true;

export function readMatterGooeySend(): boolean {
  return readLocalStorageValue(
    MATTER_GOOEY_SEND_STORAGE_KEY,
    DEFAULT_MATTER_GOOEY_SEND,
    Schema.Boolean,
  );
}

export function writeMatterGooeySend(enabled: boolean): void {
  writeLocalStorageValue(
    MATTER_GOOEY_SEND_STORAGE_KEY,
    enabled,
    DEFAULT_MATTER_GOOEY_SEND,
    Schema.Boolean,
  );
}

export function useMatterGooeySendSetting() {
  return useLocalStorage(MATTER_GOOEY_SEND_STORAGE_KEY, DEFAULT_MATTER_GOOEY_SEND, Schema.Boolean);
}
