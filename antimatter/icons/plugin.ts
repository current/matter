// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build plugins run before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build plugins run before an Effect runtime exists.
import * as NodeFS from "node:fs";

import type { Plugin } from "vite-plus";

import type { SfGlyph } from "./sfSymbolIcon";
import type { IconPackSource } from "./iconPack";
import { ICONIFY_PACKS, packGlyphs } from "./iconify-packs";
import { SF_FILL_FOR_SYMBOL, SF_SYMBOL_FOR_LUCIDE } from "./sf-symbol-map";

const ICONS_DIR = import.meta.dirname;
const POINT_SIZE = 20;
const VIRTUAL_ID = "\0mattr:lucide";
const PACK_PREFIX = "virtual:mattr-icon-pack/";
const CLIENT_SOURCE = /\/(apps\/web\/src|packages\/[^/]+\/src)\//;

// The titlebar's history buttons are chevrons, as in a macOS browser toolbar; arrows elsewhere stay.
const TITLEBAR_IMPORTER = "/apps/web/src/components/sidebar/SidebarChrome.tsx";
const TITLEBAR_OVERRIDES: Readonly<Record<string, string>> = {
  ArrowLeftIcon: "ChevronLeftIcon",
  ArrowRightIcon: "ChevronRightIcon",
};

// Saved project icons come from lucide's whole catalog in a lazy chunk; routing that namespace
// import through the swap module would pull every lucide icon into the eager bundle.
const LAZY_CATALOG_IMPORTER = "/apps/web/src/lib/lucideIconByName.ts";

const PACK_SOURCES = Object.keys(ICONIFY_PACKS) as IconPackSource[];
const isPackSource = (value: string): value is IconPackSource => value in ICONIFY_PACKS;

const isExportName = (name: string) => /^[A-Z]\w*$/.test(name);

const mappedNames = () => Object.keys(SF_SYMBOL_FOR_LUCIDE).filter(isExportName).toSorted();

const symbolNames = () =>
  [...new Set(Object.values(SF_SYMBOL_FOR_LUCIDE).filter((name) => name !== null))].toSorted();

// A symbol's filled form: an explicit pick, else ".fill" after its last part or before any later
// one (bell.slash → bell.slash.fill, person.2 → person.2.fill, pin.slash → pin.slash.fill).
const fillCandidates = (symbol: string) => {
  const parts = symbol.split(".");
  const inserted = parts
    .slice(1)
    .map((_, index) =>
      [
        ...parts.slice(0, parts.length - 1 - index),
        "fill",
        ...parts.slice(parts.length - 1 - index),
      ].join("."),
    );
  return [SF_FILL_FOR_SYMBOL[symbol], `${symbol}.fill`, ...inserted].filter(
    (name): name is string => typeof name === "string",
  );
};

const run = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// SF Symbols are Apple's, so they are rendered from the build Mac's own system and cached outside
// the repo. Each symbol draws its filled form when one exists (open glyphs like chevrons have none).
// Anywhere else (or if Swift is missing) the SF pack draws lucide.
function loadGlyphs(cacheFile: string): Record<string, SfGlyph> | null {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- A Vite plugin runs before any Effect runtime.
  if (process.platform !== "darwin") return null;
  try {
    const symbols = symbolNames();
    const names = [...new Set(symbols.flatMap((symbol) => [symbol, ...fillCandidates(symbol)]))];
    const key = `fill|${POINT_SIZE}|${run("sw_vers", ["-productVersion"]).trim()}|${names.join(",")}`;
    try {
      const cached = JSON.parse(NodeFS.readFileSync(cacheFile, "utf8"));
      if (cached.key === key) return cached.glyphs;
    } catch {}
    const extracted: Record<string, SfGlyph> = JSON.parse(
      run("swift", [`${ICONS_DIR}/extract-sf-symbols.swift`, String(POINT_SIZE), ...names]),
    );
    const glyphs: Record<string, SfGlyph> = {};
    for (const symbol of symbols) {
      const filled = fillCandidates(symbol).find((name) => extracted[name]);
      const glyph = extracted[filled ?? symbol];
      if (glyph) glyphs[symbol] = glyph;
    }
    NodeFS.writeFileSync(cacheFile, JSON.stringify({ key, glyphs }));
    return glyphs;
  } catch (error) {
    console.warn("[mattr] SF Symbols unavailable, the SF pack keeps lucide icons:", error);
    return null;
  }
}

