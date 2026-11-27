import {
  type ClaudeCloudRemoteSession,
  ProviderInstanceId,
  ThreadId,
  type TrackedClaudeCloudSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { claudeCloudReport, watchedSessions } from "./ClaudeCloudWatcher.ts";

const CREATED_ISO = "2026-11-27T12:00:00.000Z";
const CREATED = Date.parse(CREATED_ISO);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const MINUTE = 60_000;

const tracked = (patch: Partial<TrackedClaudeCloudSession> = {}): TrackedClaudeCloudSession => ({
  id: "cse_abc",
  url: "https://claude.ai/code/cse_abc",
  title: "Run the e2e suite",
  promptPreview: "Run the e2e suite",
  instanceId: ProviderInstanceId.make("claudeAgent"),
  projectId: null,
  cwd: "/repo",
  branch: "feature",
  createdBy: "agent",
  sourceThreadId: ThreadId.make("thread:chat"),
  reason: null,
  createdAt: CREATED_ISO,
  lastMessageAt: null,
  lastReplyPreview: null,
  teleportedThreadId: null,
  teleportedWorktreePath: null,
  ...patch,
});

const remote = (patch: Partial<ClaudeCloudRemoteSession> = {}): ClaudeCloudRemoteSession => ({
  id: "cse_abc",
  url: "https://claude.ai/code/cse_abc",
  title: "Run the e2e suite",
  instanceId: ProviderInstanceId.make("claudeAgent"),
  state: "idle",
  unread: false,
  origin: "cli",
  repository: null,
  branch: "claude/e2e-fixes",
  model: null,
  createdAt: CREATED_ISO,
  updatedAt: iso(CREATED + 20 * MINUTE),
  summary: "All 412 tests pass after fixing two flaky waits.",
  needsAction: null,
  contextUsage: null,
  tracked: null,
  ...patch,
});

const report = (
  session: TrackedClaudeCloudSession,
  state: Partial<ClaudeCloudRemoteSession>,
  options: { seenRunning?: boolean; now?: number } = {},
) =>
  claudeCloudReport({
    session,
    remote: remote(state),
    seenRunning: options.seenRunning ?? true,
    now: options.now ?? CREATED + 30 * MINUTE,
  });

describe("watchedSessions", () => {
  it("watches chat-started runs until their end is reported, for three days", () => {
    const now = CREATED + 60 * MINUTE;
    const sessions = [
      tracked({ id: "cse_watch" }),
      tracked({ id: "cse_waiting", reportedState: "needs_input" }),
      tracked({ id: "cse_done", reportedState: "idle" }),
      tracked({ id: "cse_orphan", sourceThreadId: null }),
      tracked({ id: "cse_back", teleportedThreadId: ThreadId.make("thread:local") }),
      tracked({ id: "cse_old", createdAt: iso(CREATED - 4 * 24 * 60 * MINUTE) }),
    ];
    expect(watchedSessions(sessions, now).map((session) => session.id)).toEqual([
      "cse_watch",
      "cse_waiting",
    ]);
  });
});

describe("claudeCloudReport", () => {
  it("tells the chat a finished run's summary, branch and how to merge it", () => {
    const decision = report(tracked(), { state: "idle" });
    expect(decision.kind).toBe("send");
    if (decision.kind !== "send") return;
    expect(decision.state).toBe("idle");
    expect(decision.text).toContain('"Run the e2e suite" finished.');
    expect(decision.text).toContain("All 412 tests pass");
    expect(decision.text).toContain("git fetch origin claude/e2e-fixes");
    expect(decision.text).toContain("https://claude.ai/code/cse_abc");
  });

  it("reports needs input and failures once each, and re-arms when the run resumes", () => {
    const waiting = report(tracked(), { state: "needs_input", needsAction: "Pick a database" });
    expect(waiting.kind === "send" && waiting.text).toContain("Pick a database");
    expect(waiting.kind === "send" && waiting.text).toContain("claude_cloud_send");
    expect(report(tracked({ reportedState: "needs_input" }), { state: "needs_input" })).toEqual({
      kind: "none",
    });
    expect(report(tracked({ reportedState: "needs_input" }), { state: "running" })).toEqual({
      kind: "record",
      state: null,
    });
    expect(report(tracked(), { state: "running" })).toEqual({ kind: "none" });
    const failed = report(tracked(), { state: "failed", summary: "Docker ran out of disk" });
    expect(failed.kind === "send" && failed.text).toContain("Docker ran out of disk");
  });

  it("doesn't call a just-launched run finished before it was seen running", () => {
    const early = { seenRunning: false, now: CREATED + MINUTE };
    expect(report(tracked(), { state: "idle" }, early)).toEqual({ kind: "none" });
    expect(report(tracked(), { state: "idle" }, { seenRunning: false }).kind).toBe("send");
  });

  it("stops watching an archived run without messaging the chat", () => {
    expect(report(tracked(), { state: "archived" })).toEqual({ kind: "record", state: "archived" });
  });
});
