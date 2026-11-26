import { useGT } from "gt-react";

import {
  DEFAULT_MATTER_PLAN_AUTO_APPROVE,
  MATTER_PLAN_AUTO_APPROVE_SECONDS,
  useMatterPlanAutoApproveSetting,
} from "../../matterPlanAutoApprove";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/** Matter: Settings → Chat → Follow-ups row for the Plan Overview card's auto-approve. */
export function MatterPlanAutoApproveSetting() {
  const gt = useGT();
  const [enabled, setEnabled] = useMatterPlanAutoApproveSetting();
  return (
    <SettingsRow
      id="matter-plan-auto-approve"
      title={gt("Auto-approve plans")}
      description={gt(
        "Start implementing a proposed plan after a {seconds}-second countdown. Click the countdown to cancel it.",
        { seconds: MATTER_PLAN_AUTO_APPROVE_SECONDS },
      )}
      devicePreference
      resetAction={
        enabled !== DEFAULT_MATTER_PLAN_AUTO_APPROVE ? (
          <SettingResetButton
            ariaLabel={gt("Reset auto-approve plans to default")}
            onClick={() => setEnabled(DEFAULT_MATTER_PLAN_AUTO_APPROVE)}
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
