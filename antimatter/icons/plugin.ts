// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build plugins run before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build plugins run before an Effect runtime exists.
import * as NodeFS from "node:fs";

import type { Plugin } from "vite-plus";

import type { SfGlyph } from "./sfSymbolIcon";
import { SF_SYMBOL_FOR_LUCIDE } from "./sf-symbol-map";

const ICONS_DIR = import.meta.dirname;
const POINT_SIZE = 20;
const VIRTUAL_ID = "\0mattr:lucide";
const CLIENT_SOURCE = /\/(apps\/web\/src|packages\/[^/]+\/src)\//;

// The titlebar's history buttons are chevrons, as in a macOS browser toolbar; arrows elsewhere stay.
const TITLEBAR_IMPORTER = "/apps/web/src/components/sidebar/SidebarChrome.tsx";
const TITLEBAR_OVERRIDES: Readonly<Record<string, string>> = {
  ArrowLeftIcon: "chevron.left",
  ArrowRightIcon: "chevron.right",
};

// Saved project icons come from lucide's whole catalog in a lazy chunk; routing that namespace
// import through the swap module would pull every lucide icon into the eager bundle.
const LAZY_CATALOG_IMPORTER = "/apps/web/src/lib/lucideIconByName.ts";

const symbolNames = () =>
  [
    ...new Set([
      ...Object.values(SF_SYMBOL_FOR_LUCIDE).filter((name) => name !== null),
      ...Object.values(TITLEBAR_OVERRIDES),
    ]),
  ].toSorted();

const run = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// SF Symbols are Apple's, so they are rendered from the build Mac's own system and cached outside
// the repo. Anywhere else (or if Swift is missing) the app keeps lucide.
function loadGlyphs(cacheFile: string): Record<string, SfGlyph> | null {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- A Vite plugin runs before any Effect runtime.
  if (process.platform !== "darwin") return null;
  try {
    const names = symbolNames();
    const key = `${POINT_SIZE}|${run("sw_vers", ["-productVersion"]).trim()}|${names.join(",")}`;
    try {
      const cached = JSON.parse(NodeFS.readFileSync(cacheFile, "utf8"));
      if (cached.key === key) return cached.glyphs;
    } catch {}
    const glyphs = JSON.parse(
      run("swift", [`${ICONS_DIR}/extract-sf-symbols.swift`, String(POINT_SIZE), ...names]),
    );
    NodeFS.writeFileSync(cacheFile, JSON.stringify({ key, glyphs }));
    return glyphs;
  } catch (error) {
    console.warn("[mattr] SF Symbols unavailable, keeping lucide icons:", error);
    return null;
  }
}

function iconModule(glyphs: Record<string, SfGlyph>, overrides: Readonly<Record<string, string>>) {
  const mapping = { ...SF_SYMBOL_FOR_LUCIDE, ...overrides };
  const used = Object.entries(mapping).filter(
    (entry): entry is [string, string] =>
      entry[1] !== null && glyphs[entry[1]] !== undefined && /^[A-Z]\w*$/.test(entry[0]),
  );
  const glyphData = Object.fromEntries(used.map(([, symbol]) => [symbol, glyphs[symbol]]));
  return [
    `import { createElement, useId } from "react";`,
    `import { createSfSymbolIcon } from ${JSON.stringify(`${ICONS_DIR}/sfSymbolIcon.ts`)};`,
    `export * from "lucide-react";`,
    `const react = { createElement, useId };`,
    `const glyphs = ${JSON.stringify(glyphData)};`,
    ...used.map(
      ([name, symbol]) =>
        `export const ${name} = createSfSymbolIcon(react, ${JSON.stringify(name)}, glyphs[${JSON.stringify(symbol)}]);`,
    ),
  ].join("\n");
}

/** Swaps the app's lucide-react icons for SF Symbols, the icon set of the macOS browser it mimics. */
export function mattrIconsPlugin(): Plugin {
  let glyphs: Record<string, SfGlyph> | null = null;
  return {
    name: "antimatter:icons",
    enforce: "pre",
    configResolved(config) {
      if (process.env.VITEST) return;
      NodeFS.mkdirSync(config.cacheDir, { recursive: true });
      glyphs = loadGlyphs(`${config.cacheDir}/mattr-sf-symbols.json`);
    },
    resolveId(source, importer) {
      if (source !== "lucide-react" || glyphs === null || !importer) return null;
      const path = importer.split("?")[0] ?? importer;
      if (
        path.startsWith("\0") ||
        path.includes("/node_modules/") ||
        !CLIENT_SOURCE.test(path) ||
        path.endsWith(LAZY_CATALOG_IMPORTER)
      ) {
        return null;
      }
      return path.endsWith(TITLEBAR_IMPORTER) ? `${VIRTUAL_ID}:titlebar` : VIRTUAL_ID;
    },
    load(id) {
      if (glyphs === null || !id.startsWith(VIRTUAL_ID)) return null;
      return iconModule(glyphs, id.endsWith(":titlebar") ? TITLEBAR_OVERRIDES : {});
    },
  };
}
