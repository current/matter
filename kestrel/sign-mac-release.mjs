#!/usr/bin/env node
// Re-signs a built macOS release with Kestrel's self-signed certificate and rebuilds the
// zip, DMG, blockmaps and update manifest to match. Runs after electron-builder so upstream merges stay clean.
// Usage: node kestrel/sign-mac-release.mjs --release-dir <dir> --identity <sha1> [--keychain <path>]

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const { values } = NodeUtil.parseArgs({
  options: {
    "release-dir": { type: "string" },
    identity: { type: "string" },
    keychain: { type: "string" },
    "product-name": { type: "string", default: "Kestrel" },
  },
});
const releaseDir = NodePath.resolve(values["release-dir"] ?? "");
const identity = values.identity?.trim();
if (!values["release-dir"] || !identity) {
  console.error("--release-dir and --identity are required");
  process.exit(1);
}

// electron-builder's own blockmap writer and YAML library, so the output
// matches what electron-updater expects.
const desktopRequire = NodeModule.createRequire(
  NodePath.join(repoRoot, "apps/desktop/package.json"),
);
const builderRequire = NodeModule.createRequire(
  desktopRequire.resolve("electron-builder/package.json"),
);
const appBuilderLibDir = NodePath.dirname(builderRequire.resolve("app-builder-lib/package.json"));
const { buildBlockMap } = NodeModule.createRequire(NodePath.join(appBuilderLibDir, "package.json"))(
  "./out/targets/blockmap/blockmap.js",
);
const yaml = NodeModule.createRequire(NodePath.join(appBuilderLibDir, "package.json"))("js-yaml");
const { sign } = NodeModule.createRequire(NodePath.join(repoRoot, "scripts/package.json"))(
  "@electron/osx-sign",
);

const run = (cmd, args) => NodeChildProcess.execFileSync(cmd, args, { stdio: "inherit" });

const manifestName = NodeFS.readdirSync(releaseDir).find((name) => /-mac\.yml$/.test(name));
if (!manifestName) throw new Error(`No *-mac.yml manifest in ${releaseDir}`);
const manifestPath = NodePath.join(releaseDir, manifestName);
const manifest = yaml.load(NodeFS.readFileSync(manifestPath, "utf8"));

const zipName = manifest.files.find((file) => file.url.endsWith(".zip"))?.url;
const dmgName = manifest.files.find((file) => file.url.endsWith(".dmg"))?.url;
if (!zipName) throw new Error(`${manifestName} lists no zip`);
const zipPath = NodePath.join(releaseDir, zipName);

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kestrel-sign-"));
try {
  run("ditto", ["-x", "-k", zipPath, work]);
  const appName = NodeFS.readdirSync(work).find((name) => name.endsWith(".app"));
  if (!appName) throw new Error(`${zipName} holds no .app`);
  const appPath = NodePath.join(work, appName);

  console.log(`Signing ${appName} with ${identity}...`);
  await sign({
    app: appPath,
    identity,
    identityValidation: false,
    ...(values.keychain ? { keychain: values.keychain } : {}),
    platform: "darwin",
    // No hardened runtime: it exists for notarization, which needs an Apple
    // Developer ID, and its library validation rejects self-signed code.
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
  });
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  NodeFS.rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);

  if (dmgName) {
    const dmgPath = NodePath.join(releaseDir, dmgName);
    const stage = NodePath.join(work, "dmg");
    NodeFS.mkdirSync(stage);
    run("ditto", [appPath, NodePath.join(stage, appName)]);
    NodeFS.symlinkSync("/Applications", NodePath.join(stage, "Applications"));
    NodeFS.rmSync(dmgPath, { force: true });
    run("hdiutil", [
      "create",
      "-volname",
      values["product-name"],
      "-srcfolder",
      stage,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ]);
  }

  for (const file of manifest.files) {
    const filePath = NodePath.join(releaseDir, file.url);
    const info = await buildBlockMap(filePath, "gzip", `${filePath}.blockmap`);
    file.sha512 = info.sha512;
    file.size = info.size;
    if (info.blockMapSize !== undefined) file.blockMapSize = info.blockMapSize;
    if (file.url === manifest.path) manifest.sha512 = info.sha512;
  }
  NodeFS.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));
  console.log(`Updated ${manifestName}.`);
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
