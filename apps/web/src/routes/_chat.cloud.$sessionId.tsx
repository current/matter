import { CLAUDE_CLOUD_ADDON_ID } from "@t3tools/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { useIsAddonEnabled } from "../addons/useAddonRegistry";
import { ClaudeCloudSessionView } from "../components/cloud/ClaudeCloudSessionView";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

interface CloudSessionSearch {
  readonly instanceId?: string;
}

function cloudSessionSearch(search: Record<string, unknown>): CloudSessionSearch {
  const instanceId = search.instanceId;
  return typeof instanceId === "string" && instanceId.trim() !== "" ? { instanceId } : {};
}

function CloudSessionRoute() {
  const { sessionId } = Route.useParams();
  const { instanceId } = Route.useSearch();
  // A disabled add-on's route renders a pointer to Settings and loads nothing.
  if (!useIsAddonEnabled(CLAUDE_CLOUD_ADDON_ID)) return <CloudDisabled />;
  return <ClaudeCloudSessionView sessionId={sessionId} instanceId={instanceId ?? null} />;
}

function CloudDisabled() {
  const gt = useGT();
  return (
    <SidebarInset className="h-dvh min-h-0">
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{gt("Claude Cloud is turned off")}</EmptyTitle>
          <EmptyDescription>
            <T>Turn on the Claude Cloud add-on in Settings to open cloud sessions here.</T>
          </EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" render={<Link to="/settings/addons" />}>
          <T>Add-on settings</T>
        </Button>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/cloud/$sessionId")({
  validateSearch: cloudSessionSearch,
  component: CloudSessionRoute,
});
