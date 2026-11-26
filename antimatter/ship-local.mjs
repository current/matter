#!/usr/bin/env node
// Builds and signs mattr like the nightly workflow, without GitHub; --install swaps it into /Applications.
// Default: the unpacked .app, signed in place. --dmg adds CI's DMG, zip and manifest; --no-upstream skips the merge.
// Usage: node antimatter/ship-local.mjs [--install] [--ref main] [--no-upstream] [--dmg] [--build-root <dir>]

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { BUILD_ENV } from "./build-env.mjs";

const { values } = NodeUtil.parseArgs({
  allowNegative: true,
  options: {
    install: { type: "boolean", default: false },
    ref: { type: "string", default: "main" },
    upstream: { type: "boolean", default: true },
    dmg: { type: "boolean", default: false },
    "build-root": { type: "string" },
    // Seconds between handing off and quitting the live app, so the caller can finish first.
    "quit-delay": { type: "string", default: "20" },
  },
});

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
// Kept between runs so installs and builds stay incremental: git clean below leaves ignored
// files (dist, node_modules and their caches) in place.
const buildRoot = NodePath.resolve(
  values["build-root"] ?? NodePath.join(NodePath.dirname(repoRoot), "mattr-ship"),
);
const signingDir = NodePath.join(NodeOS.homedir(), ".antimatter-signing");
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const FORK_URL = "https://github.com/current/mattr.git";
const NODE = "node@26.13.1";
const BUNDLE_ID = "com.current.antimatter";
const LAUNCHD_LABEL = "com.current.antimatter.ship-install";
const VERIFY_URL = "http://127.0.0.1:3773/.well-known/t3/environment";
const CLEAN_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildLaunchdPlist({ label, programArguments, env, logPath }) {
  const argsXml = programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envXml = Object.entries(env)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argsXml,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <false/>",
    "  <key>AbandonProcessGroup</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    envXml,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const started = Date.now();
const step = (label) => console.log(`\n▸ ${label} (${Math.round((Date.now() - started) / 1000)}s)`);
const run = (cmd, args, options = {}) =>
  NodeChildProcess.execFileSync(cmd, args, { stdio: "inherit", ...options });
const read = (cmd, args, options = {}) =>
  NodeChildProcess.execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();
const git = (args, options = {}) => run("git", args, { cwd: buildRoot, ...options });
const mise = (args, options = {}) => run("mise", ["exec", NODE, "--", ...args], options);

function nightlyTags(remote) {
  return read("git", ["ls-remote", "--tags", remote, "v*-nightly.*"], { cwd: repoRoot })
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter((tag) => tag && !tag.endsWith("^{}"))
    .map((tag) => ({ tag, match: /^v(.+-nightly\.(\d{8}))\.(\d+)$/.exec(tag) }))
    .filter((entry) => entry.match !== null);
}

// Same scheme as the workflow, which appends a two-digit build count to upstream's run.
// Reusing the newest published number for this upstream run (or 00 before the first) keeps
// the next CI release newer, so the update button still moves forward.
function resolveVersion(upstreamTag) {
  const [, prefix, , run] = /^v(.+-nightly\.(\d{8}))\.(\d+)$/.exec(upstreamTag);
  const builds = nightlyTags(FORK_URL)
    .filter(
      ({ match }) =>
        match[1] === prefix && match[3].startsWith(run) && match[3].length === run.length + 2,
    )
    .map(({ match }) => Number(match[3].slice(run.length)));
  const count = builds.length > 0 ? Math.max(...builds) : 0;
  return `${prefix}.${run}${String(count).padStart(2, "0")}`;
}

const mainSha = read("git", ["rev-parse", values.ref], { cwd: repoRoot });
let upstreamTag;
if (values.upstream) {
  step("Finding the newest upstream nightly");
  upstreamTag = nightlyTags(UPSTREAM_URL)
    .sort((a, b) => a.match[2].localeCompare(b.match[2]) || Number(a.match[3]) - Number(b.match[3]))
    .at(-1)?.tag;
  if (!upstreamTag) throw new Error("No upstream nightly tag found.");
} else {
  step(`Finding the upstream nightly ${values.ref} already contains`);
  // The version follows the last upstream nightly merged into the ref, so the next CI
  // release (which merges a newer one) still shows up as an update.
  upstreamTag = read(
    "git",
    ["describe", "--tags", "--match", "v*-nightly.*", "--abbrev=0", mainSha],
    {
      cwd: repoRoot,
    },
  );
}
const version = resolveVersion(upstreamTag);
console.log(
  `${values.upstream ? `${upstreamTag} + ` : ""}${values.ref} ${mainSha.slice(0, 12)} → mattr ${version}${values.upstream ? "" : ` (no upstream merge; based on ${upstreamTag})`}`,
);

step(`Preparing the build checkout at ${buildRoot}`);
if (!NodeFS.existsSync(NodePath.join(buildRoot, ".git"))) {
  run("git", ["worktree", "add", "--detach", buildRoot, mainSha], { cwd: repoRoot });
}
git(["reset", "--hard", "--quiet"]);
git(["clean", "-fdq", "-e", "node_modules", "-e", ".t3"]);
git(["checkout", "--quiet", "--detach", mainSha]);
if (values.upstream) {
  git([
    "fetch",
    "--quiet",
    "--no-tags",
    UPSTREAM_URL,
    `refs/tags/${upstreamTag}:refs/tags/${upstreamTag}`,
  ]);
  try {
    git([
      "-c",
      "user.name=mattr-ship",
      "-c",
      "user.email=mattr-ship@localhost",
      "merge",
      "--quiet",
      "--no-edit",
      upstreamTag,
    ]);
  } catch {
    const files = read("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: buildRoot });
    git(["merge", "--abort"]);
    throw new Error(
      `Merging ${upstreamTag} into ${values.ref} conflicts in:\n${files}\nResolve it on main first, ` +
        `or rerun with --no-upstream to ship ${values.ref} without the newest upstream nightly.`,
    );
  }
}

// pnpm takes several seconds even when nothing changed, so skip it while every input it
// reads (lockfile, workspace, manifests, patches) has the same git blob as the last install.
const installInputs = read(
  "git",
  [
    "ls-files",
    "-s",
    "--",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".pnpmfile.cjs",
    "patches",
    "apps/mobile/deps",
    "apps/web/deps",
    ":(glob)**/package.json",
  ],
  { cwd: buildRoot },
);
const installKey = NodeCrypto.createHash("sha256")
  .update(`${NODE}\0${installInputs}`)
  .digest("hex");
const installStamp = NodePath.join(buildRoot, "node_modules/.mattr-ship-install");
const installed =
  NodeFS.existsSync(NodePath.join(buildRoot, "node_modules/.modules.yaml")) &&
  NodeFS.existsSync(installStamp) &&
  NodeFS.readFileSync(installStamp, "utf8") === installKey;
if (installed) {
  step("Dependencies unchanged since the last install");
} else {
  step("Installing dependencies");
  NodeFS.rmSync(installStamp, { force: true });
  mise(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], { cwd: buildRoot });
  NodeFS.writeFileSync(installStamp, installKey);
}

const releaseDir = NodePath.join(buildRoot, "release-local");
NodeFS.rmSync(releaseDir, { recursive: true, force: true });

step(values.dmg ? "Building the macOS app, DMG and zip" : "Building the macOS app");
mise(
  [
    "pnpm",
    "run",
    "dist:desktop:artifact",
    "--platform",
    "mac",
    "--target",
    // electron-builder spends minutes compressing a DMG and zip that a local install throws away.
    values.dmg ? "dmg" : "dir",
    "--arch",
    "arm64",
    "--build-version",
    version,
    "--output-dir",
    releaseDir,
  ],
  { cwd: buildRoot, env: { ...process.env, ...BUILD_ENV } },
);

let builtApp;
if (!values.dmg) {
  const appDir = NodePath.join(releaseDir, "mac-arm64");
  const appName = NodeFS.readdirSync(appDir).find((name) => name.endsWith(".app"));
  if (!appName) throw new Error(`No .app in ${appDir}`);
  builtApp = NodePath.join(appDir, appName);
  // electron-builder writes the updater's feed only for dmg and zip targets, so write the
  // same file (as createBuildConfig's publish config) before signing seals Resources.
  const [owner, repo] = BUILD_ENV.T3CODE_DESKTOP_UPDATE_REPOSITORY.split("/");
  NodeFS.writeFileSync(
    NodePath.join(builtApp, "Contents/Resources/app-update.yml"),
    [
      `owner: ${owner}`,
      `repo: ${repo}`,
      "provider: github",
      "releaseType: prerelease",
      "channel: nightly",
      "updaterCacheDirName: t3code-updater",
      "",
    ].join("\n"),
  );
}

step("Signing with the mattr certificate");
const keychain = NodePath.join(NodeOS.tmpdir(), `mattr-ship-${process.pid}.keychain-db`);
const keychainPassword = NodeCrypto.randomBytes(16).toString("hex");
const searchList = read("security", ["list-keychains", "-d", "user"])
  .split("\n")
  .map((line) => line.trim().replaceAll('"', ""))
  .filter(Boolean);
try {
  run("security", ["create-keychain", "-p", keychainPassword, keychain]);
  run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
  const p12Password = NodeFS.readFileSync(
    NodePath.join(signingDir, "p12-password.txt"),
    "utf8",
  ).trim();
  run(
    "security",
    [
      "import",
      NodePath.join(signingDir, "antimatter-signing.p12"),
      "-k",
      keychain,
      "-P",
      p12Password,
      "-T",
      "/usr/bin/codesign",
    ],
    { stdio: "ignore" },
  );
  run(
    "security",
    [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      keychainPassword,
      keychain,
    ],
    { stdio: "ignore" },
  );
  // codesign finds identities only in keychains on the user search list.
  run("security", ["list-keychains", "-d", "user", "-s", keychain, ...searchList]);
  const identity = /\b([0-9A-F]{40})\b.*Antimatter/.exec(
    read("security", ["find-identity", "-p", "codesigning", keychain]),
  )?.[1];
  if (!identity) throw new Error("The mattr signing identity did not import.");
  run(
    "node",
    [
      NodePath.join(buildRoot, "antimatter/sign-mac-release.mjs"),
      ...(builtApp ? ["--app-path", builtApp] : ["--release-dir", releaseDir]),
      "--identity",
      identity,
      "--keychain",
      keychain,
    ],
    { cwd: buildRoot },
  );
} finally {
  run("security", ["list-keychains", "-d", "user", "-s", ...searchList]);
  NodeChildProcess.spawnSync("security", ["delete-keychain", keychain]);
}

step("Checking the signed app");
const stageDir = NodePath.join(buildRoot, "release-local-app");
NodeFS.rmSync(stageDir, { recursive: true, force: true });
let stagedApp = builtApp;
if (!stagedApp) {
  // The zip is what the update button downloads, so check the app it unpacks to.
  const zip = NodeFS.readdirSync(releaseDir).find((name) => name.endsWith(".zip"));
  if (!zip) throw new Error(`No zip in ${releaseDir}`);
  run("ditto", ["-x", "-k", NodePath.join(releaseDir, zip), stageDir]);
  const appName = NodeFS.readdirSync(stageDir).find((name) => name.endsWith(".app"));
  stagedApp = NodePath.join(stageDir, appName);
  run("codesign", ["--verify", "--deep", "--strict", stagedApp]);
}
const plist = (key) =>
  read("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    NodePath.join(stagedApp, "Contents/Info.plist"),
  ]);
