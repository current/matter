import { useGT } from "gt-react";

import {
  DEFAULT_MATTR_PLAN_AUTO_APPROVE,
  MATTR_PLAN_AUTO_APPROVE_SECONDS,
  useMattrPlanAutoApproveSetting,
} from "../../mattrPlanAutoApprove";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/** mattr: Settings → Chat → Follow-ups row for the Plan Overview card's auto-approve. */
export function MattrPlanAutoApproveSetting() {
  const gt = useGT();
  const [enabled, setEnabled] = useMattrPlanAutoApproveSetting();
  return (
    <SettingsRow
      id="mattr-plan-auto-approve"
      title={gt("Auto-approve plans")}
      description={gt(
        "Start implementing a proposed plan after a {seconds}-second countdown. Click the countdown to cancel it.",
        { seconds: MATTR_PLAN_AUTO_APPROVE_SECONDS },
      )}
      devicePreference
      resetAction={
        enabled !== DEFAULT_MATTR_PLAN_AUTO_APPROVE ? (
          <SettingResetButton
            ariaLabel={gt("Reset auto-approve plans to default")}
            onClick={() => setEnabled(DEFAULT_MATTR_PLAN_AUTO_APPROVE)}
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(Boolean(checked))}
          aria-label={gt("Auto-approve plans")}
        />
      }
    />
  );
}
