import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MattrComposerPredictions from "./MattrComposerPredictions.ts";
import * as MattrPredictionRunner from "./MattrPredictionRunner.ts";

const threadId = ThreadId.make("thread:predict");
const instanceId = ProviderInstanceId.make("claudeAgent");
const at = DateTime.makeUnsafe(Date.parse("2026-11-26T12:00:00.000Z"));

const run = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(`run:${ordinal}`),
    threadId,
    ordinal,
    status,
    providerInstanceId: instanceId,
  }) as OrchestrationV2Run;
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
  }) as unknown as OrchestrationV2ThreadProjection["messages"][number];
const runEvent = (payload: OrchestrationV2Run) =>
  ({ type: "run.updated", threadId, payload }) as OrchestrationV2DomainEvent;

interface Harness {
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "messages"
  >;
  enabled: boolean;
  calls: number;
  interrupted: number;
  answer: Effect.Effect<unknown>;
}

const makeHarness = (): Harness => ({
  projection: {
    thread: {
      id: threadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [run(1, "completed")],
    runtimeRequests: [],
    messages: [message("user", "add dark mode"), message("assistant", "Done. Default to system?")],
  },
  enabled: true,
  calls: 0,
  interrupted: 0,
  answer: Effect.succeed({ suggestion: "yes, follow the system theme" }),
});

const layerFor = (harness: Harness) =>
  MattrComposerPredictions.layerCoordinator.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadSnapshotWindow: () =>
            Effect.sync(() => ({
              schemaVersion: 1,
              snapshotSequence: 0,
              projection: harness.projection as OrchestrationV2ThreadProjection,
            })),
          getThread: () => Effect.sync(() => harness.projection.thread as never),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            promptSuggestionsEnabled: harness.enabled,
          })),
        }),
        Layer.succeed(MattrPredictionRunner.MattrPredictionRunner, {
          routes: () =>
            Effect.succeed([{ kind: "claude", instanceId, model: "claude-sonnet-5-5" }] as const),
          run: () =>
            Effect.suspend(() => {
              harness.calls += 1;
              return harness.answer;
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  harness.interrupted += 1;
                }),
              ),
            ),
        }),
      ),
    ),
  );

const settle = Effect.gen(function* () {
  for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
});

const current = Effect.gen(function* () {
  const predictions = yield* MattrComposerPredictions.MattrComposerPredictions;
  const head = yield* Stream.runHead(predictions.subscribe(threadId));
  return Option.getOrNull(head);
});

const completeRun = (
  harness: Harness,
  ordinal: number,
  status: OrchestrationV2Run["status"] = "completed",
) =>
  Effect.gen(function* () {
    const predictions = yield* MattrComposerPredictions.MattrComposerPredictions;
    harness.projection = {
      ...harness.projection,
      runs: [...harness.projection.runs.filter((r) => r.ordinal !== ordinal), run(ordinal, status)],
    };
    yield* predictions.observe(runEvent(run(ordinal, status)));
    yield* settle;
  });

const requestEvent = (status: OrchestrationV2RuntimeRequest["status"]) =>
  ({
    type: "runtime-request.updated",
    threadId,
    payload: { status },
  }) as OrchestrationV2DomainEvent;