if (plist("CFBundleIdentifier") !== BUNDLE_ID)
  throw new Error(`Unexpected bundle id ${plist("CFBundleIdentifier")}`);
console.log(
  `${stagedApp}\n${plist("CFBundleName")} ${plist("CFBundleShortVersionString")}, built in ${Math.round((Date.now() - started) / 1000)}s`,
);

if (!values.install) process.exit(0);

step("Handing off the install");
// Copy into buildRoot and launch in a clean gui/<uid> launchd job so quitting the live app
// does not tear down the installer or leak ELECTRON_RUN_AS_NODE / agent env vars into mattr.
const log = NodePath.join(buildRoot, "ship-local-install.log");
const runScriptPath = NodePath.join(buildRoot, "ship-local-install-run.sh");
NodeFS.copyFileSync(NodePath.join(repoRoot, "antimatter/ship-local-install.sh"), runScriptPath);
NodeFS.chmodSync(runScriptPath, 0o755);

const plistPath = NodePath.join(buildRoot, `${LAUNCHD_LABEL}.plist`);
const baseInstallEnv = {
  HOME: NodeOS.homedir(),
  USER: NodeOS.userInfo().username,
  PATH: CLEAN_PATH,
  QUIT_DELAY: String(values["quit-delay"]),
  LOG_FILE: log,
  VERIFY_URL,
};

