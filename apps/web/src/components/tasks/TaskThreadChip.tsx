/* oxlint-disable shadcn/no-unknown-classes -- the `mtk-*` classes come from the fork stylesheet matter/tasks.css, which loads outside Tailwind. */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type MatterTaskThreadRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { useEnvironmentProviders } from "../../state/environments";
import { useQuietThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { resolveSidebarRowStatus } from "../Sidebar.logic";
import type { MatterTaskThreadState } from "./matterTasks.logic";

function toScopedThreadRef(ref: MatterTaskThreadRef): ScopedThreadRef {
  return scopeThreadRef(EnvironmentId.make(ref.environmentId), ThreadId.make(ref.threadId));
}

function taskThreadState(thread: EnvironmentThreadShell | null): MatterTaskThreadState {
  if (thread === null) return "idle";
  switch (resolveSidebarRowStatus(thread)) {
    case "approval":
    case "input":
    case "request":
    case "limited":
      return "needs";
    case "preparing":
    case "working":
      return "running";
    case "waiting":
      return thread.runtime?.status === "running" ? "running" : "idle";
    case "failed":
      return "failed";
    default:
      return thread.latestRun?.status === "completed" ? "done" : "idle";
  }
}

export function useTaskThread(ref: MatterTaskThreadRef | null) {
  const thread = useQuietThreadShell(ref === null ? null : toScopedThreadRef(ref));
  const providers = useEnvironmentProviders();
  const instanceId = thread?.modelSelection.instanceId ?? null;
  const provider =
    thread === null
      ? null
      : (providers.get(thread.environmentId)?.find((entry) => entry.instanceId === instanceId) ??
        null);
  return { thread, state: taskThreadState(thread), provider };
}

export function useTaskThreadStateLabel() {
  const gt = useGT();
  return (state: MatterTaskThreadState) => {
    switch (state) {
      case "running":
        return gt("Running");
      case "needs":
        return gt("Needs you");
      case "done":
        return gt("Done", { $context: "an agent thread finished its work" });
      case "failed":
        return gt("Failed");
      default:
        return gt("Idle", { $context: "an agent thread is not working right now" });
    }
  };
}

export function useOpenTaskThread() {
  const navigate = useNavigate();
  return (ref: MatterTaskThreadRef) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(toScopedThreadRef(ref)),
    });
}

/** The linked thread's provider and live state; clicking it opens the thread. */
export function TaskThreadChip({ threadRef }: { readonly threadRef: MatterTaskThreadRef }) {
  const gt = useGT();
  const { thread, state, provider } = useTaskThread(threadRef);
  const label = useTaskThreadStateLabel();
  const openThread = useOpenTaskThread();
  if (thread === null) return null;
  return (
    <button
      type="button"
      className="mtk-chip mtk-thread-chip"
      data-state={state}
      aria-label={gt("{state}. Open thread: {title}", { state: label(state), title: thread.title })}
      onClick={(event) => {
        event.stopPropagation();
        openThread(threadRef);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {provider ? (
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={provider.displayName ?? provider.instanceId}
          accentColor={provider.accentColor}
          iconClassName="size-3"
        />
      ) : null}
      <span className="mtk-dot" aria-hidden />
      <span>{label(state)}</span>
    </button>
  );
}
