import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type {
  ContextMenuSource,
  ProviderDriverKind,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { openCommandPalette } from "../../../commandPaletteBus";
import { configuredHostedAppUrl } from "../../../hostedPairing";
import { useHandleNewThread } from "../../../hooks/useHandleNewThread";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useShownThreadRouteTarget } from "../../../hooks/useShownThreadRouteTarget";
import { useSidebarProjectGroups } from "../../../hooks/useSidebarProjectGroups";
import { useThreadActions } from "../../../hooks/useThreadActions";
import { m } from "../../../i18n/messages";
import { copyThreadReference } from "../../../lib/copyThreadReference";
import { readLocalApi } from "../../../localApi";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { useDelegatedUnderParent, useQuietThreadShells } from "../../../state/entities";
import { useEnvironmentProviders } from "../../../state/environments";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { filterSidebarV2VisibleThreads } from "../../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { useSidebar } from "../../ui/sidebar";
import { attachListedAncestors, type MattrChildItem } from "./mattrFinalSidebar.logic";
import {
  toMattrThreadItem,
  withDescendantWork,
  workingDescendantSince,
  type MattrProjectRef,
  type MattrThreadItem,
} from "./mattrSidebar.logic";

export interface MattrSidebarProject extends MattrProjectRef {
  readonly group: SidebarProjectSnapshot;
}

export type MattrThreadMenuAction =
  | "open"
  | "pin"
  | "unpin"
  | "mark-unread"
  | "settle"
  | "unsettle"
  | "archive"
  | "copy-link";

export interface MattrSidebarActions {
  readonly openThread: (item: MattrThreadItem) => void;
  readonly newThread: (projectKey: string | null) => void;
  readonly openThreadMenu: (
    item: MattrThreadItem,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  /** Runs one thread menu action directly (used by Web/PWA popover menus when no native menu exists). */
  readonly runThreadAction?: (item: MattrThreadItem, action: MattrThreadMenuAction) => void;
}

export interface MattrSidebarModel {
  readonly items: ReadonlyArray<MattrThreadItem>;
  /** Subagents and delegated tasks, which the rail nests under their listed ancestor. */
  readonly children: ReadonlyArray<MattrChildItem>;
  readonly projects: ReadonlyArray<MattrSidebarProject>;
  readonly activeThreadKey: string | null;
  readonly nowMs: number;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly actions: MattrSidebarActions;
}

/** Everything the custom sidebars read, derived from the same stores the classic sidebar uses. */
export function useMattrSidebarModel(): MattrSidebarModel {
  const gt = useGT();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projectGroups = useSidebarProjectGroups();
  const providersByEnvironment = useEnvironmentProviders();
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
  const driverByInstance = new Map<string, ProviderDriverKind>();
  for (const [environmentId, providers] of providersByEnvironment) {
    for (const provider of providers) {
      driverByInstance.set(`${environmentId}:${provider.instanceId}`, provider.driver);
    }
  }
  const toItem = (thread: (typeof threads)[number]) =>
    toMattrThreadItem(
      thread,
      projectByMemberKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
      nowIso,
      driverByInstance.get(
        `${thread.environmentId}:${thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId}`,
      ) ?? null,
    );
  const listedItems = filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent).map(
    toItem,
  );
  const listedChildren = attachListedAncestors(
    threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.lineage.sideChat !== true &&
          thread.lineage.workflowStep !== true &&
          isShownUnderParent(
            { environmentId: thread.environmentId, threadId: thread.id },
            thread.lineage,
            delegatedUnderParent,
          ),
      )
      .map(toItem)
      .filter((item) => item.parentKey !== null),
    threads,
  );
  const workingSince = workingDescendantSince([...listedItems, ...listedChildren]);
  const items = withDescendantWork(listedItems, workingSince);
  const children = withDescendantWork(listedChildren, workingSince);

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

  const runThreadAction = (item: MattrThreadItem, action: MattrThreadMenuAction) => {
    void (async () => {
      switch (action) {
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
        case "copy-link":
          await copyThreadReference(
            threadChipCopyTarget(item.ref, item.title, configuredHostedAppUrl(), m),
          );
          return;
        case "archive":
          reportFailure(await archiveThread(item.ref));
          return;
      }
    })();
  };

  const openThreadMenu: MattrSidebarActions["openThreadMenu"] = (item, position, source) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await settlePromise(() =>
        api.contextMenu.show<MattrThreadMenuAction>(
          [
            { id: "open", label: gt("Open thread") },
            item.pinned
              ? { id: "unpin", label: gt("Unpin"), separatorBefore: true }
              : { id: "pin", label: gt("Pin"), separatorBefore: true },
            { id: "mark-unread", label: gt("Mark as unread") },
            item.settled
              ? { id: "unsettle", label: gt("Unsettle") }
              : { id: "settle", label: gt("Settle") },
            { id: "copy-link", label: gt("Copy link") },
            { id: "archive", label: gt("Archive"), separatorBefore: true },
          ],
          position,
          source,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      runThreadAction(item, clicked.value);
    })();
  };

  return {
    items,
    children,
    projects,
    activeThreadKey: routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null,
    nowMs,
    keybindings,
    actions: { openThread, newThread, openThreadMenu, runThreadAction },
  };
}
