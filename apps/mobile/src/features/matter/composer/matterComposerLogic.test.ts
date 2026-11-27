import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMatterMobileInteractionMode,
  formatMatterUnderTrayWorkspaceLabel,
  matterMobileInteractionModeSlashItems,
  resolveMatterMobileModeSend,
  shouldShowMatterMobileUnderTray,
} from "./matterComposerLogic";

const english = (message: string) => message;

describe("shouldShowMatterMobileUnderTray", () => {
  it("shows the under-tray for real projects and collapses cleanly without one", () => {
    expect(
      shouldShowMatterMobileUnderTray({
        hasProject: true,
        isScratchProject: false,
        isQueuedEdit: false,
      }),
    ).toBe(true);
    expect(
      shouldShowMatterMobileUnderTray({
        hasProject: false,
        isScratchProject: false,
        isQueuedEdit: false,
      }),
    ).toBe(false);
    expect(
      shouldShowMatterMobileUnderTray({
        hasProject: true,
        isScratchProject: true,
        isQueuedEdit: false,
      }),
    ).toBe(false);
    expect(
      shouldShowMatterMobileUnderTray({
        hasProject: true,
        isScratchProject: false,
        isQueuedEdit: true,
      }),
    ).toBe(false);
  });
});

describe("formatMatterUnderTrayWorkspaceLabel", () => {
  it("formats local and worktree labels concisely", () => {
    expect(
      formatMatterUnderTrayWorkspaceLabel(
        { workspaceMode: "local", worktreePath: null },
        english as never,
      ),
    ).toBe("Local");
    expect(
      formatMatterUnderTrayWorkspaceLabel(
        { workspaceMode: "worktree", worktreePath: null },
        english as never,
      ),
    ).toBe("Worktree");
    expect(
      formatMatterUnderTrayWorkspaceLabel(
        { workspaceMode: "local", worktreePath: "/tmp/wt" },
        english as never,
      ),
    ).toBe("Worktree");
  });
});

describe("matterMobileInteractionModeSlashItems", () => {
  it("returns matching /plan, /goal, and /default slash commands", () => {
    const all = matterMobileInteractionModeSlashItems("", false, english as never);
    expect(all.map((item) => item.label)).toEqual(["/plan", "/goal", "/default"]);
    expect(
      matterMobileInteractionModeSlashItems("go", true, english as never).map((item) => ({
        label: item.label,
        description: item.description,
      })),
    ).toEqual([
      {
        label: "/goal",
        description: "Set a goal and work autonomously until it is verified complete",
      },
    ]);
  });
});

describe("deriveMatterMobileInteractionMode & resolveMatterMobileModeSend", () => {
  const codexProvider = {
    driver: ProviderDriverKind.make("codex"),
    slashCommands: [],
    version: null,
  };
  const cursorProvider = {
    driver: ProviderDriverKind.make("cursor"),
    slashCommands: [],
    version: null,
  };
  const antigravityProvider = {
    driver: ProviderDriverKind.make("antigravity"),
    slashCommands: [{ name: "goal" }],
    version: null,
  };

  it("prefixes the first Goal prompt with `/goal ` on native-goal providers", () => {
    const modeState = deriveMatterMobileInteractionMode({
      draftInteractionMode: "goal",
      thread: { interactionMode: "default", goal: null },
      isServerThread: false,
      provider: codexProvider,
    });
    expect(modeState.nativeGoals).toBe(true);
    expect(modeState.nativeGoalStarted).toBe(false);
    expect(
      resolveMatterMobileModeSend({
        prompt: "ship mobile shelf",
        bypass: false,
        editingQueuedMessage: false,
        modeState,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "send",
      text: "/goal ship mobile shelf",
      interactionMode: "goal",
      switchTo: null,
      clearNativeGoalBeforeSend: false,
    });
  });

  it("does not prefix Goal prompts on fallback providers without native `/goal`", () => {
    const modeState = deriveMatterMobileInteractionMode({
      draftInteractionMode: "goal",
      thread: { interactionMode: "default", goal: null },
      isServerThread: false,
      provider: cursorProvider,
    });
    expect(modeState.nativeGoals).toBe(false);
    expect(
      resolveMatterMobileModeSend({
        prompt: "ship mobile shelf",
        bypass: false,
        editingQueuedMessage: false,
        modeState,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "send",
      text: "ship mobile shelf",
      interactionMode: "goal",
      switchTo: null,
      clearNativeGoalBeforeSend: false,
    });
  });

  it("clears a running native goal when leaving via `/default` or `/plan`, except on Antigravity", () => {
    const runningCodex = deriveMatterMobileInteractionMode({
      draftInteractionMode: null,
      thread: { interactionMode: "goal", goal: { objective: "Ship", status: "active" } },
      isServerThread: true,
      provider: codexProvider,
    });
    expect(runningCodex.clearsNativeGoalOnExit).toBe(true);
    expect(
      resolveMatterMobileModeSend({
        prompt: "/default",
        bypass: false,
        editingQueuedMessage: false,
        modeState: runningCodex,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "switch",
      nextMode: "default",
      clearNativeGoal: true,
    });
    expect(
      resolveMatterMobileModeSend({
        prompt: "/plan rethink tests",
        bypass: false,
        editingQueuedMessage: false,
        modeState: runningCodex,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "send",
      text: "rethink tests",
      interactionMode: "plan",
      switchTo: "plan",
      clearNativeGoalBeforeSend: true,
    });
    // Typed `/goal clear` sends itself directly without doubling a clear command.
    expect(
      resolveMatterMobileModeSend({
        prompt: "/goal clear",
        bypass: false,
        editingQueuedMessage: false,
        modeState: runningCodex,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "send",
      text: "/goal clear",
      interactionMode: "default",
      switchTo: "default",
      clearNativeGoalBeforeSend: false,
    });

    const runningAntigravity = deriveMatterMobileInteractionMode({
      draftInteractionMode: null,
      thread: { interactionMode: "goal", goal: { objective: "Ship", status: "active" } },
      isServerThread: true,
      provider: antigravityProvider,
    });
    expect(runningAntigravity.clearsNativeGoalOnExit).toBe(false);
    expect(
      resolveMatterMobileModeSend({
        prompt: "/default",
        bypass: false,
        editingQueuedMessage: false,
        modeState: runningAntigravity,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "switch",
      nextMode: "default",
      clearNativeGoal: false,
    });
  });

  it("switches on standalone `/plan` and strips `/plan ` prefix with text", () => {
    const modeState = deriveMatterMobileInteractionMode({
      draftInteractionMode: null,
      thread: { interactionMode: "default", goal: null },
      isServerThread: true,
      provider: codexProvider,
    });
    expect(
      resolveMatterMobileModeSend({
        prompt: "/plan",
        bypass: false,
        editingQueuedMessage: false,
        modeState,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "switch",
      nextMode: "plan",
      clearNativeGoal: false,
    });
    expect(
      resolveMatterMobileModeSend({
        prompt: "/plan audit auth flow",
        bypass: false,
        editingQueuedMessage: false,
        modeState,
        attachmentCount: 0,
        contextCount: 0,
      }),
    ).toEqual({
      kind: "send",
      text: "audit auth flow",
      interactionMode: "plan",
      switchTo: "plan",
      clearNativeGoalBeforeSend: false,
    });
  });
});
