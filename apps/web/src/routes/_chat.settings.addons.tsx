import { createFileRoute } from "@tanstack/react-router";

import { AddonsSettingsPanel } from "../addons/AddonsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/addons")({
  component: AddonsSettingsPanel,
});
