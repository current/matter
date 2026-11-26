import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { rebrandCopy, rebrandSource, rebrandTerminologyText } from "./rebrand";
import { rebrandTimelineServerText } from "../apps/web/src/components/chat/mattrRebrandTimelineText";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "translations" || entry.name === "dist") {
        continue;
      }
      results.push(...walkSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe("antimatter/rebrand", () => {
  it("rebrands product and project file names without breaking ids or GitHub App name", () => {
    expect(rebrandCopy("Open T3 Code and T3 Connect")).toBe("Open mattr and mattr Connect");
    expect(rebrandCopy("Install T3 Code for GitHub")).toBe("Install T3 Code for GitHub");
    expect(rebrandCopy("Link T3 Chat Pro")).toBe("Link T3 Chat Pro");
    expect(rebrandCopy("Listing T3 threads and Reading a T3 thread")).toBe(
      "Listing mattr threads and Reading a mattr thread",
    );
    expect(rebrandCopy("Use T3 desktop, T3 server, T3 Server, T3 home, T3 process, T3 tool")).toBe(
      "Use mattr desktop, mattr server, mattr Server, mattr home, mattr process, mattr tool",
    );
    expect(rebrandCopy("https://poke.com/integrations/new?name=T3%20Code&url=x")).toBe(
      "https://poke.com/integrations/new?name=mattr&url=x",
    );
    expect(rebrandCopy("T3 requests zero data retention; T3 could not ask")).toBe(
      "mattr requests zero data retention; mattr could not ask",
    );
    expect(rebrandCopy('Read t3.json and label: "t3.json"')).toBe(
      'Read mattr.json and label: "mattr.json"',
    );
    expect(rebrandCopy('const id = "t3.json";')).toBe('const id = "t3.json";');
  });

  it("chain-renames thread archive to hide and settle to archive", () => {
    expect(rebrandTerminologyText("Settle thread")).toBe("Archive thread");
    expect(rebrandTerminologyText("Un-settle thread")).toBe("Unarchive thread");
    expect(rebrandTerminologyText("Un-settling...")).toBe("Unarchiving...");
    expect(rebrandTerminologyText("Auto-settle behavior")).toBe("Auto-archive behavior");
    expect(rebrandTerminologyText("Settled")).toBe("Archived");
    expect(rebrandTerminologyText("Thread: Settle")).toBe("Thread: Archive");
    expect(rebrandTerminologyText("Run in the thread's worktree when the thread settles")).toBe(
      "Run in the thread's worktree when the thread is archived",
    );
    expect(
      rebrandTerminologyText(
        "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup.",
      ),
    ).toBe(
      "Remove worktrees this many days after their thread is archived. Set 0 days to remove them at the next cleanup.",
    );
    expect(
      rebrandTerminologyText(
        "{count, plural, one {{settled}/{count} agent} other {{settled}/{count} agents}}",
      ),
    ).toBe("{count, plural, one {{settled}/{count} agent} other {{settled}/{count} agents}}");
    expect(
      rebrandTerminologyText(
        "disk storage automatic delete deleted archived threads old inactive merged settled unchanged worktrees retention days project inherit off custom",
      ),
    ).toBe(
      "disk storage automatic delete deleted hidden threads old inactive merged archived unchanged worktrees retention days project inherit off custom",
    );

    expect(rebrandTerminologyText("Archive thread")).toBe("Hide thread");
    expect(rebrandTerminologyText("Archived threads")).toBe("Hidden threads");
    expect(rebrandTerminologyText("Unarchive")).toBe("Unhide");
    expect(rebrandTerminologyText("Archive confirmation")).toBe("Hide confirmation");
    expect(rebrandTerminologyText("Confirm thread archiving")).toBe("Confirm thread hiding");
    expect(rebrandTerminologyText("Archive", { isSettingsNavTitle: true })).toBe("Hidden");
    expect(rebrandTerminologyText("Failed to archive project")).toBe("Failed to archive project");
    expect(rebrandTerminologyText("Failed to unarchive project")).toBe(
      "Failed to unarchive project",
    );
  });

  it("rewrites source copy without touching identifiers, keys, routes, ZIP copy, or project archive copy", () => {
    const undoNotice = rebrandSource(
      `const SHORT_SUMMARY = {
  Settled: msg("{count, plural, =1 {Settled,} other {Settled {count},}}"),
  Archived: msg("{count, plural, =1 {Archived,} other {Archived {count},}}"),
};`,
      "/repo/apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx",
    );
    expect(undoNotice).toContain(
      'Settled: msg("{count, plural, =1 {Archived,} other {Archived {count},}}")',
    );
    expect(undoNotice).toContain(
      'Archived: msg("{count, plural, =1 {Hidden,} other {Hidden {count},}}")',
    );

    const settingsNav = rebrandSource(
      `const LABELS = {\n  "/settings/archived": msg("Archive"),\n};`,
      "/repo/apps/web/src/components/settings/settingsSearch.ts",
    );
    expect(settingsNav).toContain('"/settings/archived": msg("Hidden")');

    const archivedPanel = rebrandSource(
      `<T>\n  Archived <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />\n  {" · Created "}\n  <RelativeTime timestamp={thread.createdAt} />\n</T>`,
      "/repo/apps/web/src/components/settings/ArchivedThreadsPanel.tsx",
    );
    expect(archivedPanel).toContain("Hidden <RelativeTime timestamp={thread.archivedAt");

    const projectSettings = rebrandSource(
      `gt("Archive", { $context: "verb, archives a project" }); gt("Unarchive");`,
      "/repo/apps/web/src/components/settings/ProjectSettingsPanel.tsx",
    );
    expect(projectSettings).toBe(
      `gt("Archive", { $context: "verb, archives a project" }); gt("Unarchive");`,
    );

    const projectState = rebrandSource(
      `gt("Archived", { $context: "project state" })`,
      "/repo/apps/web/src/components/settings/SettingsScopeNotice.tsx",
    );
    expect(projectState).toBe(`gt("Archived", { $context: "project state" })`);

    const zipViewer = rebrandSource(
      `gt("Archive contents"); gt("Back to archive");`,
      "/repo/apps/web/src/components/files/BinaryViewer.tsx",
    );
    expect(zipViewer).toBe(`gt("Archive contents"); gt("Back to archive");`);

    const streamAnimations = rebrandSource(
      `name: msg("Rise & Settle", { $context: "streaming text animation" }),\ndescription: msg("New words settle in from a soft blur, with a caret", { $context: "streaming text animation" }),`,
      "/repo/apps/web/src/mattrStreamAnimation.ts",
    );
    expect(streamAnimations).toContain('msg("Rise & Settle"');
    expect(streamAnimations).toContain('msg("New words settle in from a soft blur, with a caret"');
  });

  it("rebrands server-emitted timeline summaries, notices, and errors at display time", () => {
    expect(rebrandTimelineServerText("T3 Code restarted and resumed this turn")).toBe(
      "mattr restarted and resumed this turn",
    );
    expect(rebrandTimelineServerText("T3 Code restarted and stopped background work")).toBe(
      "mattr restarted and stopped background work",
    );
    expect(
      rebrandTimelineServerText(
        "T3 Code stopped watching pull request #12 because the T3 Code server cannot use the host.",
      ),
    ).toBe("mattr stopped watching pull request #12 because the mattr server cannot use the host.");
    expect(
      rebrandTimelineServerText("T3 Code could not start this turn. Install T3 Code for GitHub."),
    ).toBe("mattr could not start this turn. Install T3 Code for GitHub.");
    expect(rebrandTimelineServerText("The agent runtime exited and stopped background work")).toBe(
      "The agent runtime exited and stopped background work",
    );
  });

  it("injects server error rebranding into translatable.ts", () => {
    const translatablePath = NodePath.join(
      REPO_ROOT,
      "packages/client-runtime/src/errors/translatable.ts",
    );
    const source = NodeFS.readFileSync(translatablePath, "utf8");
    const transformed = rebrandSource(source, translatablePath);
    expect(transformed).toContain("function __mattrRebrandServerError");
    expect(transformed).toContain("? __mattrRebrandServerError(error.message)");
    expect(transformed).toContain(
      "return text === undefined ? __mattrRebrandServerError(error.message) : resolveMarkedText(text, resolve);",
    );
  });

  it("leaves no user-facing 'settle' copy across client source files", () => {
    const roots = [
      NodePath.join(REPO_ROOT, "apps/web/src"),
      NodePath.join(REPO_ROOT, "packages/client-runtime/src"),
      NodePath.join(REPO_ROOT, "packages/shared/src"),
    ];
    const i18nCall = /\b(?:msg|gt)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
    const jsxT = /<T(?:\s[^>]*)?>([\s\S]*?)<\/T>/g;
    const remaining: string[] = [];

    for (const root of roots) {
      for (const file of walkSourceFiles(root)) {
        // Streaming text animation copy uses "Rise & Settle" / "settle in", not thread settlement.
        if (/\/(mattrStreamAnimation\.ts|MattrStreamAnimationSetting\.tsx)$/.test(file)) {
          continue;
        }
        const raw = NodeFS.readFileSync(file, "utf8");
        const transformed = rebrandSource(raw, file);

        for (const match of transformed.matchAll(i18nCall)) {
          const text = match[1]!.slice(1, -1).replaceAll("{settled}", "");
          if (/\bsettl/i.test(text)) {
            remaining.push(`${NodePath.relative(REPO_ROOT, file)}: ${text}`);
          }
        }
        if (file.endsWith(".tsx")) {
          for (const match of transformed.matchAll(jsxT)) {
            const plain = match[1]!.replace(/<[^>]*>/g, " ").replace(/\{[^}]*\}/g, " ");
            if (/\bsettl/i.test(plain)) {
              remaining.push(`${NodePath.relative(REPO_ROOT, file)}: <T>${plain.trim()}</T>`);
            }
          }
        }
      }
    }

    expect(remaining).toEqual([]);
  });

  it("leaves no un-rebranded user-facing T3 product copy across client and desktop sources", () => {
    const roots = [
      NodePath.join(REPO_ROOT, "apps/web/src"),
      NodePath.join(REPO_ROOT, "apps/desktop/src"),
      NodePath.join(REPO_ROOT, "packages/client-runtime/src"),
      NodePath.join(REPO_ROOT, "packages/shared/src"),
    ];
    const i18nCall = /\b(?:msg|gt)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
    const jsxT = /<T(?:\s[^>]*)?>([\s\S]*?)<\/T>/g;
    // Third-party/external product names that must stay intact for interop.
    const stripAllowedExternalNames = (text: string) =>
      text
        .replace(/\bT3 Code for GitHub\b/g, "")
        .replace(/\bT3 Chat\b/g, "")
        .replace(/\bT3 team\b/g, "");
    const remaining: string[] = [];

    for (const root of roots) {
      for (const file of walkSourceFiles(root)) {
        const raw = NodeFS.readFileSync(file, "utf8");
        const transformed = rebrandSource(raw, file);

        for (const match of transformed.matchAll(i18nCall)) {
          const text = stripAllowedExternalNames(match[1]!.slice(1, -1));
          if (/\bT3\b/.test(text)) {
            remaining.push(`${NodePath.relative(REPO_ROOT, file)}: ${match[1]!.slice(1, -1)}`);
          }
        }
        if (file.endsWith(".tsx")) {
          for (const match of transformed.matchAll(jsxT)) {
            const plain = match[1]!.replace(/<[^>]*>/g, " ").replace(/\{[^}]*\}/g, " ");
            if (/\bT3\b/.test(stripAllowedExternalNames(plain))) {
              remaining.push(`${NodePath.relative(REPO_ROOT, file)}: <T>${plain.trim()}</T>`);
            }
          }
        }
      }
    }

    expect(remaining).toEqual([]);
  });
});
