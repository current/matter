import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2PromptSuggestion,
  OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MattrPredictionRunner from "./MattrPredictionRunner.ts";
import {
  ACTIVE_RUN_STATUSES,
  predictionCacheKey,
  PredictionLatency,
  PredictionLru,
  predictionReadiness,
  type PredictionRoute,
  TURN_ENDED_RUN_STATUSES,
} from "./predictionPolicy.ts";
import { sanitizePrediction } from "./predictionText.ts";

const START_DELAY = Duration.seconds(1);
const HARD_TIMEOUT = Duration.seconds(20);
const CACHE_ENTRIES = 64;
const MAX_STORED_SUGGESTIONS = 256;
const SNAPSHOT_ROW_LIMIT = 240;
const SNAPSHOT_USER_TURN_LIMIT = 4;

type StoredSuggestion = NonNullable<OrchestrationV2PromptSuggestion>;

interface PendingPrediction {
  readonly runId: RunId;
  readonly ordinal: number;
  fiber?: Fiber.Fiber<void>;
}

/**
 * mattr's next-message predictor. After a top-level run's turn ends (even while its background
 * subagents keep working) it asks a small stateless model call for the user's likely next message
 * and serves it through upstream's prompt suggestion subscription, so every client shows it.
 */
export class MattrComposerPredictions extends Context.Service<
  MattrComposerPredictions,
  {
    readonly observe: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<OrchestrationV2PromptSuggestion>;
  }
>()("t3/mattr/composerPredictions/MattrComposerPredictions") {}

