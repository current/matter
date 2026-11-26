import {
  MAX_BOT_MESSAGES_PAGE,
  NO_BOT_PROVIDER_CAPABILITIES,
  type AddonRuntimeStatus,
  type BotCancelRequest,
  type BotConversation,
  type BotEvent,
  type BotIdentity,
  type BotMessage,
  type BotMessagesPage,
  type BotPendingRequest,
  type BotProviderDescriptor,
  type BotRespondRequest,
  type BotSendMessageRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as AddonConfigService from "./AddonConfigService.ts";
import type {
  BotProviderAdapter,
  BotProviderContext,
  BotProviderError,
  BotProviderSession,
} from "./BotProviderAdapter.ts";

const DEFAULT_POLL_INTERVALS = { idleMs: 30_000, activeMs: 5_000 } as const;
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const EVENT_BUFFER = 512;
const RECONNECT_SETTLE_TIMEOUT = "10 seconds";

export class BotsPlatformError extends Schema.TaggedError<BotsPlatformError>()(
  "BotsPlatformError",
  {
    code: Schema.Literals([
      "invalid_request",
      "provider_not_found",
      "provider_disabled",
      "provider_unavailable",
      "unsupported",
      "usage_confirmation_required",
      "not_found",
      "provider_error",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {}

export class BotsPlatformService extends Context.Service<
  BotsPlatformService,
  {
    /** Adds a provider; it starts only if its add-on is enabled. */
    readonly register: (adapter: BotProviderAdapter) => Effect.Effect<void>;
    /** Starts enabled providers and stops disabled ones. */
    readonly reconcile: Effect.Effect<void>;
    readonly runningProviderIds: Effect.Effect<ReadonlyArray<string>>;
    /** Runtime status of an add-on's provider, or null when it has none registered. */
    readonly addonStatus: (addonId: string) => Effect.Effect<AddonRuntimeStatus | null>;
    /**
     * Restarts a running provider now and waits briefly for its first settled status. Only
     * reconnects Matter's side; it never launches or restarts the provider's app.
     */
    readonly reconnect: (addonId: string) => Effect.Effect<AddonRuntimeStatus | null>;
    readonly listProviders: Effect.Effect<ReadonlyArray<BotProviderDescriptor>>;
    readonly listBots: (
      providerId: string,
    ) => Effect.Effect<ReadonlyArray<BotIdentity>, BotsPlatformError>;
    readonly listConversations: (input: {
      readonly providerId: string;
      readonly botId: string | null;
    }) => Effect.Effect<ReadonlyArray<BotConversation>, BotsPlatformError>;
    readonly getMessages: (input: {
      readonly providerId: string;
      readonly conversationId: string;
      readonly olderCursor: string | null;
      readonly limit: number;
    }) => Effect.Effect<BotMessagesPage, BotsPlatformError>;
    readonly sendMessage: (
      input: BotSendMessageRequest,
    ) => Effect.Effect<BotMessage, BotsPlatformError>;
    readonly respondToRequest: (input: BotRespondRequest) => Effect.Effect<void, BotsPlatformError>;
    readonly cancel: (input: BotCancelRequest) => Effect.Effect<void, BotsPlatformError>;
    readonly listPendingRequests: Effect.Effect<ReadonlyArray<BotPendingRequest>>;
    /** Normalized events from every running provider. Polling runs only while someone listens. */
    readonly events: Stream.Stream<BotEvent>;
  }
>()("t3/bots/BotsPlatformService") {}

interface RunningProvider {
  readonly scope: Scope.Closeable;
  /** Completes on the first status other than `connecting`. */
  readonly settled: Deferred.Deferred<void>;
  session: BotProviderSession | null;
  /** Completing it ends the current poll wait early, e.g. right after a send. */
  wake: Deferred.Deferred<void> | null;
}

/** Provider errors that mean the session is gone, so the platform restarts it. */
const RESTART_REASONS: ReadonlySet<BotProviderError["reason"]> = new Set([
  "unavailable",
  "unconfigured",
  "disconnected",
  "auth_required",
]);

const statusFromProviderError = (error: BotProviderError): AddonRuntimeStatus => {
  const detail = error.detail === undefined ? {} : { detail: error.detail };
  switch (error.reason) {
    case "auth_required":
      return { kind: "auth_required", ...detail, action: { kind: "sign-in" } };
    case "unavailable":
      return { kind: "app_unavailable", ...detail, action: { kind: "open-app" } };
    case "unconfigured":
      return { kind: "enabled_unconfigured", ...detail, action: { kind: "configure" } };
    case "disconnected":
      return { kind: "disconnected", ...detail, action: { kind: "retry" } };
    case "incompatible_version":
      return { kind: "incompatible_version", ...detail, action: { kind: "update" } };
    default:
      return { kind: "error", ...detail, action: { kind: "retry" } };
  }
};

const platformErrorFromProvider = (error: BotProviderError) =>
  new BotsPlatformError({
    code:
      error.reason === "not_found"
        ? "not_found"
        : error.reason === "unsupported"
          ? "unsupported"
          : RESTART_REASONS.has(error.reason)
            ? "provider_unavailable"
            : "provider_error",
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });

/** Exponential backoff from the base interval, capped at five minutes. */
export const backoffMs = (baseMs: number, failures: number) =>
  Math.min(MAX_BACKOFF_MS, Math.max(MIN_POLL_INTERVAL_MS, baseMs) * 2 ** Math.min(failures, 10));

const pendingKey = (providerId: string, requestId: string) => `${providerId}\u0000${requestId}`;

const make = Effect.gen(function* () {
  const addonConfig = yield* AddonConfigService.AddonConfigService;
  const adapters = new Map<string, BotProviderAdapter>();
  const running = new Map<string, RunningProvider>();
  const statuses = new Map<string, AddonRuntimeStatus>();
  const pending = yield* Ref.make(new Map<string, BotPendingRequest>());
  const lifecycleLock = yield* Semaphore.make(1);
  const eventsPubSub = yield* PubSub.sliding<BotEvent>(EVENT_BUFFER);
  const subscribers = yield* Ref.make(0);
  const listening = yield* Latch.make(false);

  const publish = (event: BotEvent) => PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid);

  const setStatus = Effect.fn("BotsPlatformService.setStatus")(function* (
    providerId: string,
    status: AddonRuntimeStatus,
  ) {
    const previous = statuses.get(providerId);
    statuses.set(providerId, status);
    const entry = running.get(providerId);
    if (entry && status.kind !== "connecting") yield* Deferred.succeed(entry.settled, undefined);
    if (previous?.kind !== status.kind || previous.detail !== status.detail) {
      yield* publish({ type: "provider-status", providerId, status });
    }
  });

  const trackEvent = (providerId: string, event: BotEvent) =>
    Ref.update(pending, (current) => {
      if (event.type === "pending-request" && event.request.providerId === providerId) {
        const next = new Map(current);
        next.set(pendingKey(providerId, event.request.requestId), event.request);
        return next;
      }
      if (event.type === "pending-request-resolved" && event.providerId === providerId) {
        const next = new Map(current);
        next.delete(pendingKey(providerId, event.requestId));
        return next;
      }
      return current;
    });

  const dropPending = (providerId: string) =>
    Ref.update(
      pending,
      (current) => new Map([...current].filter(([, request]) => request.providerId !== providerId)),
    );

  const pollLoop = Effect.fn("BotsPlatformService.pollLoop")(function* (
    adapter: BotProviderAdapter,
    entry: RunningProvider,
    session: BotProviderSession,
  ) {
    const poll = session.poll;
    if (!poll) return yield* Effect.never;
    const intervals = adapter.pollIntervals ?? DEFAULT_POLL_INTERVALS;
    const idleMs = Math.max(MIN_POLL_INTERVAL_MS, intervals.idleMs);
    const activeMs = Math.max(MIN_POLL_INTERVAL_MS, intervals.activeMs);
    let failures = 0;
    while (true) {
      yield* listening.await;
      const exit = yield* Effect.exit(poll);
      if (Exit.isSuccess(exit)) {
        failures = 0;
        yield* setStatus(adapter.providerId, yield* session.status);
        const wake = yield* Deferred.make<void>();
        entry.wake = wake;
        yield* Deferred.await(wake).pipe(
          Effect.timeoutOption(Duration.millis(exit.value.active ? activeMs : idleMs)),
        );
        entry.wake = null;
        continue;
      }
      const error = Exit.findErrorOption(exit);
      if (error._tag === "None") return yield* Effect.failCause(exit.cause);
      failures += 1;
      yield* setStatus(adapter.providerId, statusFromProviderError(error.value));
      // Losing the connection or the sign-in restarts the provider instead of polling blind.
      if (RESTART_REASONS.has(error.value.reason)) {
        return error.value;
      }
      yield* Effect.sleep(backoffMs(idleMs, failures));
    }
  });

  const runProvider = Effect.fn("BotsPlatformService.runProvider")(function* (
    adapter: BotProviderAdapter,
    entry: RunningProvider,
  ) {
    const config = yield* addonConfig
      .getConfig(adapter.addonId)
      .pipe(Effect.orElseSucceed(() => ({})));
    const context: BotProviderContext = {
      config,
      emit: (event) => trackEvent(adapter.providerId, event).pipe(Effect.andThen(publish(event))),
    };
    let failures = 0;
    while (true) {
      yield* setStatus(adapter.providerId, { kind: "connecting" });
      const sessionScope = yield* Scope.fork(entry.scope);
      const started = yield* adapter.start(context).pipe(Scope.provide(sessionScope), Effect.exit);
      if (Exit.isSuccess(started)) {
        failures = 0;
        const session = started.value;
        entry.session = session;
        yield* setStatus(adapter.providerId, yield* session.status);
        if (session.listPendingRequests) {
          const requests = yield* session.listPendingRequests.pipe(
            Effect.orElseSucceed((): ReadonlyArray<BotPendingRequest> => []),
          );
          yield* Effect.forEach(requests, (request) =>
            trackEvent(adapter.providerId, { type: "pending-request", request }),
          );
        }
        yield* pollLoop(adapter, entry, session);
      } else {
        const error = Exit.findErrorOption(started);
        if (error._tag === "None") return yield* Effect.failCause(started.cause);
        yield* setStatus(adapter.providerId, statusFromProviderError(error.value));
      }
      entry.session = null;
      yield* Scope.close(sessionScope, Exit.void);
      failures += 1;
      yield* Effect.sleep(backoffMs(DEFAULT_POLL_INTERVALS.idleMs, failures - 1));
    }
  });

  const startProvider = Effect.fn("BotsPlatformService.startProvider")(function* (
    adapter: BotProviderAdapter,
  ) {
    const scope = yield* Scope.make();
    const entry: RunningProvider = {
      scope,
      settled: yield* Deferred.make<void>(),
      session: null,
      wake: null,
    };
    running.set(adapter.providerId, entry);
    yield* runProvider(adapter, entry).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Bots provider stopped unexpectedly.", cause).pipe(
          Effect.andThen(
            setStatus(adapter.providerId, { kind: "error", action: { kind: "retry" } }),
          ),
        ),
      ),
      Effect.forkIn(scope),
    );
    return entry;
  });

  // Closes local resources only. Remote tasks keep running and pick up again on re-enable.
  const closeProvider = Effect.fn("BotsPlatformService.closeProvider")(function* (
    providerId: string,
  ) {
    const entry = running.get(providerId);
    if (!entry) return false;
    running.delete(providerId);
    yield* Scope.close(entry.scope, Exit.void);
    statuses.delete(providerId);
    yield* dropPending(providerId);
    return true;
  });

  const stopProvider = Effect.fn("BotsPlatformService.stopProvider")(function* (
    providerId: string,
  ) {
    if (!(yield* closeProvider(providerId))) return;
    yield* publish({ type: "provider-status", providerId, status: { kind: "disabled" } });
  });

  const reconcile = lifecycleLock
    .withPermit(
      Effect.gen(function* () {
        for (const adapter of adapters.values()) {
          const enabled = yield* addonConfig.isEnabled(adapter.addonId);
          const isRunning = running.has(adapter.providerId);
          if (enabled && !isRunning) yield* startProvider(adapter);
          if (!enabled && isRunning) yield* stopProvider(adapter.providerId);
        }
      }),
    )
    .pipe(Effect.withSpan("BotsPlatformService.reconcile"));

  const register = Effect.fn("BotsPlatformService.register")(function* (
    adapter: BotProviderAdapter,
  ) {
    const existing = adapters.get(adapter.providerId);
    if (existing && existing !== adapter) {
      yield* lifecycleLock.withPermit(stopProvider(adapter.providerId));
    }
    adapters.set(adapter.providerId, adapter);
    yield* reconcile;
  });

  yield* addonConfig.changes.pipe(
    Stream.filter((change) => [...adapters.values()].some((a) => a.addonId === change.id)),
    Stream.runForEach(() => reconcile),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    lifecycleLock.withPermit(Effect.forEach([...running.keys()], stopProvider, { discard: true })),
  );

  const requireSession = Effect.fn("BotsPlatformService.requireSession")(function* (
    providerId: string,
  ) {
    const adapter = adapters.get(providerId);
    if (!adapter) return yield* new BotsPlatformError({ code: "provider_not_found" });
    const entry = running.get(providerId);
    if (!entry) return yield* new BotsPlatformError({ code: "provider_disabled" });
    if (!entry.session) {
      const status = statuses.get(providerId);
      return yield* new BotsPlatformError({
        code: "provider_unavailable",
        ...(status?.detail === undefined ? {} : { detail: status.detail }),
      });
    }
    return entry.session;
  });

  const descriptorFor = (adapter: BotProviderAdapter): BotProviderDescriptor => ({
    providerId: adapter.providerId,
    addonId: adapter.addonId,
    displayName: adapter.displayName,
    transport: adapter.transport,
    experimental: adapter.experimental,
    status: statuses.get(adapter.providerId) ?? { kind: "connecting" },
    capabilities:
      running.get(adapter.providerId)?.session?.capabilities ?? NO_BOT_PROVIDER_CAPABILITIES,
    officialAppUrl: adapter.officialAppUrl,
  });

  const listProviders = Effect.sync(() =>
    [...adapters.values()].filter((adapter) => running.has(adapter.providerId)).map(descriptorFor),
  );

  const addonStatus = (addonId: string) =>
    Effect.sync(() => {
      const adapter = [...adapters.values()].find((a) => a.addonId === addonId);
      if (!adapter) return null;
      if (!running.has(adapter.providerId)) return { kind: "disabled" } as const;
      return statuses.get(adapter.providerId) ?? ({ kind: "connecting" } as const);
    });

  const reconnect = Effect.fn("BotsPlatformService.reconnect")(function* (addonId: string) {
    const adapter = [...adapters.values()].find((a) => a.addonId === addonId);
    if (!adapter) return null;
    const entry = yield* lifecycleLock.withPermit(
      Effect.gen(function* () {
        if (!(yield* closeProvider(adapter.providerId))) return null;
        return yield* startProvider(adapter);
      }),
    );
    if (entry) {
      yield* Deferred.await(entry.settled).pipe(Effect.timeoutOption(RECONNECT_SETTLE_TIMEOUT));
    }
    return yield* addonStatus(addonId);
  });

  /** Polls the provider now instead of after its idle interval, so a reply shows up promptly. */
  const wakeProvider = (providerId: string) =>
    Effect.suspend(() => {
      const wake = running.get(providerId)?.wake;
      return wake ? Deferred.succeed(wake, undefined).pipe(Effect.asVoid) : Effect.void;
    });

  const listBots = Effect.fn("BotsPlatformService.listBots")(function* (providerId: string) {
    const session = yield* requireSession(providerId);
    return yield* session.listBots.pipe(Effect.mapError(platformErrorFromProvider));
  });

  const listConversations = Effect.fn("BotsPlatformService.listConversations")(function* (input: {
    readonly providerId: string;
    readonly botId: string | null;
  }) {
    const session = yield* requireSession(input.providerId);
    return yield* session
      .listConversations({ botId: input.botId })
      .pipe(Effect.mapError(platformErrorFromProvider));
  });

  const getMessages = Effect.fn("BotsPlatformService.getMessages")(function* (input: {
    readonly providerId: string;
    readonly conversationId: string;
    readonly olderCursor: string | null;
    readonly limit: number;
  }) {
    const session = yield* requireSession(input.providerId);
    if (session.capabilities.history === "none") {
      return { messages: [], olderCursor: null } satisfies BotMessagesPage;
    }
    return yield* session
      .getMessages({
        conversationId: input.conversationId,
        olderCursor: session.capabilities.history === "paged" ? input.olderCursor : null,
        limit: Math.max(1, Math.min(MAX_BOT_MESSAGES_PAGE, Math.floor(input.limit))),
      })
      .pipe(Effect.mapError(platformErrorFromProvider));
  });

  const sendMessage = Effect.fn("BotsPlatformService.sendMessage")(function* (
    input: BotSendMessageRequest,
  ) {
    const session = yield* requireSession(input.providerId);
    if (!session.capabilities.sendMessage || !session.sendMessage) {
      return yield* new BotsPlatformError({ code: "unsupported" });
    }
    if (session.capabilities.creditSpendWarning && input.confirmUsage !== true) {
      return yield* new BotsPlatformError({ code: "usage_confirmation_required" });
    }
    return yield* session
      .sendMessage({
        conversationId: input.conversationId,
        text: input.text,
        clientNonce: input.clientNonce,
        replyToId: input.replyToId ?? null,
      })
      .pipe(
        Effect.mapError(platformErrorFromProvider),
        Effect.tap(() => wakeProvider(input.providerId)),
      );
  });

  const respondToRequest = Effect.fn("BotsPlatformService.respondToRequest")(function* (
    input: BotRespondRequest,
  ) {
    const session = yield* requireSession(input.providerId);
    const key = pendingKey(input.providerId, input.requestId);
    const request = (yield* Ref.get(pending)).get(key);
    if (!request) return yield* new BotsPlatformError({ code: "not_found" });
    const supported =
      request.kind === "approval" ? session.capabilities.approvals : session.capabilities.questions;
    if (!supported || !session.respondToRequest) {
      return yield* new BotsPlatformError({ code: "unsupported" });
    }
    yield* session
      .respondToRequest({ requestId: input.requestId, response: input.response })
      .pipe(Effect.mapError(platformErrorFromProvider));
    yield* trackEvent(input.providerId, {
      type: "pending-request-resolved",
      providerId: input.providerId,
      requestId: input.requestId,
    });
    yield* publish({
      type: "pending-request-resolved",
      providerId: input.providerId,
      requestId: input.requestId,
    });
    yield* wakeProvider(input.providerId);
  });

  const cancel = Effect.fn("BotsPlatformService.cancel")(function* (input: BotCancelRequest) {
    const session = yield* requireSession(input.providerId);
    if (!session.capabilities.cancel || !session.cancel) {
      return yield* new BotsPlatformError({ code: "unsupported" });
    }
    yield* session
      .cancel({ conversationId: input.conversationId })
      .pipe(Effect.mapError(platformErrorFromProvider));
    yield* wakeProvider(input.providerId);
  });

  const listPendingRequests = Ref.get(pending).pipe(
    Effect.map((current) =>
      [...current.values()].filter((request) => running.has(request.providerId)),
    ),
  );

  const onSubscribe = Ref.updateAndGet(subscribers, (count) => count + 1).pipe(
    Effect.flatMap((count) => (count === 1 ? listening.open : Effect.void)),
  );
  const onUnsubscribe = Ref.updateAndGet(subscribers, (count) => Math.max(0, count - 1)).pipe(
    Effect.flatMap((count) => (count === 0 ? listening.close : Effect.void)),
  );
  const events = Stream.unwrap(
    Effect.acquireRelease(onSubscribe, () => onUnsubscribe).pipe(
      Effect.as(Stream.fromPubSub(eventsPubSub)),
    ),
  );

  return BotsPlatformService.of({
    register,
    reconcile,
    runningProviderIds: Effect.sync(() => [...running.keys()]),
    addonStatus,
    reconnect,
    listProviders,
    listBots,
    listConversations,
    getMessages,
    sendMessage,
    respondToRequest,
    cancel,
    listPendingRequests,
    events,
  });
});

export const layer = Layer.effect(BotsPlatformService, make);
