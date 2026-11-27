import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMatterCloudRuns,
  groupMatterCloudRuns,
  matterCloudRunNudgeKey,
  matterCloudRunsForThread,
  matterCloudRunWork,
  shouldWatchMatterCloudRuns,
  type MatterCloudRunSession,
} from "./cloudRuns.ts";

const CHAT = ThreadId.make("chat");
const OTHER = ThreadId.make("other");

function session(
  id: string,
  overrides: Partial<MatterCloudRunSession> & {
    readonly source?: ThreadId | null;
    readonly teleported?: ThreadId | null;
    readonly lastMessageAt?: string | null;
  } = {},
): MatterCloudRunSession {
  const { source = CHAT, teleported = null, lastMessageAt = null, ...rest } = overrides;
  return {
    id,
    title: `Run ${id}`,
    state: "running",
    instanceId: "claudeAgent" as never,
    needsAction: null,
    createdAt: `2026-11-27T10:0${id.length % 10}:00.000Z`,
    updatedAt: "2026-11-27T11:00:00.000Z",
    tracked:
      source === null && teleported === null
        ? null
        : { sourceThreadId: source, teleportedThreadId: teleported, lastMessageAt },
    ...rest,
  } as MatterCloudRunSession;
}

describe("deriveMatterCloudRuns", () => {
  it("keeps running and waiting runs a chat started, newest first", () => {
    const runs = deriveMatterCloudRuns([
      session("cse_old", { createdAt: "2026-11-27T09:00:00.000Z" }),
      session("cse_new", { createdAt: "2026-11-27T10:00:00.000Z", state: "needs_input" }),
      session("cse_done", { state: "idle" }),
      session("cse_failed", { state: "failed" }),
      session("cse_archived", { state: "archived" }),
    ]);
    expect(runs.map((run) => [run.id, run.state])).toEqual([
      ["cse_new", "needs_input"],
      ["cse_old", "running"],
    ]);
  });

  it("leaves out sessions no chat started, ones Matter doesn't track, and teleported ones", () => {
    expect(
      deriveMatterCloudRuns([
        session("cse_web", { source: null }),
        { ...session("cse_untracked"), tracked: null },
        session("cse_home", { teleported: ThreadId.make("local") }),
      ]),
    ).toEqual([]);
    expect(deriveMatterCloudRuns(null)).toEqual([]);
  });

  it("dates a resumed run from its last message, not its launch", () => {
    const [run] = deriveMatterCloudRuns([
      session("cse_again", {
        createdAt: "2026-11-25T10:00:00.000Z",
        lastMessageAt: "2026-11-27T10:30:00.000Z",
      }),
    ]);
    expect(run?.startedAt).toBe("2026-11-27T10:30:00.000Z");
  });
});

describe("matterCloudRunsForThread", () => {
  it("lists one chat's runs with the one waiting on input first", () => {
    const runs = deriveMatterCloudRuns([
      session("cse_a", { createdAt: "2026-11-27T10:00:00.000Z" }),
      session("cse_b", { createdAt: "2026-11-27T09:00:00.000Z", state: "needs_input" }),
      session("cse_c", { source: OTHER }),
    ]);
    expect(matterCloudRunsForThread(runs, CHAT).map((run) => run.id)).toEqual(["cse_b", "cse_a"]);
    expect(matterCloudRunsForThread(runs, OTHER).map((run) => run.id)).toEqual(["cse_c"]);
  });
});

describe("groupMatterCloudRuns", () => {
  it("files runs under the row their chat nests under and drops unlisted chats", () => {
    const runs = deriveMatterCloudRuns([
      session("cse_a"),
      session("cse_b", { source: OTHER }),
      session("cse_c", { source: ThreadId.make("gone") }),
    ]);
    const rows = groupMatterCloudRuns(runs, (threadId) =>
      threadId === CHAT ? "env:chat" : threadId === OTHER ? "env:chat" : null,
    );
    expect([...rows.keys()]).toEqual(["env:chat"]);
    expect(
      rows
        .get("env:chat")
        ?.map((run) => run.id)
        .toSorted(),
    ).toEqual(["cse_a", "cse_b"]);
  });
});

describe("matterCloudRunWork", () => {
  it("counts only running runs as work under their chat", () => {
    const runs = deriveMatterCloudRuns([
      session("cse_a", { createdAt: "2026-11-27T10:00:00.000Z" }),
      session("cse_b", { state: "needs_input" }),
    ]);
    expect(matterCloudRunWork(runs, (threadId) => `env:${threadId}`)).toEqual([
      { parentKey: "env:chat", since: "2026-11-27T10:00:00.000Z" },
    ]);
  });
});

describe("shouldWatchMatterCloudRuns", () => {
  it("keeps reading only while a chat's run was last seen running or waiting", () => {
    expect(shouldWatchMatterCloudRuns(null)).toBe(false);
    expect(shouldWatchMatterCloudRuns([session("cse_done", { state: "idle" })])).toBe(false);
    expect(shouldWatchMatterCloudRuns([session("cse_web", { source: null })])).toBe(false);
    expect(shouldWatchMatterCloudRuns([session("cse_live")])).toBe(true);
    expect(shouldWatchMatterCloudRuns([session("cse_ask", { state: "needs_input" })])).toBe(true);
  });
});

describe("matterCloudRunNudgeKey", () => {
  it("changes when a chat's run starts or ends", () => {
    const started = matterCloudRunNudgeKey({ runId: "run-1", status: "running" });
    const ended = matterCloudRunNudgeKey({ runId: "run-1", status: "completed" });
    expect(started).not.toBe(ended);
    expect(matterCloudRunNudgeKey(null)).toBe("");
  });
});