const make = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const runner = yield* MattrPredictionRunner.MattrPredictionRunner;
  const scope = yield* Effect.scope;
  const store = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, StoredSuggestion>>(new Map());
  const cache = new PredictionLru<string | null>(CACHE_ENTRIES);
  const latency = new PredictionLatency();
  const pending = new Map<ThreadId, PendingPrediction>();
  // Each thread's latest ended turn, so a request settling on an idle thread can predict again.
  const endedRuns = new Map<ThreadId, OrchestrationV2Run>();
  // False for an older run's late update, such as a delegated cohort write: it has nothing to predict.
  const rememberEnded = (run: OrchestrationV2Run): boolean => {
    const known = endedRuns.get(run.threadId);
    if (known !== undefined && known.ordinal > run.ordinal) return false;
    endedRuns.delete(run.threadId);
    endedRuns.set(run.threadId, run);
    for (const key of endedRuns.keys()) {
      if (endedRuns.size <= MAX_STORED_SUGGESTIONS) break;
      endedRuns.delete(key);
    }
    return true;
  };

  const enabled = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.promptSuggestionsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const publish = (threadId: ThreadId, suggestion: StoredSuggestion | null) =>
    SubscriptionRef.update(store, (current) => {
      if (suggestion === null && !current.has(threadId)) return current;
      const next = new Map(current);
      next.delete(threadId);
      if (suggestion !== null) next.set(threadId, suggestion);
      for (const key of next.keys()) {
        if (next.size <= MAX_STORED_SUGGESTIONS) break;
        next.delete(key);
      }
      return next;
    });

  const timedAttempt = (route: PredictionRoute, threadId: ThreadId, transcript: string) =>
    runner.run({ route, threadId, transcript }).pipe(
      Effect.timed,
      Effect.tap(([elapsed]) => Effect.sync(() => latency.record(Duration.toMillis(elapsed)))),
      Effect.map(([, raw]) => raw),
    );

  // A call slower than twice the recent median gets one duplicate; the loser is interrupted.
  const hedged = (route: PredictionRoute, threadId: ThreadId, transcript: string) => {
    const hedgeAfterMs = latency.hedgeAfterMs();
    const attempt = timedAttempt(route, threadId, transcript);
    return hedgeAfterMs === undefined
      ? attempt
      : // The delayed arm is a second attempt, not a timeout; raceFirst lets a fast failure move on.
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- hedged duplicate call, not a timeout.
        Effect.raceFirst(attempt, Effect.delay(attempt, Duration.millis(hedgeAfterMs)));
  };

  const generate = Effect.fn("MattrComposerPredictions.generate")(function* (
    routes: ReadonlyArray<PredictionRoute>,
    threadId: ThreadId,
    transcript: string,
  ) {
    for (const route of routes) {
      const raw = yield* hedged(route, threadId, transcript).pipe(Effect.option);
      if (Option.isSome(raw)) return sanitizePrediction(raw.value);
    }
    return null;
  });

  const predict = Effect.fn("MattrComposerPredictions.predict")(function* (
    threadId: ThreadId,
    runId: RunId,
    threadInstanceId: ProviderInstanceId | null,
  ) {
    yield* Effect.sleep(START_DELAY);
    if (!(yield* enabled)) return;
    const snapshot = yield* projectionStore
      .getThreadSnapshotWindow(threadId, {
        rowLimit: SNAPSHOT_ROW_LIMIT,
        userTurnLimit: SNAPSHOT_USER_TURN_LIMIT,
        deferWork: true,
      })
      .pipe(Effect.option);
    if (Option.isNone(snapshot)) return;
    const readiness = predictionReadiness(snapshot.value.projection, runId);
    if (!readiness.ready) {
      return yield* Effect.annotateCurrentSpan("mattr.prediction.outcome", readiness.reason);
    }
    const routes = yield* runner.routes({ threadInstanceId });
    const primary = routes[0];
    if (primary === undefined) {
      return yield* Effect.annotateCurrentSpan("mattr.prediction.outcome", "no-route");
    }
    const key = predictionCacheKey(threadId, runId, primary.model);
    const text = cache.has(key)
      ? (cache.get(key) ?? null)
      : yield* generate(routes, threadId, readiness.transcript).pipe(
          Effect.timeoutOption(HARD_TIMEOUT),
          Effect.map(Option.getOrNull),
          Effect.tap((result) => Effect.sync(() => cache.set(key, result))),
        );
    // Records why nothing showed: the predictor often answers null on purpose.
    yield* Effect.annotateCurrentSpan(
      "mattr.prediction.outcome",
      text === null ? "empty" : "offered",
    );
    if (text !== null) yield* publish(threadId, { runId, text });
  });

  const cancel = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const entry = pending.get(threadId);
      pending.delete(threadId);
      return entry?.fiber === undefined
        ? Effect.void
        : // Interrupt without waiting, so the event stream never blocks on a CLI exiting.
          Effect.forkIn(Fiber.interrupt(entry.fiber), scope).pipe(Effect.asVoid);
    });

  const schedule = (run: OrchestrationV2Run) =>
    Effect.suspend(() => {
      const { threadId, id: runId } = run;
      const current = pending.get(threadId);
      // Later updates to a finished run, or to an older one, must not restart the newest job.
      if (current !== undefined && current.ordinal >= run.ordinal) return Effect.void;
      const entry: PendingPrediction = { runId, ordinal: run.ordinal };
      return cancel(threadId).pipe(
        Effect.andThen(Effect.sync(() => pending.set(threadId, entry))),
        Effect.andThen(
          predict(threadId, runId, run.providerInstanceId).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logDebug("mattr composer prediction failed", cause),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (pending.get(threadId) === entry) pending.delete(threadId);
              }),
            ),
            Effect.forkIn(scope),
          ),
        ),
        Effect.tap((fiber) =>
          Effect.sync(() => {
            entry.fiber = fiber;
          }),
        ),
        Effect.asVoid,
      );
    });

  const observe = Effect.fn("MattrComposerPredictions.observe")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    switch (event.type) {
      case "run.created":
      case "run.updated": {
        const run = event.payload;
        if (TURN_ENDED_RUN_STATUSES.has(run.status)) {
          return rememberEnded(run) ? yield* schedule(run) : undefined;
        }
        // New work on the thread, such as a subagent's result waking it: the prediction no longer
        // answers its latest turn. The wake run's own end schedules a fresh one.
        if (ACTIVE_RUN_STATUSES.has(run.status)) {
          endedRuns.delete(run.threadId);
          yield* cancel(run.threadId);
          return yield* publish(run.threadId, null);
        }
        if ((pending.get(run.threadId)?.ordinal ?? Number.POSITIVE_INFINITY) <= run.ordinal) {
          yield* cancel(run.threadId);
        }
        return;
      }
      // A question or approval hides the prediction. Once it settles on a thread whose turn is
      // over (a background subagent's approval, say), predict again; the cache makes a repeat free.
      case "runtime-request.updated": {
        if (event.payload.status === "pending") {
          yield* cancel(event.threadId);
          return yield* publish(event.threadId, null);
        }
        const ended = endedRuns.get(event.threadId);
        return ended === undefined || pending.has(event.threadId)
          ? undefined
          : yield* schedule(ended);
      }
      case "thread.archived":
      case "thread.deleted":
        endedRuns.delete(event.threadId);
        yield* cancel(event.threadId);
        return yield* publish(event.threadId, null);
      default:
        return;
    }
  });

  // Stored suggestions can outlive a deleted thread, so check the thread before serving one.
  const subscribe = (threadId: ThreadId) =>
    SubscriptionRef.changes(store).pipe(
      Stream.map((suggestions) => suggestions.get(threadId) ?? null),
      Stream.changes,
      Stream.mapEffect((suggestion) =>
        suggestion === null
          ? Effect.succeed(null)
          : projectionStore.getThread(threadId).pipe(
              Effect.map((thread) => (thread.deletedAt === null ? suggestion : null)),
              Effect.orElseSucceed(() => null),
            ),
      ),
      Stream.changes,
    );

  return MattrComposerPredictions.of({ observe, subscribe });
});

export const layerCoordinator = Layer.effect(MattrComposerPredictions, make);

const layerEventFeed = Layer.effectDiscard(
  Effect.gen(function* () {
    const predictions = yield* MattrComposerPredictions;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, predictions.observe).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("mattr composer predictions stopped following runs", cause),
        ),
      ),
    );
  }),
);

export const layer = layerEventFeed.pipe(
  Layer.provideMerge(layerCoordinator),
  Layer.provide(MattrPredictionRunner.layer),
);
