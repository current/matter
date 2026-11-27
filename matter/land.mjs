#!/usr/bin/env node
// One-step landing script for Matter worktree branches (matter/CONTEXT.md):
//   rebase onto main -> vp run check:changed -> ff-only merge into main checkout -> push origin main (-> optional ship-local --install)
// Usage: node matter/land.mjs [--no-push] [--install] [--skip-checks] [--dry-run]

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const NODE_SPEC = "node@26.13.1";

function defaultCheckCommand(repoDir) {
  try {
    NodeChildProcess.execFileSync("which", ["vp"], { stdio: "ignore" });
    return "vp run check:changed";
  } catch {
    const localVp = NodePath.join(repoDir, "node_modules", ".bin", "vp");
    return `mise exec ${NODE_SPEC} -- "${localVp}" run check:changed`;
  }
}

export function parseMainWorktree(porcelain) {
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      return NodePath.resolve(line.slice("worktree ".length).trim());
    }
  }
  throw new Error("Could not locate main worktree from `git worktree list --porcelain`.");
}

export function runLand(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const push = options.push ?? true;
  const install = options.install ?? false;
  const skipChecks = options.skipChecks ?? false;
  const dryRun = options.dryRun ?? false;
  const checkCmdOverride = options.checkCmd;

  const started = Date.now();
  const step = (label) =>
    console.log(`\n▸ ${label} (${Math.round((Date.now() - started) / 1000)}s)`);
  const read = (cmd, args, opts = {}) =>
    NodeChildProcess.execFileSync(cmd, args, { encoding: "utf8", cwd, ...opts }).trim();
  const run = (cmd, args, opts = {}) => {
    if (dryRun) {
      console.log(`[dry-run] (${opts.cwd ?? cwd}) ${cmd} ${args.join(" ")}`);
      return;
    }
    NodeChildProcess.execFileSync(cmd, args, { stdio: "inherit", cwd, ...opts });
  };
  const ensureClean = (dir, label, { includeUntracked = true } = {}) => {
    const args = includeUntracked
      ? ["status", "--porcelain"]
      : ["status", "--porcelain", "--untracked-files=no"];
    const status = read("git", args, { cwd: dir });
    if (status.length > 0) {
      throw new Error(
        `${label} (${dir}) has uncommitted changes:\n${status}\nCommit or stash your changes before landing.`,
      );
    }
  };

  const topLevel = NodePath.resolve(read("git", ["rev-parse", "--show-toplevel"]));
  const mainCheckout = parseMainWorktree(read("git", ["worktree", "list", "--porcelain"]));
  const branch = read("git", ["branch", "--show-current"]);
  if (!branch) {
    throw new Error("Detached HEAD: checkout your worktree branch before landing.");
  }

  const inMain = topLevel === mainCheckout;
  if (!inMain && branch === "main") {
    throw new Error("Unexpected branch 'main' outside the main checkout.");
  }

  step(`Pre-flight (${branch}${inMain ? " [main]" : ` -> ${mainCheckout}`})`);
  ensureClean(topLevel, "Current checkout", { includeUntracked: true });
  if (!inMain) {
    ensureClean(mainCheckout, "Main checkout", { includeUntracked: false });
    const mainBranch = read("git", ["branch", "--show-current"], { cwd: mainCheckout });
    if (mainBranch !== "main") {
      throw new Error(`Main checkout (${mainCheckout}) is on "${mainBranch}", expected "main".`);
    }
  }

  if (!inMain) {
    step("Rebase branch onto main");
    run("git", ["rebase", "main"], { cwd: topLevel });
  }

  if (!skipChecks) {
    const checkCmd = checkCmdOverride ?? defaultCheckCommand(topLevel);
    step(`Verify (${checkCmd})`);
    if (dryRun) {
      console.log(`[dry-run] (${topLevel}) ${checkCmd}`);
    } else {
      NodeChildProcess.execSync(checkCmd, { stdio: "inherit", cwd: topLevel });
    }
  }

  if (!inMain) {
    step("Fast-forward main checkout");
    try {
      run("git", ["-C", mainCheckout, "merge", "--ff-only", branch]);
    } catch {
      step("main moved during checks — rebasing and retrying ff-only merge");
      run("git", ["rebase", "main"], { cwd: topLevel });
      run("git", ["-C", mainCheckout, "merge", "--ff-only", branch]);
    }
  }

  if (push) {
    step("Push origin main");
    run("git", ["-C", mainCheckout, "push", "origin", "main"]);
  }

  if (install) {
    step("Build and install Matter.app (ship-local --install)");
    run("node", [NodePath.join(mainCheckout, "matter", "ship-local.mjs"), "--install"], {
      cwd: mainCheckout,
    });
  }

  step("Landed cleanly");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = NodeUtil.parseArgs({
    allowNegative: true,
    options: {
      push: { type: "boolean", default: true },
      install: { type: "boolean", default: false },
      "skip-checks": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "check-cmd": { type: "string" },
    },
  });
  try {
    runLand({
      push: values.push,
      install: values.install,
      skipChecks: values["skip-checks"],
      dryRun: values["dry-run"],
      checkCmd: values["check-cmd"],
    });
  } catch (err) {
    console.error(`\nland failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
