import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const remote = vi.hoisted(() => ({ sessions: [] as unknown[], calls: 0 }));

vi.mock(import("../../addons/claudeCloudApi"), async (original) => ({
  ...(await original()),
  fetchClaudeCloudRemoteSessions: (async () => {
    remote.calls += 1;
    return { sessions: remote.sessions, problems: [] };
  }) as never,
}));

import {
  nudgeClaudeCloudRuns,
  resetClaudeCloudStoreForTests,
  retainClaudeCloudRunWatch,
  retainClaudeCloudSessions,
} from "./claudeCloudStore";

const config = { baseUrl: "http://server.test", bearer: null } as never;

const session = (state: string, sourceThreadId: string | null = "chat") => ({
  id: "cse_run",
  title: "Run",
  state,
  instanceId: "claudeAgent",
  needsAction: null,
  createdAt: "2026-11-27T10:00:00.000Z",
  updatedAt: "2026-11-27T10:00:00.000Z",
  tracked: { sourceThreadId, teleportedThreadId: null, lastMessageAt: null },
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("claudeCloudStore run watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    remote.calls = 0;
    remote.sessions = [];
  });
  afterEach(() => {
    resetClaudeCloudStoreForTests();
    vi.useRealTimers();
  });

  it("reads once, then stays quiet while no chat's cloud run is live", async () => {
    remote.sessions = [session("idle"), session("running", null)];
    const release = retainClaudeCloudRunWatch(config);
    await flush();
    expect(remote.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(remote.calls).toBe(1);
    release();
  });

  it("keeps reading while a chat's cloud run runs, and stops once it finishes", async () => {
    remote.sessions = [session("running")];
    const release = retainClaudeCloudRunWatch(config);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(remote.calls).toBe(2);
    remote.sessions = [session("idle")];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(remote.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(remote.calls).toBe(3);
    release();
  });

  it("reads again when a chat's run starts or ends, but not when a chat is first seen", async () => {
    const release = retainClaudeCloudRunWatch(config);
    await flush();
    nudgeClaudeCloudRuns("env:chat", "run-1:running");
    await flush();
    expect(remote.calls).toBe(1);
    nudgeClaudeCloudRuns("env:chat", "run-1:completed");
    await flush();
    expect(remote.calls).toBe(2);
    release();
    nudgeClaudeCloudRuns("env:chat", "run-2:running");
    await flush();
    expect(remote.calls).toBe(2);
  });

  it("hands back to the list's own cadence while a full holder (Crew, palette) holds it", async () => {
    const watch = retainClaudeCloudRunWatch(config);
    const list = retainClaudeCloudSessions(config);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(remote.calls).toBe(2);
    list();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(remote.calls).toBe(2);
    watch();
  });
});
