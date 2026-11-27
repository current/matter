#!/usr/bin/env node
// Local-only agent friction log (~/.antimatter/friction-log.jsonl, zero telemetry).
// Usage: node matter/friction-log.mjs <add|list|summary> [options]

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const DEFAULT_LOG_PATH = NodePath.join(NodeOS.homedir(), ".antimatter", "friction-log.jsonl");
const LIVE_USERDATA_DIR = NodePath.join(NodeOS.homedir(), ".antimatter", "userdata");

export function resolveLogPath(override) {
  const p = NodePath.resolve(override ?? process.env.MATTER_FRICTION_LOG_PATH ?? DEFAULT_LOG_PATH);
  const inLiveUserdata =
    p === LIVE_USERDATA_DIR ||
    (p.startsWith(`${LIVE_USERDATA_DIR}${NodePath.sep}`) &&
      !p.startsWith(`${NodePath.join(LIVE_USERDATA_DIR, "antigravity-tmp")}${NodePath.sep}`));
  if (inLiveUserdata) {
    throw new Error("Refusing to write friction log inside ~/.antimatter/userdata.");
  }
  return p;
}

export function appendEntry(entry, logPath = resolveLogPath()) {
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    subject: String(entry.subject ?? "").trim(),
    tried: String(entry.tried ?? "").trim(),
    expected: String(entry.expected ?? "").trim(),
    actual: String(entry.actual ?? "").trim(),
    fix: String(entry.fix ?? "").trim() || null,
    provider: String(entry.provider ?? "").trim() || null,
  };
  if (!record.subject || !record.tried || !record.expected || !record.actual) {
    throw new Error("add requires --subject, --tried, --expected, and --actual.");
  }
  NodeFS.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function readEntries(logPath = resolveLogPath()) {
  if (!NodeFS.existsSync(logPath)) return [];
  const entries = [];
  for (const line of NodeFS.readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

export function summarizeEntries(entries) {
  const counts = new Map();
  for (const e of entries) {
    const key = e.subject || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "add") {
      const { values } = NodeUtil.parseArgs({
        args: rest,
        options: {
          subject: { type: "string" },
          tried: { type: "string" },
          expected: { type: "string" },
          actual: { type: "string" },
          fix: { type: "string" },
          provider: { type: "string" },
          file: { type: "string" },
        },
      });
      const rec = appendEntry(values, resolveLogPath(values.file));
      console.log(`Logged friction entry [${rec.subject}] to ${resolveLogPath(values.file)}`);
    } else if (cmd === "list") {
      const { values } = NodeUtil.parseArgs({
        args: rest,
        options: { limit: { type: "string", default: "20" }, file: { type: "string" } },
      });
      const entries = readEntries(resolveLogPath(values.file));
      const limit = Math.max(1, Number.parseInt(values.limit, 10) || 20);
      const slice = entries.slice(-limit).reverse();
      if (slice.length === 0) {
        console.log("No friction entries logged yet.");
      } else {
        for (const e of slice) {
          console.log(
            `[${e.ts}] (${e.subject}) tried: ${e.tried} | expected: ${e.expected} | actual: ${e.actual}${e.fix ? ` | fix: ${e.fix}` : ""}`,
          );
        }
      }
    } else if (cmd === "summary") {
      const { values } = NodeUtil.parseArgs({ args: rest, options: { file: { type: "string" } } });
      const entries = readEntries(resolveLogPath(values.file));
      const rows = summarizeEntries(entries);
      console.log(`Total friction entries: ${entries.length}`);
      for (const [subject, count] of rows) {
        console.log(`  ${String(count).padStart(4)}  ${subject}`);
      }
    } else {
      console.error("Usage: node matter/friction-log.mjs <add|list|summary> [options]");
      process.exit(1);
    }
  } catch (err) {
    console.error(`friction-log failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
