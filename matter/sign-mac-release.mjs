#!/usr/bin/env node
// Signs a built macOS app with Matter's self-signed certificate; with --package-dir or
// --release-dir it also builds the zip, DMG, blockmaps and *-mac.yml in parallel.
// Usage: node matter/sign-mac-release.mjs (--release-dir <dir> | --app-path <app> [--package-dir <dir> --version <ver> [--arch arm64] [--update-repo owner/repo]]) --identity <sha1> [--keychain <path>]

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
    "app-path": { type: "string" },
    "package-dir": { type: "string" },
    version: { type: "string" },
    arch: { type: "string", default: "arm64" },
    "update-repo": { type: "string" },
    identity: { type: "string" },
    keychain: { type: "string" },
    "product-name": { type: "string", default: "Matter" },
  },
});
const identity = values.identity?.trim();
if (!identity || Boolean(values["release-dir"]) === Boolean(values["app-path"])) {
  console.error("--identity and exactly one of --release-dir or --app-path are required");
  process.exit(1);
}
if (values["package-dir"] && (!values["app-path"] || !values.version?.trim())) {
  console.error("--package-dir requires both --app-path and --version");
  process.exit(1);
}

const { sign } = NodeModule.createRequire(NodePath.join(repoRoot, "scripts/package.json"))(
  "@electron/osx-sign",
);

const run = (cmd, args) => NodeChildProcess.execFileSync(cmd, args, { stdio: "inherit" });

function runAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
          ),
        );
      }
    });
  });
}

function loadAppBuilderTools() {
  // electron-builder's own blockmap writer and YAML library, so the output
  // matches what electron-updater expects.
  const desktopRequire = NodeModule.createRequire(
    NodePath.join(repoRoot, "apps/desktop/package.json"),
  );
  const builderRequire = NodeModule.createRequire(
    desktopRequire.resolve("electron-builder/package.json"),
  );
  const appBuilderLibDir = NodePath.dirname(builderRequire.resolve("app-builder-lib/package.json"));
  const appBuilderRequire = NodeModule.createRequire(
    NodePath.join(appBuilderLibDir, "package.json"),
  );
  const { buildBlockMap } = appBuilderRequire("./out/targets/blockmap/blockmap.js");
  const yaml = appBuilderRequire("js-yaml");
  return { buildBlockMap, yaml };
}

