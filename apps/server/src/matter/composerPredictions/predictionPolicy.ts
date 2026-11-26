import {
  isDelegatedAppThread,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";

import { buildPredictionTranscript, type PredictionMessage } from "./predictionText.ts";

const PREDICTION_CLAUDE_MODEL = "claude-sonnet-5-5";
/** Chris's protected account: never spent on predictions, whatever the settings say. */
const NEVER_PREDICT_WITH: ReadonlySet<string> = new Set(["claude-alt"]);
const SMALL_CODEX_MODEL = /mini|spark|nano|flash/i;

export type PredictionRoute =
  | { readonly kind: "claude"; readonly instanceId: ProviderInstanceId; readonly model: string }
  | { readonly kind: "codex"; readonly instanceId: ProviderInstanceId; readonly model: string };

const usable = (provider: ServerProvider, nowMs: number, model: string | undefined) =>
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated" &&
  !exhaustedUsageWindow(provider, nowMs, model);

/**
 * Where a prediction may run, best first: Claude instances (the thread's own account first), then
 * a Codex instance with a small model. Excluded instances and `claude-alt` never appear.
 */
export function predictionRoutes(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly threadInstanceId: ProviderInstanceId | null;
  readonly excludedInstanceIds: ReadonlyArray<ProviderInstanceId>;
  /** Instances whose credentials are secret references the predictor cannot read. */
  readonly unreadableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly nowMs: number;
}): ReadonlyArray<PredictionRoute> {
  const excluded = new Set<string>([...NEVER_PREDICT_WITH, ...input.excludedInstanceIds]);
  const allowed = input.providers.filter(
    (provider) =>
      !excluded.has(provider.instanceId) && !input.unreadableInstanceIds?.has(provider.instanceId),
  );
  const threadFirst = allowed.toSorted(
    (left, right) =>
      Number(right.instanceId === input.threadInstanceId) -
      Number(left.instanceId === input.threadInstanceId),
  );
  const claude = threadFirst
    .filter(
      (provider) =>
        provider.driver === "claudeAgent" && usable(provider, input.nowMs, PREDICTION_CLAUDE_MODEL),
    )
    .map((provider) => ({
      kind: "claude" as const,
      instanceId: provider.instanceId,
      model: PREDICTION_CLAUDE_MODEL,
    }));
  const codex = threadFirst.flatMap((provider) => {
    if (provider.driver !== "codex") return [];
    const model = provider.models.find(
      (candidate) =>
        SMALL_CODEX_MODEL.test(candidate.slug) && candidate.supportsTextGeneration !== false,
    )?.slug;
    return model !== undefined && usable(provider, input.nowMs, model)
      ? [{ kind: "codex" as const, instanceId: provider.instanceId, model }]
      : [];
  });
  return [...claude, ...codex];
}

/** The thread itself is working; a prediction would answer a stale turn. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
]);

/**
 * The agent's turn is over. A `waiting` run ended its turn but still holds for background work
 * (subagents, checkpoint capture); the user can answer it now, so it predicts like `completed`.
 */
export const TURN_ENDED_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "waiting"]);

export type PredictionReadiness =
  | { readonly ready: true; readonly transcript: string }
  | {
      readonly ready: false;
      readonly reason:
        | "missing"
        | "delegated"
        | "closed"
        | "not-latest"
        | "busy"
        | "pending-request"
        | "no-transcript";
    };

/**
 * Whether a finished run should get a prediction now: a top-level open thread whose latest run is
 * this one, with nothing queued or running and no question or approval waiting on the user.
 * Background subagents still running don't block it: the user can answer the parent meanwhile.
 */
export function predictionReadiness(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "messages"
  >,
  runId: RunId,
): PredictionReadiness {
  const { thread } = projection;
  if (isDelegatedAppThread(thread)) return { ready: false, reason: "delegated" };
  if (thread.deletedAt !== null || thread.archivedAt !== null) {
    return { ready: false, reason: "closed" };
  }
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return { ready: false, reason: "missing" };
  if (projection.runs.some((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status))) {
    return { ready: false, reason: "busy" };
  }
  const latest = projection.runs.reduce((newest, candidate) =>
    candidate.ordinal > newest.ordinal ? candidate : newest,
  );
  if (!TURN_ENDED_RUN_STATUSES.has(run.status) || latest.id !== run.id) {
    return { ready: false, reason: "not-latest" };
  }
  if (projection.runtimeRequests.some((request) => request.status === "pending")) {
    return { ready: false, reason: "pending-request" };
  }
  const transcript = buildPredictionTranscript(
    projection.messages.map((message): PredictionMessage => ({
      role: message.role,
      text: message.text,
      streaming: message.streaming,
      synthetic:
        message.notification !== undefined ||
        message.idleCompaction !== undefined ||
        message.delegatedCompletion !== undefined ||
        message.workflowScript === true,
    })),
  );
  return transcript === null
    ? { ready: false, reason: "no-transcript" }
    : { ready: true, transcript };
}

/** Least-recently-used map; reads refresh an entry's position. */
export class PredictionLru<V> {
  readonly #entries = new Map<string, V>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get(key: string): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

export const predictionCacheKey = (threadId: string, runId: string, model: string) =>
  `${threadId}\u0000${runId}\u0000${model}`;

const LATENCY_SAMPLES = 16;
const MIN_SAMPLES_FOR_HEDGE = 3;
const MIN_HEDGE_MS = 2_000;
const MAX_HEDGE_MS = 10_000;

/** Recent successful call latencies, for deciding when a slow call earns one hedged retry. */
export class PredictionLatency {
  readonly #samples: Array<number> = [];

  record(ms: number): void {
    this.#samples.push(ms);
    if (this.#samples.length > LATENCY_SAMPLES) this.#samples.shift();
  }

  /** Twice the median, clamped; undefined until there are enough samples to trust. */
  hedgeAfterMs(): number | undefined {
    if (this.#samples.length < MIN_SAMPLES_FOR_HEDGE) return undefined;
    const sorted = this.#samples.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
    return Math.min(MAX_HEDGE_MS, Math.max(MIN_HEDGE_MS, Math.round(median * 2)));
  }
}
