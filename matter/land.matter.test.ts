import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { runLand } from "./land.mjs";

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("matter/land", () => {
  it("refuses a dirty worktree and cleanly rebases, fast-forwards, and pushes a feature worktree", () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "matter-land-test-"));
    try {
      const bare = NodePath.join(tmp, "origin.git");
      const main = NodePath.join(tmp, "main");
      const wt = NodePath.join(tmp, "wt-feat");

      NodeChildProcess.execFileSync("git", ["init", "--bare", "-q", bare]);
      NodeChildProcess.execFileSync("git", ["clone", "-q", bare, main]);
      git(main, ["config", "user.email", "test@example.com"]);
      git(main, ["config", "user.name", "Test"]);
      git(main, ["checkout", "-q", "-b", "main"]);
      NodeFS.writeFileSync(NodePath.join(main, "a.txt"), "v1\n");
      git(main, ["add", "a.txt"]);
      git(main, ["commit", "-q", "-m", "init"]);
      git(main, ["push", "-q", "-u", "origin", "main"]);

      git(main, ["worktree", "add", "-q", "-b", "feat/x", wt]);
      NodeFS.writeFileSync(NodePath.join(wt, "b.txt"), "feat\n");

      expect(() => runLand({ cwd: wt, checkCmd: "true" })).toThrow(/uncommitted changes/);

      git(wt, ["add", "b.txt"]);
      git(wt, ["commit", "-q", "-m", "feat x"]);

      // Advance main so rebase is required, and leave an unrelated untracked file in main.
      NodeFS.writeFileSync(NodePath.join(main, "c.txt"), "main\n");
      git(main, ["add", "c.txt"]);
      git(main, ["commit", "-q", "-m", "main advance"]);
      git(main, ["push", "-q", "origin", "main"]);
      NodeFS.writeFileSync(NodePath.join(main, "unrelated-untracked.tmp"), "ignore\n");

      runLand({ cwd: wt, checkCmd: "true" });

      const originLog = NodeChildProcess.execFileSync(
        "git",
        ["--git-dir", bare, "log", "--oneline", "main"],
        { encoding: "utf8" },
      );
      expect(originLog).toContain("feat x");
      expect(originLog).toContain("main advance");
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