let launchedViaLaunchd = false;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node script with no Effect runtime.
if (process.platform === "darwin") {
  const uid = process.getuid();
  const domain = `gui/${uid}`;
  const launchdEnv = {
    ...baseInstallEnv,
    PLIST_PATH: plistPath,
    LAUNCHD_LABEL,
  };
  NodeFS.writeFileSync(
    plistPath,
    buildLaunchdPlist({
      label: LAUNCHD_LABEL,
      programArguments: ["/bin/bash", runScriptPath, stagedApp, BUNDLE_ID],
      env: launchdEnv,
      logPath: log,
    }),
    "utf8",
  );
  NodeChildProcess.spawnSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], {
    stdio: "ignore",
  });
  const bootstrap = NodeChildProcess.spawnSync("launchctl", ["bootstrap", domain, plistPath], {
    encoding: "utf8",
  });
  if (bootstrap.status === 0) {
    launchedViaLaunchd = true;
    console.log(
      `Scheduled via launchd (${domain}/${LAUNCHD_LABEL}): mattr quits in ${values["quit-delay"]}s, then reopens as /Applications/mattr.app. Log: ${log}`,
    );
  } else {
    const detail =
      bootstrap.error?.message ||
      bootstrap.stderr?.trim() ||
      bootstrap.stdout?.trim() ||
      `exit status ${bootstrap.status}`;
    console.error(`launchctl bootstrap failed (${detail}); falling back to detached spawn.`);
    NodeFS.rmSync(plistPath, { force: true });
  }
}

if (!launchedViaLaunchd) {
  const logFd = NodeFS.openSync(log, "a");
  try {
    const child = NodeChildProcess.spawn("/bin/bash", [runScriptPath, stagedApp, BUNDLE_ID], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: baseInstallEnv,
    });
    child.unref();
  } finally {
    NodeFS.closeSync(logFd);
  }
  console.log(
    `Scheduled via detached spawn: mattr quits in ${values["quit-delay"]}s, then reopens as /Applications/mattr.app. Log: ${log}`,
  );
}
