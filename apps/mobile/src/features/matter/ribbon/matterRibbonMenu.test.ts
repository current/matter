import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { m } from "../../../i18n/messages";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import {
  buildMatterRibbonItems,
  matterRibbonGitIcon,
  resolveMatterRibbonChanges,
  withMatterRibbon,
} from "./matterRibbonMenu";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as VcsStatusResult;
}

const PR = {
  number: 42,
  title: "Port the pill",
  url: "https://github.com/acme/app/pull/42",
  baseRef: "main",
  headRef: "feature",
  state: "open",
} as NonNullable<VcsStatusResult["pr"]>;

const handlers = {
  onOpenChanges: vi.fn(),
  onOpenPullRequest: vi.fn(),
  onOpenAgents: vi.fn(),
};

describe("resolveMatterRibbonChanges", () => {
  it("prefers the branch's changes, like the desktop diff chip", () => {
    expect(
      resolveMatterRibbonChanges(
        status({
          workingTree: { files: [], insertions: 2, deletions: 1 },
          branchChanges: { baseRef: "main", insertions: 120, deletions: 4 },
        }),
      ),
    ).toEqual({ insertions: 120, deletions: 4, baseRef: "main" });
  });

  it("falls back to uncommitted work, and to nothing when clean", () => {
    expect(
      resolveMatterRibbonChanges(
        status({ workingTree: { files: [], insertions: 3, deletions: 0 } }),
      ),
    ).toEqual({ insertions: 3, deletions: 0, baseRef: null });
    expect(resolveMatterRibbonChanges(status())).toBeNull();
    expect(resolveMatterRibbonChanges(null)).toBeNull();
  });
});

describe("buildMatterRibbonItems", () => {
  it("lists the diff, the PR and the agents, each opening its own screen", () => {
    const items = buildMatterRibbonItems(
      {
        hasThread: true,
        gitStatus: status({
          branchChanges: { baseRef: "main", insertions: 120, deletions: 4 },
          pr: PR,
        }),
        agents: { live: 1, finished: 2 },
        ...handlers,
      },
      m,
    );
    expect(items.map((item) => item.title)).toEqual(["+120 −4", "#42 Port the pill", "Agents"]);
    expect(items.map((item) => ("subtitle" in item ? item.subtitle : null))).toEqual([
      "Changes against main",
      "Open",
      "1 running · 2 finished",
    ]);
    const pr = items[1];
    if (pr && "onPress" in pr) pr.onPress();
    expect(handlers.onOpenPullRequest).toHaveBeenCalledWith(PR.url);
  });

  it("shows nothing for a draft thread or a quiet clean branch", () => {
    expect(
      buildMatterRibbonItems(
        { hasThread: false, gitStatus: status({ pr: PR }), agents: null, ...handlers },
        m,
      ),
    ).toEqual([]);
    expect(
      buildMatterRibbonItems(
        { hasThread: true, gitStatus: status(), agents: { live: 0, finished: 0 }, ...handlers },
        m,
      ),
    ).toEqual([]);
  });
});

describe("withMatterRibbon", () => {
  const menu: AppBarMenu = {
    title: "Git controls",
    icon: "point.topleft.down.curvedto.point.bottomright.up",
    items: [{ id: "git-status", title: "feature", onPress: () => {} }],
  };

  it("leaves the git menu alone when there is nothing to show", () => {
    expect(withMatterRibbon(menu, [], null)).toBe(menu);
  });

  it("leads with the ribbon section and wears the PR glyph", () => {
    const next = withMatterRibbon(
      menu,
      [{ id: "matter-ribbon-agents", title: "Agents", onPress: () => {} }],
      matterRibbonGitIcon(PR),
    );
    expect(next.icon).toBe(PullRequestGlyph.pullRequest);
    expect(next.items.map((item) => item.id)).toEqual(["matter-ribbon", "git-status"]);
    expect(matterRibbonGitIcon({ ...PR, state: "merged" })).toBe(PullRequestGlyph.merged);
    expect(matterRibbonGitIcon({ ...PR, state: "closed" })).toBeNull();
  });
});
