#!/usr/bin/env node
// Builds and signs mattr locally like the nightly workflow, without waiting for GitHub; with
// --install it swaps the app into /Applications and reopens it. Nothing is pushed or published.
// Usage: node antimatter/ship-local.mjs [--install] [--ref main]

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { BUILD_ENV } from "./build-env.mjs";

const { values } = NodeUtil.parseArgs({
  options: {
    install: { type: "boolean", default: false },
    ref: { type: "string", default: "main" },
    // Seconds between handing off and quitting the live app, so the caller can finish first.
    "quit-delay": { type: "string", default: "20" },
  },
});

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
// Kept between runs so installs and builds stay incremental.
const buildRoot = NodePath.join(NodePath.dirname(repoRoot), "mattr-ship");
const signingDir = NodePath.join(NodeOS.homedir(), ".antimatter-signing");
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const FORK_URL = "https://github.com/current/mattr.git";
const NODE = "node@26.13.1";
const BUNDLE_ID = "com.current.antimatter";

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

step("Finding the newest upstream nightly");
const upstream = nightlyTags(UPSTREAM_URL)
  .sort((a, b) => a.match[2].localeCompare(b.match[2]) || Number(a.match[3]) - Number(b.match[3]))
  .at(-1);
if (!upstream) throw new Error("No upstream nightly tag found.");
const version = resolveVersion(upstream.tag);
const mainSha = read("git", ["rev-parse", values.ref], { cwd: repoRoot });
console.log(`${upstream.tag} + ${values.ref} ${mainSha.slice(0, 12)} → mattr ${version}`);

step(`Preparing the build checkout at ${buildRoot}`);
if (!NodeFS.existsSync(NodePath.join(buildRoot, ".git"))) {
  run("git", ["worktree", "add", "--detach", buildRoot, mainSha], { cwd: repoRoot });
}
git(["reset", "--hard", "--quiet"]);
git(["clean", "-fdq", "-e", "node_modules", "-e", ".t3"]);
git(["checkout", "--quiet", "--detach", mainSha]);
git([
  "fetch",
  "--quiet",
  "--no-tags",
  UPSTREAM_URL,
  `refs/tags/${upstream.tag}:refs/tags/${upstream.tag}`,
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
    upstream.tag,
  ]);
} catch {
  const files = read("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: buildRoot });
  git(["merge", "--abort"]);
  throw new Error(
    `Merging ${upstream.tag} into ${values.ref} conflicts in:\n${files}\nResolve it on main first.`,
  );
}

step("Installing dependencies");
mise(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], { cwd: buildRoot });

const releaseDir = NodePath.join(buildRoot, "release-local");
NodeFS.rmSync(releaseDir, { recursive: true, force: true });

step("Building the macOS app");
mise(
  [
    "pnpm",
    "run",
    "dist:desktop:artifact",
    "--platform",
    "mac",
    "--target",
    "dmg",
    "--arch",
    "arm64",
    "--build-version",
    version,
    "--output-dir",
    releaseDir,
  ],
  { cwd: buildRoot, env: { ...process.env, ...BUILD_ENV } },
);

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
      "--release-dir",
      releaseDir,
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
const zip = NodeFS.readdirSync(releaseDir).find((name) => name.endsWith(".zip"));
if (!zip) throw new Error(`No zip in ${releaseDir}`);
const stageDir = NodePath.join(buildRoot, "release-local-app");
NodeFS.rmSync(stageDir, { recursive: true, force: true });
run("ditto", ["-x", "-k", NodePath.join(releaseDir, zip), stageDir]);
const appName = NodeFS.readdirSync(stageDir).find((name) => name.endsWith(".app"));
const stagedApp = NodePath.join(stageDir, appName);
run("codesign", ["--verify", "--deep", "--strict", stagedApp]);
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
// Detached in its own session: quitting the live app also ends any agent that started this script.
const log = NodePath.join(buildRoot, "ship-local-install.log");
const child = NodeChildProcess.spawn(
  "/bin/bash",
  [NodePath.join(repoRoot, "antimatter/ship-local-install.sh"), stagedApp, BUNDLE_ID],
  {
    detached: true,
    stdio: ["ignore", NodeFS.openSync(log, "a"), NodeFS.openSync(log, "a")],
    env: { ...process.env, QUIT_DELAY: values["quit-delay"] },
  },
);
child.unref();
console.log(
  `mattr quits in ${values["quit-delay"]}s, then reopens as /Applications/mattr.app. Log: ${log}`,
);
