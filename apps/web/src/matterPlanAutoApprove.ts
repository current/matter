import * as Schema from "effect/Schema";

import { useLocalStorage, writeLocalStorageValue } from "./hooks/useLocalStorage";

/** Matter: per-device opt-in that approves an actionable plan after a visible countdown. */
export const MATTER_PLAN_AUTO_APPROVE_STORAGE_KEY = "mattr:plan-auto-approve:v1";
export const DEFAULT_MATTER_PLAN_AUTO_APPROVE = false;
export const MATTER_PLAN_AUTO_APPROVE_SECONDS = 30;

export function writeMatterPlanAutoApprove(enabled: boolean): void {
  writeLocalStorageValue(
    MATTER_PLAN_AUTO_APPROVE_STORAGE_KEY,
    enabled,
    DEFAULT_MATTER_PLAN_AUTO_APPROVE,
    Schema.Boolean,
  );
}

export function useMatterPlanAutoApproveSetting() {
  return useLocalStorage(
    MATTER_PLAN_AUTO_APPROVE_STORAGE_KEY,
    DEFAULT_MATTER_PLAN_AUTO_APPROVE,
    Schema.Boolean,
  );
}
