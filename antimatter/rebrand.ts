import type { Plugin } from "vite-plus";

// Rewrites upstream's product names in the client bundle at build time, so the rebrand
// covers every new upstream string without editing (and conflicting with) upstream files.
// JSX can wrap a name across lines; keeping its newlines keeps line numbers and spacing.
const keepNewlines = (whitespace: string) => whitespace.replace(/[^\n]/g, "");
const REPLACEMENTS: ReadonlyArray<
  readonly [RegExp, (match: string, whitespace: string) => string]
> = [
  [/\bT3(\s+)Connect\b/g, (_match, whitespace) => `mattr${whitespace}Connect`],
  // No trailing \b so suffixed forms ("T3 Codes") match. The GitHub App keeps its real name.
  [/\bT3(\s+)Code(?! for GitHub)/g, (_match, whitespace) => `mattr${keepNewlines(whitespace)}`],
];

const CLIENT_SOURCE = /\/(apps\/web\/src|packages\/[^/]+\/src)\//;

export function rebrandCopy(text: string): string {
  return REPLACEMENTS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
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
      const next = rebrandCopy(code);
      return next === code ? null : { code: next, map: null };
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => rebrandCopy(html),
    },
  };
}

// The desktop main process also builds data paths and IDs from "T3 Code", so only its
// translatable dialog copy (msg("…")) is rewritten.
export function mattrDesktopCopyPlugin() {
  return {
    name: "antimatter:rebrand-desktop-copy",
    transform(code: string, id: string) {
      if (process.env.VITEST || !/\/apps\/desktop\/src\/.*\.ts$/.test(id)) return null;
      const next = code.replace(/\bmsg\(\s*"(?:[^"\\]|\\.)*"/g, rebrandCopy);
      return next === code ? null : { code: next, map: null };
    },
  };
}
