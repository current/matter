import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { VcsStatusResult } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import type { AppBarMenu, AppBarMenuItem } from "../../../components/ui/AppBar.types";
import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import type { MessageResolver } from "../../../i18n/messages";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";

export interface MatterRibbonChanges {
  readonly insertions: number;
  readonly deletions: number;
  /** Null for uncommitted work; else the branch the totals are counted against. */
  readonly baseRef: string | null;
}

/** The desktop diff chip's status totals: the branch's changes, else the working tree's. */
export function resolveMatterRibbonChanges(
  status: VcsStatusResult | null,
): MatterRibbonChanges | null {
  if (status === null || !status.isRepo) return null;
  const branch = status.branchChanges;
  if (branch && (branch.insertions > 0 || branch.deletions > 0)) {
    return { insertions: branch.insertions, deletions: branch.deletions, baseRef: branch.baseRef };
  }
  const tree = status.workingTree;
  if (tree.insertions > 0 || tree.deletions > 0) {
    return { insertions: tree.insertions, deletions: tree.deletions, baseRef: null };
  }
  return null;
}

type RibbonPr = NonNullable<VcsStatusResult["pr"]>;

function prStateLabel(pr: RibbonPr, resolve: MessageResolver): string {
  if (pr.state === "open" && pr.isDraft === true) {
    return resolve(msg("Draft", { $context: "pull request state" }));
  }
  if (pr.state === "open") return resolve(msg("Open", { $context: "pull request state" }));
  if (pr.state === "merged") return resolve(msg("Merged", { $context: "pull request state" }));
  return resolve(msg("Closed", { $context: "pull request state" }));
}

/** The git button wears the PR's glyph while the branch has one open or merged. */
export function matterRibbonGitIcon(pr: RibbonPr | null): AppSymbolName | null {
  if (pr === null) return null;
  if (pr.state === "merged") return PullRequestGlyph.merged;
  if (pr.state === "open") return PullRequestGlyph.pullRequest;
  return null;
}

export interface MatterRibbonInput {
  readonly hasThread: boolean;
  readonly gitStatus: VcsStatusResult | null;
  readonly agents: { readonly live: number; readonly finished: number } | null;
  readonly onOpenChanges: () => void;
  readonly onOpenPullRequest: (url: string) => void;
  readonly onOpenAgents: () => void;
}

/**
 * The desktop Ribbon's at-a-glance chips as the first section of the phone's git menu: the diff
 * totals (opens Review), the branch's pull request and the thread's agents, the phone's way back
 * to agents that finished once the Whisper Pill hides.
 */
export function buildMatterRibbonItems(
  input: MatterRibbonInput,
  resolve: MessageResolver,
): ReadonlyArray<AppBarMenuItem> {
  if (!input.hasThread) return [];
  const items: AppBarMenuItem[] = [];
  const changes = resolveMatterRibbonChanges(input.gitStatus);
  if (changes !== null) {
    items.push({
      id: "matter-ribbon-changes",
      title: `+${formatDiffCount(changes.insertions)} −${formatDiffCount(changes.deletions)}`,
      icon: "plusminus",
      subtitle:
        changes.baseRef === null
          ? resolve(msg("Uncommitted changes"))
          : resolve(msg("Changes against {base}", { base: changes.baseRef })),
      onPress: input.onOpenChanges,
    });
  }
  const pr = input.gitStatus?.pr ?? null;
  if (pr !== null) {
    items.push({
      id: "matter-ribbon-pr",
      title: `#${pr.number} ${pr.title}`,
      // Native menus take SF Symbol names only; the draft and closed glyphs are drawn icons.
      icon: pr.state === "merged" ? PullRequestGlyph.merged : PullRequestGlyph.pullRequest,
      subtitle: prStateLabel(pr, resolve),
      onPress: () => input.onOpenPullRequest(pr.url),
    });
  }
  const agents = input.agents;
  if (agents !== null && agents.live + agents.finished > 0) {
    items.push({
      id: "matter-ribbon-agents",
      title: resolve(msg("Agents")),
      icon: "person.2",
      subtitle:
        agents.live > 0 && agents.finished > 0
          ? resolve(
              msg("{live} running · {finished} finished", {
                live: agents.live,
                finished: agents.finished,
              }),
            )
          : agents.live > 0
            ? resolve(msg("{count} running", { count: agents.live }))
            : resolve(msg("{count} finished", { count: agents.finished })),
      onPress: input.onOpenAgents,
    });
  }
  return items;
}

/** Leads the git menu with the ribbon section and swaps its glyph for the PR's. */
export function withMatterRibbon(
  menu: AppBarMenu,
  items: ReadonlyArray<AppBarMenuItem>,
  icon: AppSymbolName | null,
): AppBarMenu {
  if (items.length === 0 && icon === null) return menu;
  return {
    ...menu,
    ...(icon === null ? {} : { icon }),
    items:
      items.length === 0
        ? menu.items
        : [{ id: "matter-ribbon", inline: true, items }, ...menu.items],
  };
}