function resolveUpdateChannel(version) {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

function writeAppUpdateYml(appPath, updateRepo, channel) {
  const [owner, repo, ...rest] = updateRepo.trim().split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid --update-repo "${updateRepo}" (expected owner/repo)`);
  }
  NodeFS.writeFileSync(
    NodePath.join(appPath, "Contents/Resources/app-update.yml"),
    [
      `owner: ${owner}`,
      `repo: ${repo}`,
      "provider: github",
      `releaseType: ${channel === "nightly" ? "prerelease" : "release"}`,
      ...(channel === "nightly" ? ["channel: nightly"] : []),
      "updaterCacheDirName: t3code-updater",
      "",
    ].join("\n"),
  );
}

async function signApp(appPath) {
  console.log(`Signing ${NodePath.basename(appPath)} with ${identity}...`);
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
}

async function packageSignedApp({ appPath, outputDir, zipName, dmgName, workDir, buildBlockMap }) {
  const appName = NodePath.basename(appPath);
  const zipPath = NodePath.join(outputDir, zipName);
  const zipTask = (async () => {
    NodeFS.rmSync(zipPath, { force: true });
    await runAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
    return buildBlockMap(zipPath, "gzip", `${zipPath}.blockmap`);
  })();

  const dmgTask = dmgName
    ? (async () => {
        const dmgPath = NodePath.join(outputDir, dmgName);
        const stage = NodePath.join(workDir, "dmg");
        NodeFS.mkdirSync(stage, { recursive: true });
        await runAsync("ditto", [appPath, NodePath.join(stage, appName)]);
        NodeFS.symlinkSync("/Applications", NodePath.join(stage, "Applications"));
        NodeFS.rmSync(dmgPath, { force: true });
        await runAsync("hdiutil", [
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
        return buildBlockMap(dmgPath, "gzip", `${dmgPath}.blockmap`);
      })()
    : Promise.resolve(null);

  const [zipInfo, dmgInfo] = await Promise.all([zipTask, dmgTask]);
  return { zipInfo, dmgInfo };
}

if (values["app-path"] && values["package-dir"]) {
  await signAndPackageApp(
    NodePath.resolve(values["app-path"]),
    NodePath.resolve(values["package-dir"]),
    values.version.trim(),
    values.arch.trim(),
  );
} else if (values["app-path"]) {
  await signApp(NodePath.resolve(values["app-path"]));
} else {
  await signRelease(NodePath.resolve(values["release-dir"]));
}

async function signAndPackageApp(appPath, packageDir, version, arch) {
  const { buildBlockMap, yaml } = loadAppBuilderTools();
  const channel = resolveUpdateChannel(version);
  if (values["update-repo"]?.trim()) {
    // electron-builder omits app-update.yml for --target dir; write it before signing seals Resources.
    writeAppUpdateYml(appPath, values["update-repo"], channel);
  }
  await signApp(appPath);

  NodeFS.mkdirSync(packageDir, { recursive: true });
  const zipName = `${values["product-name"]}-${version}-${arch}.zip`;
  const dmgName = `${values["product-name"]}-${version}-${arch}.dmg`;
  const manifestName = `${channel}-mac.yml`;

  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "matter-sign-"));
  try {
    const { zipInfo, dmgInfo } = await packageSignedApp({
      appPath,
      outputDir: packageDir,
      zipName,
      dmgName,
      workDir: work,
      buildBlockMap,
    });
    const toEntry = (url, info) => ({
      url,
      sha512: info.sha512,
      size: info.size,
      ...(info.blockMapSize !== undefined ? { blockMapSize: info.blockMapSize } : {}),
    });
    const manifest = {
      version,
      files: [toEntry(zipName, zipInfo), toEntry(dmgName, dmgInfo)],
      path: zipName,
      sha512: zipInfo.sha512,
      releaseDate: new Date().toISOString(),
    };
    NodeFS.writeFileSync(
      NodePath.join(packageDir, manifestName),
      yaml.dump(manifest, { lineWidth: -1 }),
    );
    console.log(`Wrote ${manifestName}.`);
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
}

async function signRelease(releaseDir) {
  const { buildBlockMap, yaml } = loadAppBuilderTools();

  const manifestName = NodeFS.readdirSync(releaseDir).find((name) => /-mac\.yml$/.test(name));
  if (!manifestName) throw new Error(`No *-mac.yml manifest in ${releaseDir}`);
  const manifestPath = NodePath.join(releaseDir, manifestName);
  const manifest = yaml.load(NodeFS.readFileSync(manifestPath, "utf8"));

  const zipName = manifest.files.find((file) => file.url.endsWith(".zip"))?.url;
  const dmgName = manifest.files.find((file) => file.url.endsWith(".dmg"))?.url;
  if (!zipName) throw new Error(`${manifestName} lists no zip`);
  const zipPath = NodePath.join(releaseDir, zipName);

  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "matter-sign-"));
  try {
    run("ditto", ["-x", "-k", zipPath, work]);
    const appName = NodeFS.readdirSync(work).find((name) => name.endsWith(".app"));
    if (!appName) throw new Error(`${zipName} holds no .app`);
    const appPath = NodePath.join(work, appName);

    await signApp(appPath);

    const { zipInfo, dmgInfo } = await packageSignedApp({
      appPath,
      outputDir: releaseDir,
      zipName,
      dmgName,
      workDir: work,
      buildBlockMap,
    });
    const infoByUrl = new Map([[zipName, zipInfo]]);
    if (dmgName && dmgInfo) infoByUrl.set(dmgName, dmgInfo);

    for (const file of manifest.files) {
      let info = infoByUrl.get(file.url);
      if (!info) {
        const filePath = NodePath.join(releaseDir, file.url);
        info = await buildBlockMap(filePath, "gzip", `${filePath}.blockmap`);
      }
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
}
