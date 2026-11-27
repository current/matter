import { MessageId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  CLOUD_ACTIVE_POLL_MS,
  CLOUD_IDLE_POLL_MS,
  cloudTranscriptPollDelay,
  mergeCloudTranscriptRows,
  pendingCloudEchoes,
  userItemIds,
  type CloudEcho,
} from "./claudeCloudTranscript.logic";

const threadId = ThreadId.make("claude-cloud:cse_01LOGIC1234");
const time = DateTime.makeUnsafe("2026-11-27T09:00:00.000Z");

const item = (id: string, type: "user" | "assistant", text: string): OrchestrationV2TurnItem => {
  const base = {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
  };
  return type === "user"
    ? {
        ...base,
        type: "user_message",
        messageId: MessageId.make(`m-${id}`),
        text,
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      }
    : {
        ...base,
        type: "assistant_message",
        messageId: MessageId.make(`m-${id}`),
        text,
        streaming: false,
      };
};

describe("mergeCloudTranscriptRows", () => {
  const first = [item("a", "user", "Hi"), item("b", "assistant", "Hel")];

  it("replaces everything on a first or full response", () => {
    const rows = mergeCloudTranscriptRows(null, { full: false, turnItems: first });
    expect(rows.map((row) => [row.position, row.item.id])).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
    const replaced = mergeCloudTranscriptRows(rows, {
      full: true,
      turnItems: [item("c", "user", "Fresh")],
    });
    expect(replaced.map((row) => row.item.id)).toEqual(["c"]);
  });

  it("upserts a delta by id, keeping unchanged rows and appending new ones", () => {
    const rows = mergeCloudTranscriptRows(null, { full: true, turnItems: first });
    const grown = item("b", "assistant", "Hello there");
    const next = mergeCloudTranscriptRows(rows, {
      full: false,
      turnItems: [grown, item("c", "user", "Thanks")],
    });
    expect(next.map((row) => row.item.id)).toEqual(["a", "b", "c"]);
    expect(next[0]).toBe(rows[0]);
    expect(next[1]?.item).toBe(grown);
    expect(next[1]?.position).toBe(1);
    expect(next[2]?.position).toBe(2);
  });

  it("returns the same rows for an empty delta", () => {
    const rows = mergeCloudTranscriptRows(null, { full: true, turnItems: first });
    expect(mergeCloudTranscriptRows(rows, { full: false, turnItems: [] })).toBe(rows);
  });
});

describe("pendingCloudEchoes", () => {
  const rows = mergeCloudTranscriptRows(null, {
    full: true,
    turnItems: [item("a", "user", "Ship it")],
  });
  const echo = (id: string, text: string, known = userItemIds(rows)): CloudEcho => ({
    id,
    text,
    createdAt: "2026-11-27T09:00:01.000Z",
    knownUserItemIds: known,
  });

  it("keeps an echo whose text only matches a message that was already there", () => {
    const echoes = [echo("1", "Ship it")];
    expect(pendingCloudEchoes(echoes, rows)).toEqual(echoes);
  });

  it("settles each echo with at most one new matching message", () => {
    const echoes = [echo("1", "Ship it"), echo("2", " Ship  it ")];
    const next = mergeCloudTranscriptRows(rows, {
      full: false,
      turnItems: [item("b", "user", "Ship it")],
    });
    expect(pendingCloudEchoes(echoes, next).map((entry) => entry.id)).toEqual(["2"]);
  });
});

describe("cloudTranscriptPollDelay", () => {
  it("polls fast while running, waiting on the user, or just after a send", () => {
    expect(cloudTranscriptPollDelay({ state: "running" }, false)).toBe(CLOUD_ACTIVE_POLL_MS);
    expect(cloudTranscriptPollDelay({ state: "needs_input" }, false)).toBe(CLOUD_ACTIVE_POLL_MS);
    expect(cloudTranscriptPollDelay({ state: "idle" }, true)).toBe(CLOUD_ACTIVE_POLL_MS);
    expect(cloudTranscriptPollDelay({ state: "idle" }, false)).toBe(CLOUD_IDLE_POLL_MS);
    expect(cloudTranscriptPollDelay(null, false)).toBe(CLOUD_IDLE_POLL_MS);
  });
});
