import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ClaudeCloudRemoteSession } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { MessageSquareIcon } from "lucide-react";

import { useQuietThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Links a cloud session's page back to the chat that started it. */
export function MatterCloudSourceChip({
  session,
}: {
  session: Pick<ClaudeCloudRemoteSession, "tracked"> | null;
}) {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const sourceThreadId = session?.tracked?.sourceThreadId ?? null;
  const ref =
    environmentId === null || sourceThreadId === null
      ? null
      : scopeThreadRef(environmentId, sourceThreadId);
  const source = useQuietThreadShell(ref);
  if (ref === null || source === null) return null;
  const title = source.title.trim() || gt("Untitled thread");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(ref)}
            data-matter-cloud-source=""
            aria-label={gt("Started from {title}", { title })}
            className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          />
        }
      >
        <MessageSquareIcon aria-hidden className="size-3 shrink-0" />
        <span className="max-w-56 truncate">{title}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <T>
          Started from <Var>{title}</Var>
        </T>
      </TooltipPopup>
    </Tooltip>
  );
}
