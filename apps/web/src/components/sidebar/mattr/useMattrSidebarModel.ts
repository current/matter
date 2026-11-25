import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuSource, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { useHandleNewThread } from "../../../hooks/useHandleNewThread";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useShownThreadRouteTarget } from "../../../hooks/useShownThreadRouteTarget";
import { useSidebarProjectGroups } from "../../../hooks/useSidebarProjectGroups";
import { useThreadActions } from "../../../hooks/useThreadActions";
import { readLocalApi } from "../../../localApi";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { useDelegatedUnderParent, useQuietThreadShells } from "../../../state/entities";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { filterSidebarV2VisibleThreads } from "../../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { useSidebar } from "../../ui/sidebar";
import {
  toMattrThreadItem,
  type MattrProjectRef,
  type MattrThreadItem,
} from "./mattrSidebar.logic";

export interface MattrSidebarProject extends MattrProjectRef {
  readonly group: SidebarProjectSnapshot;
}

export interface MattrSidebarActions {
  readonly openThread: (item: MattrThreadItem) => void;
  readonly newThread: (projectKey: string | null) => void;
  readonly openThreadMenu: (
    item: MattrThreadItem,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}

export interface MattrSidebarModel {
  readonly items: ReadonlyArray<MattrThreadItem>;
  readonly projects: ReadonlyArray<MattrSidebarProject>;
  readonly activeThreadKey: string | null;
  readonly nowMs: number;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly actions: MattrSidebarActions;
}

type ThreadMenuAction =
  | "open"
  | "pin"
  | "unpin"
  | "mark-unread"
  | "settle"
  | "unsettle"
  | "archive";

/** Everything the custom sidebars read, derived from the same stores the classic sidebar uses. */
export function useMattrSidebarModel(): MattrSidebarModel {
  const gt = useGT();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectGroups = useSidebarProjectGroups();
  const nowMinute = useNowMinute();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeTarget = useShownThreadRouteTarget().shownTarget;
  const { handleNewThread } = useHandleNewThread();
  const { pinThread, unpinThread, settleThread, unsettleThread, markThreadUnread, archiveThread } =
    useThreadActions();

  // The minute tick is a UTC "YYYY-MM-DDTHH:MM" stamp.
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  const nowIso = new Date(nowMs).toISOString();

  const projects: MattrSidebarProject[] = pickableProjectGroups(projectGroups).map((group) => ({
    key: group.projectKey,
    name: group.displayName,
    group,
  }));
  const projectByMemberKey = new Map<string, MattrSidebarProject>();
  for (const project of projects) {
    for (const ref of project.group.memberProjectRefs) {
      projectByMemberKey.set(`${ref.environmentId}:${ref.projectId}`, project);
    }
  }
  const items = filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent).map((thread) =>
    toMattrThreadItem(
      thread,
      projectByMemberKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
      nowIso,
    ),
  );

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const openThread = (item: MattrThreadItem) => {
    closeMobile();
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(item.ref),
    });
  };

  const newThread = (projectKey: string | null) => {
    closeMobile();
    const project = projects.find((candidate) => candidate.key === projectKey);
    const projectRef = project?.group.memberProjectRefs[0];
    if (projectRef === undefined) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    void handleNewThread(projectRef);
  };

  const reportFailure = (result: { readonly _tag: string }) => {
    if (result._tag !== "Failure") return;
    toastManager.add(
      stackedThreadToast({ type: "error", title: gt("Could not update the thread") }),
    );
  };

  const openThreadMenu: MattrSidebarActions["openThreadMenu"] = (item, position, source) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await settlePromise(() =>
        api.contextMenu.show<ThreadMenuAction>(
          [
            { id: "open", label: gt("Open thread") },
            item.pinned
              ? { id: "unpin", label: gt("Unpin"), separatorBefore: true }
              : { id: "pin", label: gt("Pin"), separatorBefore: true },
            { id: "mark-unread", label: gt("Mark as unread") },
            item.settled
              ? { id: "unsettle", label: gt("Unsettle") }
              : { id: "settle", label: gt("Settle") },
            { id: "archive", label: gt("Archive"), separatorBefore: true },
          ],
          position,
          source,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      switch (clicked.value) {
        case "open":
          openThread(item);
          return;
        case "pin":
          reportFailure(await pinThread(item.ref));
          return;
        case "unpin":
          reportFailure(await unpinThread(item.ref));
          return;
        case "mark-unread":
          markThreadUnread(item.ref);
          return;
        case "settle":
          reportFailure(await settleThread(item.ref));
          return;
        case "unsettle":
          reportFailure(await unsettleThread(item.ref));
          return;
        case "archive":
          reportFailure(await archiveThread(item.ref));
          return;
      }
    })();
  };

  return {
    items,
    projects,
    activeThreadKey: routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null,
    nowMs,
    keybindings,
    actions: { openThread, newThread, openThreadMenu },
  };
}