describe("MattrComposerPredictions", () => {
  it.effect("publishes a prediction one second after a run completes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* completeRun(harness, 1);
      yield* TestClock.adjust("999 millis");
      assert.strictEqual(harness.calls, 0);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      assert.strictEqual(harness.calls, 1);
      assert.deepStrictEqual(yield* current, {
        runId: RunId.make("run:1"),
        text: "yes, follow the system theme",
      });
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("cancels a waiting prediction when a new run starts, and clears the old one", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const predictions = yield* MattrComposerPredictions.MattrComposerPredictions;
      yield* completeRun(harness, 1);
      yield* predictions.observe(runEvent(run(2, "running")));
      yield* settle;
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      assert.strictEqual(harness.calls, 0);
      assert.isNull(yield* current);
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("serves a repeated completion of the same run from the cache", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const predictions = yield* MattrComposerPredictions.MattrComposerPredictions;
      yield* completeRun(harness, 1);
      yield* TestClock.adjust("1 second");
      yield* settle;
      yield* predictions.observe({
        type: "thread.archived",
        threadId,
      } as OrchestrationV2DomainEvent);
      assert.isNull(yield* current);
      yield* completeRun(harness, 1);
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.strictEqual(harness.calls, 1);
      assert.strictEqual((yield* current)?.text, "yes, follow the system theme");
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect(
    "predicts while subagents run, clears when one wakes the parent, then predicts again",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const predictions = yield* MattrComposerPredictions.MattrComposerPredictions;
        // The parent's turn is over; its background work holds the run as waiting.
        yield* completeRun(harness, 1, "waiting");
        yield* TestClock.adjust("1 second");
        yield* settle;
        assert.strictEqual((yield* current)?.runId, RunId.make("run:1"));

        // A delegated cohort write on the finished run neither restarts nor clears it.
        yield* predictions.observe(runEvent(run(1, "completed")));
        yield* TestClock.adjust("1 second");
        yield* settle;
        assert.strictEqual(harness.calls, 1);
        assert.strictEqual((yield* current)?.runId, RunId.make("run:1"));

        // A finished subagent wakes the parent: the old prediction goes at once.
        harness.projection = {
          ...harness.projection,
          runs: [...harness.projection.runs, run(2, "queued")],
        };
        yield* predictions.observe({
          type: "run.created",
          threadId,
          payload: run(2, "queued"),
        } as OrchestrationV2DomainEvent);
        yield* settle;
        assert.isNull(yield* current);

        // An older run's late update while the wake runs schedules nothing.
        yield* predictions.observe(runEvent(run(1, "completed")));
        yield* TestClock.adjust("1 second");
        yield* settle;
        assert.strictEqual(harness.calls, 1);
        assert.isNull(yield* current);

        // The wake turn ends and the parent gets a fresh prediction for it.
        yield* completeRun(harness, 2);
        yield* TestClock.adjust("1 second");
        yield* settle;
        assert.strictEqual(harness.calls, 2);
        assert.strictEqual((yield* current)?.runId, RunId.make("run:2"));
      }).pipe(Effect.provide(layerFor(harness)));
    },
  );

  it.effect(
    "hides the prediction during a pending request and brings it back once it settles",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const predictions = yield* MattrComposerPredictions.MattrComposerPredictions;
        yield* completeRun(harness, 1);
        yield* TestClock.adjust("1 second");
        yield* settle;
        assert.isNotNull(yield* current);

        // A background subagent asks for approval on the idle parent.
        harness.projection = {
          ...harness.projection,
          runtimeRequests: [{ status: "pending" } as OrchestrationV2RuntimeRequest],
        };
        yield* predictions.observe(requestEvent("pending"));
        yield* settle;
        assert.isNull(yield* current);

        harness.projection = { ...harness.projection, runtimeRequests: [] };
        yield* predictions.observe(requestEvent("resolved"));
        yield* TestClock.adjust("1 second");
        yield* settle;
        assert.strictEqual(harness.calls, 1, "served from the cache");
        assert.strictEqual((yield* current)?.runId, RunId.make("run:1"));
      }).pipe(Effect.provide(layerFor(harness)));
    },
  );

  it.effect("keeps a scheduled prediction when a finished turn's request settles", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const predictions = yield* MattrComposerPredictions.MattrComposerPredictions;
      yield* completeRun(harness, 1);
      yield* predictions.observe(requestEvent("cancelled"));
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.strictEqual(harness.calls, 1);
      assert.isNotNull(yield* current);
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("makes no call when predictions are off, or the thread is delegated or blocked", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      harness.enabled = false;
      yield* completeRun(harness, 1);
      yield* TestClock.adjust("1 second");
      yield* settle;

      harness.enabled = true;
      harness.projection = {
        ...harness.projection,
        runtimeRequests: [{ status: "pending" } as OrchestrationV2RuntimeRequest],
      };
      yield* completeRun(harness, 2);
      yield* TestClock.adjust("1 second");
      yield* settle;

      harness.projection = {
        ...harness.projection,
        runtimeRequests: [],
        thread: {
          ...harness.projection.thread,
          lineage: {
            parentThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("thread:parent"),
          },
        } as OrchestrationV2ThreadProjection["thread"],
      };
      yield* completeRun(harness, 3);
      yield* TestClock.adjust("1 second");
      yield* settle;

      assert.strictEqual(harness.calls, 0);
      assert.isNull(yield* current);
    }).pipe(Effect.provide(layerFor(harness)));
  });

  it.effect("interrupts a call that outlives the 20 second limit", () => {
    const harness = makeHarness();
    harness.answer = Effect.never;
    return Effect.gen(function* () {
      yield* completeRun(harness, 1);
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.strictEqual(harness.calls, 1);
      yield* TestClock.adjust("20 seconds");
      yield* settle;
      assert.strictEqual(harness.interrupted, 1);
      assert.isNull(yield* current);
    }).pipe(Effect.provide(layerFor(harness)));
  });
});
