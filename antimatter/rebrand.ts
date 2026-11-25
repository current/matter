import type { Plugin } from "vite-plus";

// Rewrites upstream's product names in the client bundle at build time, so the rebrand
// covers every new upstream string without editing (and conflicting with) upstream files.
// JSX can wrap a name across lines; keeping its newlines keeps line numbers and spacing.
const keepNewlines = (whitespace: string) => whitespace.replace(/[^\n]/g, "");
const REPLACEMENTS: ReadonlyArray<
  readonly [RegExp, (match: string, whitespace: string, noun?: string) => string]
> = [
  [/\bT3(\s+)Connect\b/g, (_match, whitespace) => `mattr${whitespace}Connect`],
  // No trailing \b so suffixed forms ("T3 Codes") match. The GitHub App keeps its real name.
  [/\bT3(\s+)Code(?! for GitHub)/g, (_match, whitespace) => `mattr${keepNewlines(whitespace)}`],
  [/\bT3%20Code\b/g, () => "mattr"],
  [/\bT3(\s+)(threads?\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
  [/\bT3(\s+)(desktop\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
  [/\bT3(\s+)(home\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
  [/\bT3(\s+)(process\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
  [
    /\bT3(\s+)(system footprint\b)/g,
    (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`,
  ],
  [/\bT3(\s+)(operations\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
  [/\bT3(\s+)(tool\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
  [/\bT3(\s+)(project file\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
  [
    /\bT3(\s+)(requests zero data retention\b)/g,
    (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`,
  ],
  [/\bT3(\s+)(could not\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun ?? ""}`],
];

const SERVER_NAME_REPLACEMENT: readonly [
  RegExp,
  (match: string, whitespace: string, noun: string) => string,
] = [/\bT3(\s+)([Ss]erver\b)/g, (_match, whitespace, noun) => `mattr${whitespace}${noun}`];

// The project file is mattr.json now. A string that is exactly "t3.json" is a settings-source id
// shared with the server (except the inheritance label), and the schema URL must stay upstream's.
const PROJECT_FILE_COPY = /(?<!schema\/)\bt3\.json\b/g;
const rebrandProjectFile = (text: string) =>
  text
    .replace(PROJECT_FILE_COPY, (match, offset: number, whole: string) => {
      const before = whole[offset - 1];
      const isWholeString =
        before !== undefined && `"'\``.includes(before) && whole[offset + match.length] === before;
      return isWholeString ? match : "mattr.json";
    })
    .replace(/\blabel: "t3\.json"/g, 'label: "mattr.json"');

const CLIENT_SOURCE = /\/(apps\/web\/src|packages\/[^/]+\/src)\//;
const ZIP_OR_PROJECT_FILE = /\/(components\/files\/|zip\/|ProjectSettingsPanel\.tsx$)/;
const PROJECT_ARCHIVE_PHRASE = /\b(?:un)?archiv(?:e|ed|ing)\s+projects?\b/i;

const ARCHIVE_TO_HIDE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bUnarchive\b/g, "Unhide"],
  [/\bunarchive\b/g, "unhide"],
  [/\bUnarchiving\b/g, "Unhiding"],
  [/\bunarchiving\b/g, "unhiding"],
  [/\bUnarchived\b/g, "Unhidden"],
  [/\bunarchived\b/g, "unhidden"],
  [/\bArchiving\b/g, "Hiding"],
  [/\barchiving\b/g, "hiding"],
  [/\bArchived\b/g, "Hidden"],
  [/\barchived\b/g, "hidden"],
  [/\bArchives\b/g, "Hides"],
  [/\barchives\b/g, "hides"],
  [/\bArchive\b/g, "Hide"],
  [/\barchive\b/g, "hide"],
];

const SETTLE_TO_ARCHIVE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwhen the thread settles\b/g, "when the thread is archived"],
  [/\bafter their thread settles\b/g, "after their thread is archived"],
  [/\bUn-?settling\b/g, "Unarchiving"],
  [/\bun-?settling\b/g, "unarchiving"],
  [/\bUn-?settles\b/g, "Unarchives"],
  [/\bun-?settles\b/g, "unarchives"],
  [/\bUn-?settled\b/g, "Unarchived"],
  [/\bun-?settled\b/g, "unarchived"],
  [/\bUn-?settle\b/g, "Unarchive"],
  [/\bun-?settle\b/g, "unarchive"],
  [/\bAuto-settle\b/g, "Auto-archive"],
  [/\bauto-settle\b/g, "auto-archive"],
  [/\bSettling\b/g, "Archiving"],
  [/\bsettling\b/g, "archiving"],
  [/\bSettles\b/g, "Archives"],
  [/\bsettles\b/g, "archives"],
  [/\bSettled\b/g, "Archived"],
  [/\bsettled\b/g, "archived"],
  [/\bSettle\b/g, "Archive"],
  [/\bsettle\b/g, "archive"],
  [/\bSettlement\b/g, "Archiving"],
  [/\bsettlement\b/g, "archiving"],
];

const ICU_SETTLED_PLACEHOLDER = "\uE000SETTLED_VAR\uE001";

export interface RebrandTerminologyOptions {
  readonly skipArchiveToHide?: boolean;
  readonly isSettingsNavTitle?: boolean;
}

/**
 * Chain-renames user-facing thread terminology:
 * 1. Upstream's thread "Archive" -> "Hide" / "Hidden" (skipping ZIP and project archives).
 * 2. Upstream's thread "Settle" -> "Archive" / "Archived".
 */
export function rebrandTerminologyText(
  text: string,
  options: RebrandTerminologyOptions = {},
): string {
  let result = text;

  if (!options.skipArchiveToHide && !PROJECT_ARCHIVE_PHRASE.test(result)) {
    if (options.isSettingsNavTitle && result === "Archive") {
      return "Hidden";
    }
    for (const [pattern, replacement] of ARCHIVE_TO_HIDE) {
      result = result.replace(pattern, replacement);
    }
  }

  // Keep ICU placeholder variables such as `{settled}/{count} agent` intact.
  const hasSettledPlaceholder = result.includes("{settled}");
  if (hasSettledPlaceholder) {
    result = result.replaceAll("{settled}", ICU_SETTLED_PLACEHOLDER);
  }
  for (const [pattern, replacement] of SETTLE_TO_ARCHIVE) {
    result = result.replace(pattern, replacement);
  }
  if (hasSettledPlaceholder) {
    result = result.replaceAll(ICU_SETTLED_PLACEHOLDER, "{settled}");
  }

  return result;
}

/** Rewrites plain text segments inside a `<T>...</T>` body without touching `{...}` or child tags. */
function rewriteJsxTextSegments(body: string, transform: (segment: string) => string): string {
  let output = "";
  let textStart = 0;
  let i = 0;

  const flush = (end: number) => {
    if (end > textStart) {
      output += transform(body.slice(textStart, end));
    }
  };

  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") {
      flush(i);
      const start = i;
      let depth = 1;
      i++;
      while (i < body.length && depth > 0) {
        const c = body[i];
        if (c === '"' || c === "'" || c === "`") {
          const quote = c;
          i++;
          while (i < body.length && body[i] !== quote) {
            if (body[i] === "\\") i++;
            i++;
          }
        } else if (c === "{") {
          depth++;
        } else if (c === "}") {
          depth--;
        }
        i++;
      }
      output += body.slice(start, i);
      textStart = i;
      continue;
    }
    if (ch === "<") {
      flush(i);
      const start = i;
      let braceDepth = 0;
      i++;
      while (i < body.length) {
        const c = body[i];
        if (c === '"' || c === "'" || c === "`") {
          const quote = c;
          i++;
          while (i < body.length && body[i] !== quote) {
            if (body[i] === "\\") i++;
            i++;
          }
        } else if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          if (braceDepth > 0) braceDepth--;
        } else if (c === ">" && braceDepth === 0) {
          i++;
          break;
        }
        i++;
      }
      output += body.slice(start, i);
      textStart = i;
      continue;
    }
    i++;
  }

  flush(body.length);
  return output;
}

const I18N_STRING_CALL = /\b(msg|gt)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
const JSX_T_ELEMENT = /(<T(?:\s[^>]*)?>)([\s\S]*?)(<\/T>)/g;
const PROJECT_CONTEXT = /^\s*,\s*\{[^}]*\$context\s*:\s*["'][^"']*project[^"']*["']/;
const SETTINGS_ARCHIVED_KEY = /"\/settings\/archived"\s*:\s*$/;

const RUNTIME_SERVER_ERROR_HELPER = `
function __mattrRebrandServerError(text: string): string {
  let result = text
    .replace(/\\bT3(\\s+)Connect\\b/g, "mattr$1Connect")
    .replace(/\\bT3\\s+Code(?! for GitHub)/g, "mattr")
    .replace(/\\bT3(\\s+)(threads?|[Ss]erver|home)\\b/g, "mattr$1$2");
  if (/\\bThread\\b.*\\barchiv/i.test(result)) {
    result = result
      .replace(/\\barchiving\\b/g, "hiding")
      .replace(/\\barchived\\b/g, "hidden");
  }
  if (/\\b(?:Thread|thread|Un-?settle|settling|settlement)\\b/.test(result)) {
    result = result
      .replace(/\\bUn-?settle\\b/g, "Unarchive")
      .replace(/\\bun-?settle\\b/g, "unarchive")
      .replace(/\\bsettling\\b/g, "archiving")
      .replace(/\\bsettled\\b/g, "archived")
      .replace(/\\bthen settle\\b/g, "then archive")
      .replace(/\\bbefore settlement\\b/g, "before archiving");
  }
  return result;
}
`;

/** Rewrites user-facing copy in TS/TSX source without touching code identifiers, keys, or routes. */
export function rebrandTerminologyInSource(code: string, filePath: string): string {
  const isZipOrProjectFile = ZIP_OR_PROJECT_FILE.test(filePath);
  const isSettingsSearch = /\/settingsSearch\.ts$/.test(filePath);

  let next = code.replace(
    I18N_STRING_CALL,
    (full, _fn: string, literal: string, offset: number) => {
      const after = code.slice(offset + full.length, offset + full.length + 180);
      const isProjectContext = PROJECT_CONTEXT.test(after);
      const before = isSettingsSearch ? code.slice(Math.max(0, offset - 40), offset) : "";
      const isSettingsNavTitle = isSettingsSearch && SETTINGS_ARCHIVED_KEY.test(before);
      const quote = literal[0]!;
      const inner = literal.slice(1, -1);
      const replaced = rebrandTerminologyText(inner, {
        skipArchiveToHide: isZipOrProjectFile || isProjectContext,
        isSettingsNavTitle,
      });
      if (replaced === inner) return full;
      return `${full.slice(0, full.length - literal.length)}${quote}${replaced}${quote}`;
    },
  );

  if (filePath.endsWith(".tsx")) {
    next = next.replace(JSX_T_ELEMENT, (full, open: string, body: string, close: string) => {
      const replaced = rewriteJsxTextSegments(body, (segment) =>
        rebrandTerminologyText(segment, { skipArchiveToHide: isZipOrProjectFile }),
      );
      return replaced === body ? full : `${open}${replaced}${close}`;
    });
  }

  if (/\/archivedThreads\.ts$/.test(filePath)) {
    next = next.replace('"Failed to load archived threads."', '"Failed to load hidden threads."');
  }

  if (/\/errors\/translatable\.ts$/.test(filePath)) {
    const wrapped = next
      .replace(
        "? error.message\n    : null;",
        "? __mattrRebrandServerError(error.message)\n    : null;",
      )
      .replace(
        "return text === undefined ? error.message : resolveMarkedText(text, resolve);",
        "return text === undefined ? __mattrRebrandServerError(error.message) : resolveMarkedText(text, resolve);",
      );
    if (wrapped !== next) {
      next = `${RUNTIME_SERVER_ERROR_HELPER}\n${wrapped}`;
    }
  }

  return next;
}

export function rebrandCopy(text: string, options?: { readonly skipServerName?: boolean }): string {
  const replaced = REPLACEMENTS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
  const withServer = options?.skipServerName
    ? replaced
    : replaced.replace(SERVER_NAME_REPLACEMENT[0], SERVER_NAME_REPLACEMENT[1]);
  return rebrandProjectFile(withServer);
}

export function rebrandSource(code: string, filePath: string): string {
  // errors/transport.ts matches raw WebSocket error messages from upstream servers.
  const skipServerName = /\/errors\/transport\.ts$/.test(filePath);
  const branded = rebrandCopy(code, { skipServerName });
  return /\.(ts|tsx)$/.test(filePath) ? rebrandTerminologyInSource(branded, filePath) : branded;
}

export function mattrRebrandPlugin(): Plugin {
  return {
    name: "antimatter:rebrand",
    enforce: "pre",
    transform(code, id) {
      // Tests assert upstream's English copy.
      if (process.env.VITEST) return null;
      const path = id.split("?")[0] ?? id;
      if (path.includes("/node_modules/") || !CLIENT_SOURCE.test(path)) return null;
      if (!/\.(ts|tsx|json)$/.test(path)) return null;
      const next = rebrandSource(code, path);
      return next === code ? null : { code: next, map: null };
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => rebrandCopy(html),
    },
  };
}

// The desktop main process also builds data paths and IDs from "T3 Code", so only its
// translatable dialog copy (msg("…")) and desktop i18n catalogs are rewritten.
export function mattrDesktopCopyPlugin() {
  return {
    name: "antimatter:rebrand-desktop-copy",
    transform(code: string, id: string) {
      if (process.env.VITEST) return null;
      const path = id.split("?")[0] ?? id;
      if (/\/apps\/desktop\/src\/i18n\/translations\/[^/]+\.json$/.test(path)) {
        const next = rebrandCopy(code);
        return next === code ? null : { code: next, map: null };
      }
      if (!/\/apps\/desktop\/src\/.*\.ts$/.test(path)) return null;
      const next = code.replace(/\bmsg\(\s*"(?:[^"\\]|\\.)*"/g, (match) =>
        rebrandSource(match, path),
      );
      return next === code ? null : { code: next, map: null };
    },
  };
}
