import { createFileRoute, Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { useHasCapability } from "../addons/matterCapabilities";
import { BotConversationView } from "../components/bots/BotConversationView";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

function BotRoute() {
  const { providerId, botId } = Route.useParams();
  // A disabled add-on's route renders a pointer to Settings and loads nothing.
  if (!useHasCapability("bots.read")) return <BotsDisabled />;
  return <BotConversationView providerId={providerId} botId={botId} />;
}

function BotsDisabled() {
  const gt = useGT();
  return (
    <SidebarInset className="h-dvh min-h-0">
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{gt("Bots are turned off")}</EmptyTitle>
          <EmptyDescription>
            <T>Turn on a Bots add-on in Settings to chat with your Bots here.</T>
          </EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" render={<Link to="/settings/addons" />}>
          <T>Add-on settings</T>
        </Button>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/bots/$providerId/$botId")({
  component: BotRoute,
});
