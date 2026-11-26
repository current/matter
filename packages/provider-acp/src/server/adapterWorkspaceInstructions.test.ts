import { describe, expect, it } from "@effect/vitest";
import { buildWorkspaceInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { acpWorkspaceInstructionsUpdate } from "./adapter.ts";

const folders = (...names: ReadonlyArray<string>) =>
  buildWorkspaceInstructions({
    cwd: "/work/app",
    workspace: {
      folders: names.map((name) => ({ name, path: `/work/${name}`, isGitRepository: true })),
      extraRoots: [],
    },
  });

/** Mirrors the adapter: a note is sent only when non-empty and different from the last one sent. */
const session = (systemPromptWorkspace: string) => {
  let lastRuntimeInstructions: string | undefined;
  return (workspace: string): string | undefined => {
    const note = acpWorkspaceInstructionsUpdate({
      workspace,
      systemPromptWorkspace,
      lastRuntimeInstructions,
    });
    if (note.length === 0 || note === lastRuntimeInstructions) return undefined;
    lastRuntimeInstructions = note;
    return note;
  };
};

describe("acpWorkspaceInstructionsUpdate", () => {
  it("tells the agent when the folders return to the system prompt's list", () => {
    const initial = folders("api", "docs");
    const changed = folders("api", "docs", "web");
    const turn = session(initial);

    expect(turn(initial)).toBeUndefined();
    expect(turn(changed)).toBe(changed);
    expect(turn(changed)).toBeUndefined();
    expect(turn(initial)).toBe(initial);
    expect(turn(initial)).toBeUndefined();
  });

  it("tells the agent when a single-folder thread drops the folders it gained", () => {
    const changed = folders("api", "docs");
    const turn = session("");

    expect(turn("")).toBeUndefined();
    expect(turn(changed)).toBe(changed);
    const reverted = turn("");
    expect(reverted).toContain("<workspace_folders>");
    expect(reverted).toContain("single folder");
    expect(turn("")).toBeUndefined();
  });

  it("tells the agent when a multi-folder thread drops to one folder", () => {
    const turn = session(folders("api", "docs"));

    expect(turn("")).toContain("single folder");
  });
});
