#!/usr/bin/env node
// Serves this checkout's web UI to the installed Matter with hot reload. Chats keep running in the
// app's backend; only the window's UI comes from here. Reload Matter (Cmd+R) after starting to
// switch to it, and again after stopping to go back to the bundled UI. See matter/liveUi.ts.
// Usage: node matter/live-ui.mjs [--port 5799]

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { BUILD_ENV } from "./build-env.mjs";

const { values } = NodeUtil.parseArgs({
  options: { port: { type: "string", default: "5799" } },
});

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const NODE = "node@26.13.1";
// Installs updated through the update button keep the bundle's old file name.
const APP_PLIST =
  ["/Applications/Matter.app", "/Applications/mattr.app"]
    .map((app) => `${app}/Contents/Info.plist`)
    .find((plist) => NodeFS.existsSync(plist)) ?? "/Applications/Matter.app/Contents/Info.plist";
// Keep in sync with MATTER_LIVE_UI_FILE in liveUi.ts.
const liveUiFile = NodePath.join(NodeOS.homedir(), ".antimatter", "live-ui.json");
const url = `http://127.0.0.1:${values.port}/`;

async function isServing() {
  try {
    const response = await fetch(new URL("/@vite/client", url), {
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (await isServing()) {
  console.error(`Something already serves ${url}. Stop it or pass --port.`);
  process.exit(1);
}

// The same version as the installed app, so the UI doesn't report a client/server mismatch.
let appVersion;
try {
  appVersion = NodeChildProcess.execFileSync(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", APP_PLIST],
    { encoding: "utf8" },
  ).trim();
} catch {
  console.error(`Could not read the installed app's version from ${APP_PLIST}.`);
  process.exit(1);
}

const env = { ...process.env, ...BUILD_ENV, PORT: values.port, HOST: "127.0.0.1" };
env.APP_VERSION = appVersion;
// The installed app finds its backend through the desktop bridge; baked URLs would override it.
for (const key of [
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "VITE_DEV_SERVER_URL",
  "T3CODE_PORT",
  "T3CODE_SINGLE_ORIGIN_DEV",
]) {
  delete env[key];
}

const vp = NodePath.join(repoRoot, "node_modules", ".bin", "vp");
const hasMise = NodeChildProcess.spawnSync("mise", ["--version"], { stdio: "ignore" }).status === 0;
const [command, args] = hasMise ? ["mise", ["exec", NODE, "--", vp, "dev"]] : [vp, ["dev"]];
const child = NodeChildProcess.spawn(command, args, {
  cwd: NodePath.join(repoRoot, "apps", "web"),
  env,
  stdio: "inherit",
});

const contents = JSON.stringify({ url, pid: process.pid });
NodeFS.writeFileSync(liveUiFile, contents);
const removeLiveUiFile = () => {
  try {
    if (NodeFS.readFileSync(liveUiFile, "utf8") === contents) NodeFS.rmSync(liveUiFile);
  } catch {}
};

console.log(`\nMatter live UI ${appVersion} → ${url}`);
console.log("Reload Matter (Cmd+R) to use it. Ctrl+C stops it; reload again to go back.\n");

child.on("exit", (code, signal) => {
  removeLiveUiFile();
  process.exit(signal ? 1 : (code ?? 0));
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    removeLiveUiFile();
    child.kill(signal);
  });
}
