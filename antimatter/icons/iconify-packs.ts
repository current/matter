// Build-time only: turns the mapped names into SVG bodies from the installed @iconify-json sets.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build plugins run before an Effect runtime exists.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build plugins run before an Effect runtime exists.
import * as NodePath from "node:path";

import { ICON_FAMILIES, PACK_ICON_NAMES, type IconFamily } from "./icon-pack-map";
import type { IconPackSource } from "./iconPack";

interface IconifyIcon {
  readonly body: string;
  readonly width?: number;
  readonly height?: number;
  readonly left?: number;
  readonly top?: number;
}
interface IconifyAlias {
  readonly parent: string;
  readonly hFlip?: boolean;
  readonly vFlip?: boolean;
  readonly rotate?: number;
}
export interface IconifySet {
  readonly icons: Readonly<Record<string, IconifyIcon>>;
  readonly aliases?: Readonly<Record<string, IconifyAlias>>;
  readonly width?: number;
  readonly height?: number;
}

/** [svg body, viewBox] */
export type PackGlyph = readonly [body: string, viewBox: string];

// Arrows, chevrons and other line glyphs have no solid form; packs may draw their line cut instead.
const OPEN_GLYPH =
  /^(Arrow|Chevron|Corner|XIcon$|X$|Plus|Minus|Check$|CheckIcon$|Search|RefreshCw|Rotate|Undo|Redo|Link|Unlink|Paperclip|ExternalLink|Download|Upload|Loader|Trending|Maximize|Minimize|FoldVertical|UnfoldVertical|Grip|Ellipsis|More|Type|Pilcrow|Hash|AtSign|TextIcon|WrapText|TextWrap|Git|Activity|Audio|Route|Workflow|Languages|Reply|ListTree|FolderTree|ListPlus|ListChecks|ListTodo|Code|Quote|Scan)/;

interface IconifyPack {
  readonly family: IconFamily;
  readonly suffixes: ReadonlyArray<string>;
  /** Replaces `suffixes` for open glyphs, whose filled forms are boxed or turn into triangles. */
  readonly openSuffixes?: ReadonlyArray<string>;
  /** Phosphor style that fills a name this family lacks; null leaves it to lucide. */
  readonly fallback: "-fill" | "-duotone" | null;
}

export const ICONIFY_PACKS: Readonly<Record<IconPackSource, IconifyPack>> = {
  "solar-bold": { family: "solar", suffixes: ["-bold"], fallback: "-fill" },
  "solar-duotone": { family: "solar", suffixes: ["-bold-duotone", "-bold"], fallback: "-duotone" },
  "phosphor-fill": {
    family: "ph",
    suffixes: ["-fill"],
    openSuffixes: ["-bold", "-fill"],
    fallback: null,
  },
  "heroicons-solid": {
    family: "heroicons",
    suffixes: ["-20-solid", "-solid", "-16-solid"],
    fallback: "-fill",
  },
  "remix-fill": {
    family: "ri",
    suffixes: ["-fill", ""],
    openSuffixes: ["-line", "-fill", ""],
    fallback: "-fill",
  },
  "mingcute-fill": { family: "mingcute", suffixes: ["-fill"], fallback: "-fill" },
  "fluent-filled": {
    family: "fluent",
    suffixes: ["-20-filled", "-24-filled", "-16-filled", "-28-filled", "-12-filled"],
    fallback: "-fill",
  },
  "ionicons-solid": { family: "ion", suffixes: [""], fallback: "-fill" },
  "material-rounded-fill": {
    family: "material-symbols",
    suffixes: ["-rounded", ""],
    fallback: "-fill",
  },
  "tabler-filled": {
    family: "tabler",
    suffixes: ["-filled"],
    openSuffixes: ["-filled", ""],
    fallback: "-fill",
  },
  hugeicons: { family: "hugeicons", suffixes: [""], fallback: null },
};

