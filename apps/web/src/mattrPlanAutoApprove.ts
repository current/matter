import * as Schema from "effect/Schema";

import { useLocalStorage, writeLocalStorageValue } from "./hooks/useLocalStorage";

/** mattr: per-device opt-in that approves an actionable plan after a visible countdown. */
export const MATTR_PLAN_AUTO_APPROVE_STORAGE_KEY = "mattr:plan-auto-approve:v1";
export const DEFAULT_MATTR_PLAN_AUTO_APPROVE = false;
export const MATTR_PLAN_AUTO_APPROVE_SECONDS = 30;

export function writeMattrPlanAutoApprove(enabled: boolean): void {
  writeLocalStorageValue(
    MATTR_PLAN_AUTO_APPROVE_STORAGE_KEY,
    enabled,
    DEFAULT_MATTR_PLAN_AUTO_APPROVE,
    Schema.Boolean,
  );
}

export function useMattrPlanAutoApproveSetting() {
  return useLocalStorage(
    MATTR_PLAN_AUTO_APPROVE_STORAGE_KEY,
    DEFAULT_MATTR_PLAN_AUTO_APPROVE,
    Schema.Boolean,
  );
}
