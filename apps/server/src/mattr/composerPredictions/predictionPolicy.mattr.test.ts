import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  PredictionLatency,
  PredictionLru,
  predictionReadiness,
  predictionRoutes,
} from "./predictionPolicy.ts";

const nowMs = Date.parse("2026-11-26T12:00:00.000Z");

const provider = (
  id: string,
  driver: "claudeAgent" | "codex",
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-26T11:00:00.000Z",
  models:
    driver === "codex"
      ? [
          { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
          { slug: "gpt-5.5-mini", name: "GPT-5.5 mini", isCustom: false, capabilities: null },
        ]
      : [{ slug: "claude-sonnet-5-5", name: "Sonnet 5.5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const routeIds = (input: Parameters<typeof predictionRoutes>[0]) =>
  predictionRoutes(input).map((route) => `${route.kind}:${route.instanceId}:${route.model}`);

describe("predictionRoutes", () => {
  const providers = [
    provider("claude-alt", "claudeAgent"),
    provider("claudeAgent", "claudeAgent"),
    provider("claude-alt-2", "claudeAgent"),
    provider("codex", "codex"),
  ];

  it("never routes to claude-alt, even when nothing is excluded or the thread runs on it", () => {
    for (const threadInstanceId of [null, ProviderInstanceId.make("claude-alt")]) {
      assert.deepStrictEqual(
        routeIds({ providers, threadInstanceId, excludedInstanceIds: [], nowMs }),
        [
          "claude:claudeAgent:claude-sonnet-5-5",
          "claude:claude-alt-2:claude-sonnet-5-5",
          "codex:codex:gpt-5.5-mini",
        ],
      );
    }
  });

  it("puts the thread's own Claude account first and skips excluded ones", () => {
    assert.deepStrictEqual(
      routeIds({
        providers,
        threadInstanceId: ProviderInstanceId.make("claude-alt-2"),
        excludedInstanceIds: [ProviderInstanceId.make("claudeAgent")],
        nowMs,
      }),
      ["claude:claude-alt-2:claude-sonnet-5-5", "codex:codex:gpt-5.5-mini"],
    );
  });

  it("falls back to a small Codex model, or nothing, when no Claude account can run", () => {
    const unusable = [
      provider("claudeAgent", "claudeAgent", { auth: { status: "unauthenticated" } }),
      provider("claude-alt-2", "claudeAgent", {
        usageLimits: {
          checkedAt: "2026-11-26T11:00:00.000Z",
          windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 100 }],
        },
      }),
      provider("claude-off", "claudeAgent", { enabled: false }),
      provider("claude-secret", "claudeAgent"),
    ];
    const input = {
      threadInstanceId: null,
      excludedInstanceIds: [],
      unreadableInstanceIds: new Set([ProviderInstanceId.make("claude-secret")]),
      nowMs,
    };
    assert.deepStrictEqual(
      routeIds({ ...input, providers: [...unusable, provider("codex", "codex")] }),
      ["codex:codex:gpt-5.5-mini"],
    );
    assert.deepStrictEqual(
      routeIds({
        ...input,
        providers: [
          ...unusable,
          provider("codex", "codex", {
            models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
          }),
        ],
      }),
      [],
    );
  });
});

const threadId = ThreadId.make("thread:predict");
const at = DateTime.makeUnsafe(nowMs);
const thread = (overrides: Partial<OrchestrationV2AppThread> = {}) =>
  ({
    id: threadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2AppThread;
const run = (id: string, ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({ id: RunId.make(id), threadId, ordinal, status }) as OrchestrationV2Run;
const message = (role: "user" | "assistant", text: string) =>
  ({
    id: MessageId.make(`message:${role}:${text}`),
    threadId,
    role,
    text,
    streaming: false,
    attachments: [],
    createdAt: at,
    updatedAt: at,
  }) as unknown as OrchestrationV2ConversationMessage;

describe("predictionReadiness", () => {
  const latest = RunId.make("run:2");
  const base = {
    thread: thread(),
    runs: [run("run:1", 1, "completed"), run("run:2", 2, "completed")],
    runtimeRequests: [],
    messages: [message("user", "add dark mode"), message("assistant", "Done. Default to system?")],
  };

  it("is ready for the latest completed run of a quiet top-level thread", () => {
    assert.deepStrictEqual(predictionReadiness(base, latest), {
      ready: true,
      transcript: "User: add dark mode\nAssistant: Done. Default to system?",
    });
  });

  it("is ready while the turn is over but background subagents still run", () => {
    const waiting = { ...base, runs: [run("run:1", 1, "completed"), run("run:2", 2, "waiting")] };
    assert.isTrue(predictionReadiness(waiting, latest).ready);
    // A pending question or approval still blocks it, and so does the parent waking up.
    assert.deepStrictEqual(
      predictionReadiness(
        { ...waiting, runtimeRequests: [{ status: "pending" } as OrchestrationV2RuntimeRequest] },
        latest,
      ),
      { ready: false, reason: "pending-request" },
    );
    assert.deepStrictEqual(
      predictionReadiness(
        { ...waiting, runs: [...waiting.runs, run("run:3", 3, "running")] },
        latest,
      ),
      { ready: false, reason: "busy" },
    );
  });

  it("waits out delegated, closed, busy, superseded, and blocked threads", () => {
    const reason = (projection: Parameters<typeof predictionReadiness>[0], runId = latest) => {
      const readiness = predictionReadiness(projection, runId);
      return readiness.ready ? "ready" : readiness.reason;
    };
    assert.strictEqual(
      reason({
        ...base,
        thread: thread({
          lineage: {
            parentThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("thread:parent"),
          },
        }),
      }),
      "delegated",
    );
    assert.strictEqual(reason({ ...base, thread: thread({ archivedAt: at }) }), "closed");
    assert.strictEqual(
      reason({ ...base, runs: [...base.runs, run("run:3", 3, "queued")] }),
      "busy",
    );
    assert.strictEqual(reason(base, RunId.make("run:1")), "not-latest");
    assert.strictEqual(
      reason({
        ...base,
        runtimeRequests: [{ status: "pending" } as OrchestrationV2RuntimeRequest],
      }),
      "pending-request",
    );
    assert.strictEqual(
      reason({ ...base, messages: [message("user", "still waiting")] }),
      "no-transcript",
    );
  });
});

describe("PredictionLru", () => {
  it("evicts the least recently used entry past capacity", () => {
    const lru = new PredictionLru<string | null>(2);
    lru.set("a", "A");
    lru.set("b", null);
    assert.strictEqual(lru.get("a"), "A");
    lru.set("c", "C");
    assert.isTrue(lru.has("a"));
    assert.isTrue(lru.has("c"));
    assert.isFalse(lru.has("b"));
    assert.strictEqual(lru.size, 2);
  });
});

describe("PredictionLatency", () => {
  it("hedges after twice the median once it has enough samples, within bounds", () => {
    const latency = new PredictionLatency();
    latency.record(2_000);
    latency.record(3_000);
    assert.isUndefined(latency.hedgeAfterMs());
    latency.record(4_000);
    assert.strictEqual(latency.hedgeAfterMs(), 6_000);
    for (let index = 0; index < 16; index += 1) latency.record(100);
    assert.strictEqual(latency.hedgeAfterMs(), 2_000);
    for (let index = 0; index < 16; index += 1) latency.record(60_000);
    assert.strictEqual(latency.hedgeAfterMs(), 10_000);
  });
});