// Original squircle chrome for the Synara pack: Hugeicons' own panel glyphs are thin outlines.
const SQUIRCLE = `<rect x="3" y="3.5" width="18" height="17" rx="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
const CUSTOM_GLYPHS: Readonly<Partial<Record<IconPackSource, Record<string, PackGlyph>>>> = {
  hugeicons: {
    PanelLeftIcon: [
      `${SQUIRCLE}<rect x="6.25" y="6.75" width="4.25" height="10.5" rx="1.75" fill="currentColor"/>`,
      "0 0 24 24",
    ],
    PanelLeftCloseIcon: [
      `${SQUIRCLE}<rect x="6.25" y="6.75" width="4.25" height="10.5" rx="1.75" fill="currentColor"/><path d="m16 9.5-2.5 2.5 2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
      "0 0 24 24",
    ],
    PanelRightIcon: [
      `${SQUIRCLE}<rect x="13.5" y="6.75" width="4.25" height="10.5" rx="1.75" fill="currentColor"/>`,
      "0 0 24 24",
    ],
    PanelBottomIcon: [
      `${SQUIRCLE}<rect x="6.25" y="13" width="11.5" height="4.25" rx="1.75" fill="currentColor"/>`,
      "0 0 24 24",
    ],
    MessageSquarePlusIcon: [
      `<path d="M8.5 3.5h7a5.5 5.5 0 0 1 5.5 5.5v4a5.5 5.5 0 0 1-5.5 5.5h-3.2l-4.1 2.7a.6.6 0 0 1-.93-.5v-2.3A5.5 5.5 0 0 1 3 13V9a5.5 5.5 0 0 1 5.5-5.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 7.75v6.5M8.75 11h6.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
      "0 0 24 24",
    ],
  },
};

const familyColumn = (family: IconFamily) => ICON_FAMILIES.indexOf(family);

export function readIconifySet(root: string, family: IconFamily): IconifySet {
  const file = NodePath.join(root, "node_modules", "@iconify-json", family, "icons.json");
  return JSON.parse(NodeFS.readFileSync(file, "utf8"));
}

/** Resolves aliases (with their flips and quarter turns) to a drawable glyph. */
export function iconifyGlyph(set: IconifySet, name: string): PackGlyph | null {
  const transforms: IconifyAlias[] = [];
  let current = name;
  for (let depth = 0; depth < 8; depth += 1) {
    const icon = set.icons[current];
    if (icon) {
      const width = icon.width ?? set.width ?? 16;
      const height = icon.height ?? set.height ?? 16;
      let body = icon.body;
      for (const alias of transforms) {
        const ops: string[] = [];
        if (alias.rotate) ops.push(`rotate(${alias.rotate * 90} ${width / 2} ${height / 2})`);
        if (alias.hFlip) ops.push(`translate(${width} 0) scale(-1 1)`);
        if (alias.vFlip) ops.push(`translate(0 ${height}) scale(1 -1)`);
        if (ops.length > 0) body = `<g transform="${ops.join(" ")}">${body}</g>`;
      }
      return [body, `${icon.left ?? 0} ${icon.top ?? 0} ${width} ${height}`];
    }
    const alias = set.aliases?.[current];
    if (!alias) return null;
    transforms.unshift(alias);
    current = alias.parent;
  }
  return null;
}

export function hasIconifyIcon(set: IconifySet, name: string): boolean {
  return name in set.icons || name in (set.aliases ?? {});
}

/** Which full Iconify name `pack` draws for a lucide name, if its own family has one. */
export function packIconName(
  set: IconifySet,
  source: IconPackSource,
  lucideName: string,
): string | null {
  const pack = ICONIFY_PACKS[source];
  const base = PACK_ICON_NAMES[lucideName]?.[familyColumn(pack.family)];
  if (!base) return null;
  const suffixes = (OPEN_GLYPH.test(lucideName) && pack.openSuffixes) || pack.suffixes;
  for (const suffix of suffixes) {
    const name = base + suffix;
    if (!hasIconifyIcon(set, name)) continue;
    if (pack.family === "ri" && suffix === "" && hasIconifyIcon(set, `${base}-line`)) continue;
    if (pack.family === "ion" && /-(outline|sharp)$/.test(name)) continue;
    return name;
  }
  return null;
}

/** Every glyph a pack draws, by lucide name. Names it can't fill stay out and draw lucide. */
export function packGlyphs(
  root: string,
  source: IconPackSource,
  lucideNames: ReadonlyArray<string>,
): Record<string, PackGlyph> {
  const pack = ICONIFY_PACKS[source];
  const set = readIconifySet(root, pack.family);
  const phosphor = pack.fallback && readIconifySet(root, "ph");
  const custom = CUSTOM_GLYPHS[source] ?? {};
  const glyphs: Record<string, PackGlyph> = {};
  for (const lucideName of lucideNames) {
    const own = packIconName(set, source, lucideName);
    let glyph = custom[lucideName] ?? (own ? iconifyGlyph(set, own) : null);
    if (!glyph && phosphor && pack.fallback) {
      const base = PACK_ICON_NAMES[lucideName]?.[familyColumn("ph")];
      const style =
        pack.fallback === "-fill" && OPEN_GLYPH.test(lucideName) ? "-bold" : pack.fallback;
      if (base)
        glyph =
          iconifyGlyph(phosphor, base + style) ?? iconifyGlyph(phosphor, base + pack.fallback);
    }
    if (glyph) glyphs[lucideName] = glyph;
  }
  return glyphs;
}
