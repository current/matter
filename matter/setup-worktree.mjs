#!/usr/bin/env node
// Setup Worktree (matter.json): clones the main checkout's node_modules into a fresh worktree,
// then runs upstream's scripts/setup-worktree.ts, whose `vp i` links only what differs.
// Anything unexpected skips the clone, leaving upstream's plain install. Node built-ins only.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const worktree = NodePath.dirname(import.meta.dirname);
const projectRoot = process.env.T3CODE_PROJECT_ROOT;
const markerDir = NodePath.join(worktree, ".t3");
const runningMarker = NodePath.join(markerDir, "setup-running");

// Agents wait while this names a live PID; upstream's setup takes it over when it starts.
NodeFS.mkdirSync(markerDir, { recursive: true });
NodeFS.writeFileSync(runningMarker, `${process.pid}\n`);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    NodeFS.writeFileSync(NodePath.join(markerDir, "setup-failed"), `Cancelled by ${signal}.\n`);
    NodeFS.rmSync(runningMarker, { force: true });
    process.exit(1);
  });
}

// pnpm's own state; every other dot entry is a per-checkout cache (vite, vitest, check:changed).
const KEEP_DOT_ENTRIES = new Set([".bin", ".modules.yaml", ".pnpm"]);

function clonePlan() {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node script with no Effect runtime.
  if (process.platform !== "darwin" || !projectRoot) return { skip: "not macOS" };
  const source = NodeFS.realpathSync(projectRoot);
  if (source === NodeFS.realpathSync(worktree)) return { skip: "this is the main checkout" };
  if (NodeFS.existsSync(NodePath.join(worktree, "node_modules"))) {
    return { skip: "node_modules already exists" };
  }
  const sourceModules = NodePath.join(source, "node_modules");
  let modules;
  let state;
  try {
    // pnpm writes both as JSON despite the .yaml name.
    modules = JSON.parse(
      NodeFS.readFileSync(NodePath.join(sourceModules, ".modules.yaml"), "utf8"),
    );
    state = JSON.parse(
      NodeFS.readFileSync(NodePath.join(sourceModules, ".pnpm-workspace-state-v1.json"), "utf8"),
    );
  } catch {
    return { skip: `${source} has no complete install` };
  }
  // Another pnpm would purge the clone and reinstall, which is slower than not cloning.
  const { packageManager } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(worktree, "package.json"), "utf8"),
  );
  if (modules.packageManager !== packageManager) {
    return {
      skip: `main checkout was installed by ${modules.packageManager}, not ${packageManager}`,
    };
  }
  // clonefile cannot cross volumes.
  if (NodeFS.statSync(sourceModules).dev !== NodeFS.statSync(worktree).dev) {
    return { skip: "main checkout is on another volume" };
  }
  const pairs = [];
  for (const projectDir of Object.keys(state.projects ?? {})) {
    const relative = NodePath.relative(source, projectDir);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
    const from = NodePath.join(source, relative, "node_modules");
    const to = NodePath.join(worktree, relative, "node_modules");
    if (!NodeFS.existsSync(NodePath.join(worktree, relative, "package.json"))) continue;
    let entries;
    try {
      entries = NodeFS.readdirSync(from);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") && !KEEP_DOT_ENTRIES.has(entry)) continue;
      pairs.push([NodePath.join(from, entry), NodePath.join(to, entry)]);
    }
  }
  return pairs.length > 0 ? { source, pairs } : { skip: "nothing to clone" };
}

// clonefile(2) clones a whole directory tree in one call; `cp -c -R` clones file by file and
// is slower than pnpm itself. Node has no binding for it, so python3's ctypes makes the call.
const CLONE_SCRIPT = `
import ctypes, json, os, sys
from concurrent.futures import ThreadPoolExecutor
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
def clone(pair):
    src, dst = pair
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if libc.clonefile(src.encode(), dst.encode(), ctypes.c_uint32(1)) != 0:  # CLONE_NOFOLLOW
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()), dst)
with ThreadPoolExecutor(8) as pool:
    list(pool.map(clone, json.load(sys.stdin)))
`;

const plan = clonePlan();
let cloned = false;
if (plan.skip) {
  console.log(`[matter-setup] Skipping the node_modules clone: ${plan.skip}.`);
} else {
  const started = Date.now();
  const result = NodeChildProcess.spawnSync("/usr/bin/python3", ["-I", "-c", CLONE_SCRIPT], {
    input: JSON.stringify(plan.pairs),
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status === 0) {
    cloned = true;
    console.log(
      `[matter-setup] Cloned node_modules from ${plan.source} in ${((Date.now() - started) / 1000).toFixed(1)}s; vp i reconciles the rest.`,
    );
  } else {
    // A partial clone would leave packages pnpm believes are installed, so start clean.
    console.log("[matter-setup] Cloning node_modules failed; falling back to a full install.");
    for (const [, to] of plan.pairs) NodeFS.rmSync(to, { recursive: true, force: true });
  }
}

// Upstream's setup runs `vp`, which a terminal without a global vite-plus lacks; the clone
// brings this worktree's own, so put it last on PATH where a global vp still wins.
const env = cloned
  ? {
      ...process.env,
      PATH: [process.env.PATH, NodePath.join(worktree, "node_modules", ".bin")]
        .filter(Boolean)
        .join(NodePath.delimiter),
    }
  : process.env;
const setup = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(worktree, "scripts/setup-worktree.ts")],
  { cwd: worktree, stdio: "inherit", env },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.removeAllListeners(signal);
  process.on(signal, () => setup.kill(signal));
}
setup.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
