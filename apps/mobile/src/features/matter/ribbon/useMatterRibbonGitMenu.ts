import { useNavigation } from "@react-navigation/native";
import { countMatterPreviousAgents } from "@t3tools/client-runtime/matter/whisper";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";

import * as Dialog from "../../../components/ui/Dialog";
import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import { useThreadTurnSubagents } from "../../threads/ThreadAgentsSheet";
import type { ThreadGitMenuProps } from "../../threads/ThreadGitControls";
import { buildMatterRibbonItems, matterRibbonGitIcon, withMatterRibbon } from "./matterRibbonMenu";

/**
 * Matter's Topbar Ribbon on the phone. The header has no room for desktop's chips, so the git
 * button carries them: it wears the branch PR's glyph, and its menu leads with the diff totals,
 * the PR and the thread's agents.
 */
export function useMatterRibbonGitMenu(
  menu: AppBarMenu | null,
  git: ThreadGitMenuProps,
): AppBarMenu | null {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const hasThread = git.hasThread !== false && git.threadId !== "" && git.environmentId !== "";
  const target = hasThread
    ? {
        environmentId: EnvironmentId.make(String(git.environmentId)),
        threadId: ThreadId.make(String(git.threadId)),
      }
    : null;
  const turn = useThreadTurnSubagents(target);
  const items = buildMatterRibbonItems(
    {
      hasThread: target !== null,
      gitStatus: git.gitStatus,
      agents:
        turn === null
          ? null
          : {
              live: turn.liveCount,
              finished: countMatterPreviousAgents(turn.subagents),
            },
      onOpenChanges: () => {
        if (target !== null) navigation.navigate("ThreadReview", target);
      },
      onOpenPullRequest: (url) => {
        void openPullRequest(url).then((opened) => {
          if (!opened) Dialog.alert(gt("Unable to open PR"));
        });
      },
      onOpenAgents: () => {
        if (target !== null) navigation.navigate("ThreadAgents", target);
      },
    },
    messages,
  );
  return menu === null
    ? null
    : withMatterRibbon(menu, items, matterRibbonGitIcon(git.gitStatus?.pr ?? null));
}
