import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ClaudeCloudRemoteSession } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { CloudIcon } from "lucide-react";

import { useQuietThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** "Ran in cloud · From <chat>": links a cloud session's page back to the chat that started it. */
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
          <Badge
            variant="outline"
            data-matter-cloud-source=""
            render={
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(ref)}
                aria-label={gt("Ran in cloud, from {title}", { title })}
              />
            }
          />
        }
      >
        <CloudIcon aria-hidden />
        <span className="max-w-48 truncate">
          <T>
            From <Var>{title}</Var>
          </T>
        </span>
      </TooltipTrigger>
      <TooltipPopup>
        <T>
          Ran in cloud for <Var>{title}</Var>
        </T>
      </TooltipPopup>
    </Tooltip>
  );
}