/** A lazy pack chunk: each distinct SVG body once, then lucide name → [body, viewBox]. */
function packModule(root: string, source: IconPackSource) {
  const glyphs = packGlyphs(root, source, mappedNames());
  const bodies: string[] = [];
  const index = new Map<string, number>();
  const entries = Object.entries(glyphs).map(([name, [body, viewBox]]) => {
    let at = index.get(body);
    if (at === undefined) {
      at = bodies.push(body) - 1;
      index.set(body, at);
    }
    return `${JSON.stringify(name)}: [b[${at}], ${JSON.stringify(viewBox)}]`;
  });
  return `const b = ${JSON.stringify(bodies)};\nexport const icons = { ${entries.join(", ")} };`;
}

function iconModule(
  glyphs: Record<string, SfGlyph> | null,
  overrides: Readonly<Record<string, string>>,
) {
  const names = [...new Set([...mappedNames(), ...Object.keys(overrides)])];
  const targets = [...new Set(names.map((name) => overrides[name] ?? name))];
  const glyphData: Record<string, SfGlyph> = {};
  for (const target of targets) {
    const symbol = SF_SYMBOL_FOR_LUCIDE[target];
    const glyph = symbol ? glyphs?.[symbol] : undefined;
    if (symbol && glyph) glyphData[symbol] = glyph;
  }
  const sfFor = (target: string) => {
    const symbol = SF_SYMBOL_FOR_LUCIDE[target];
    return symbol && glyphData[symbol]
      ? `createSfSymbolIcon(react, ${JSON.stringify(target)}, glyphs[${JSON.stringify(symbol)}])`
      : "null";
  };
  return [
    `import { createElement, useId, useSyncExternalStore } from "react";`,
    `import { ${targets.map((target) => `${target} as __lucide_${target}`).join(", ")} } from "lucide-react";`,
    `import { createSfSymbolIcon } from ${JSON.stringify(`${ICONS_DIR}/sfSymbolIcon.ts`)};`,
    `import { createPackIcon } from ${JSON.stringify(`${ICONS_DIR}/packIcon.ts`)};`,
    `import { registerIconPackLoaders } from ${JSON.stringify(`${ICONS_DIR}/iconPack.ts`)};`,
    `export * from "lucide-react";`,
    `registerIconPackLoaders({`,
    ...PACK_SOURCES.map(
      (source) =>
        `  ${JSON.stringify(source)}: () => import(${JSON.stringify(`${PACK_PREFIX}${source}`)}),`,
    ),
    `});`,
    `const react = { createElement, useId, useSyncExternalStore };`,
    `const glyphs = ${JSON.stringify(glyphData)};`,
    ...names.map((name) => {
      const target = overrides[name] ?? name;
      return `export const ${name} = createPackIcon(react, { name: ${JSON.stringify(name)}, packKey: ${JSON.stringify(target)}, Lucide: __lucide_${target}, Sf: ${sfFor(target)} });`;
    }),
  ].join("\n");
}

/**
 * Swaps the app's lucide-react icons for the icon pack picked in Settings → Appearance (filled SF
 * Symbols by default, the icon set of the macOS browser the shell mimics). Switching needs no reload.
 */
export function mattrIconsPlugin(): Plugin {
  let enabled = false;
  let glyphs: Record<string, SfGlyph> | null = null;
  let root = "";
  return {
    name: "antimatter:icons",
    enforce: "pre",
    configResolved(config) {
      if (process.env.VITEST) return;
      enabled = true;
      root = config.root;
      NodeFS.mkdirSync(config.cacheDir, { recursive: true });
      glyphs = loadGlyphs(`${config.cacheDir}/mattr-sf-symbols.json`);
    },
    resolveId(source, importer) {
      if (!enabled) return null;
      if (source.startsWith(PACK_PREFIX)) return `\0${source}`;
      if (source !== "lucide-react" || !importer) return null;
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
      if (!enabled) return null;
      if (id.startsWith(`\0${PACK_PREFIX}`)) {
        const source = id.slice(PACK_PREFIX.length + 1);
        if (!isPackSource(source)) return null;
        return packModule(root, source);
      }
      if (!id.startsWith(VIRTUAL_ID)) return null;
      return iconModule(glyphs, id.endsWith(":titlebar") ? TITLEBAR_OVERRIDES : {});
    },
  };
}
