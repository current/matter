import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { appendEntry, readEntries, resolveLogPath, summarizeEntries } from "./friction-log.mjs";

describe("matter/friction-log", () => {
  it("refuses writes inside live ~/.antimatter/userdata", () => {
    const livePath = NodePath.join(NodeOS.homedir(), ".antimatter", "userdata", "friction.jsonl");
    expect(() => resolveLogPath(livePath)).toThrow(/userdata/);
  });

  it("appends, reads, and summarizes friction entries locally", () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "matter-friction-test-"));
    try {
      const logPath = NodePath.join(tmp, "friction.jsonl");
      appendEntry(
        {
          subject: "check:changed",
          tried: "vp run check:changed",
          expected: "fast pass",
          actual: "failed on nested worktree",
          fix: "ignore .claude/worktrees",
        },
        logPath,
      );
      appendEntry(
        {
          subject: "check:changed",
          tried: "vp run check:changed",
          expected: "cached pass",
          actual: "cache miss",
        },
        logPath,
      );
      appendEntry(
        {
          subject: "ship-local",
          tried: "node matter/ship-local.mjs",
          expected: "clean build",
          actual: "stale lockfile",
        },
        logPath,
      );

      const entries = readEntries(logPath);
      expect(entries).toHaveLength(3);
      expect(summarizeEntries(entries)).toEqual([
        ["check:changed", 2],
        ["ship-local", 1],
      ]);
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
