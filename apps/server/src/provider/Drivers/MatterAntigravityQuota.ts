import type {
  ServerProvider,
  ServerProviderModel,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * `agy -p /usage` answers from the account the agy CLI itself is signed in to ($HOME and the OS
 * keyring); it ignores GEMINI_HOME, so T3's per-instance profiles cannot select an account.
 * Only the default instance reports it, so a second account never shows the first one's quota.
 */
const POLL_INTERVAL = "5 minutes";
const TURN_DEBOUNCE = "30 seconds";
const READ_TIMEOUT = "20 seconds";
// Coalesces bursts (manual refresh clicks, several usage-limit failures) into one CLI call.
const MIN_READ_GAP_MS = 15_000;
const MAX_STDOUT_BYTES = 256 * 1024;

const UsageBucket = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  window: Schema.String,
  remaining_fraction: Schema.Number,
  reset_time: Schema.optional(Schema.String),
});

const UsageGroup = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  buckets: Schema.Array(UsageBucket),
});
type UsageGroup = typeof UsageGroup.Type;

const UsageOutput = Schema.Struct({
  status: Schema.String,
  command: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      data: Schema.Struct({ groups: Schema.Array(UsageGroup) }),
    }),
  ),
});
const decodeUsageOutput = Schema.decodeUnknownOption(Schema.fromJsonString(UsageOutput));

export interface AntigravityUsageCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type AntigravityQuotaRead =
  | { readonly _tag: "Groups"; readonly groups: ReadonlyArray<UsageGroup> }
  /** Exit 2: the CLI is connected with an API key, which has no account quota. */
  | { readonly _tag: "Unsupported" }
  | { readonly _tag: "Failed" };

export function interpretAntigravityUsage(
  result: AntigravityUsageCommandResult,
): AntigravityQuotaRead {
  if (result.exitCode === 2) return { _tag: "Unsupported" };
  if (result.exitCode !== 0) return { _tag: "Failed" };
  const output = Option.getOrUndefined(decodeUsageOutput(result.stdout));
  const groups = output?.command?.data.groups.filter((group) => group.buckets.length > 0) ?? [];
  return output?.status === "SUCCESS" && output.command?.name === "usage" && groups.length > 0
    ? { _tag: "Groups", groups }
    : { _tag: "Failed" };
}

const BUCKET_WINDOWS: Record<
  string,
  {
    readonly kind: ServerProviderUsageWindow["kind"];
    readonly label: string;
    readonly mins: number;
  }
> = {
  "5h": { kind: "session", label: "Session", mins: 300 },
  weekly: { kind: "weekly", label: "Weekly", mins: 10_080 },
};
const MODEL_FAMILIES = ["gemini", "claude", "gpt"] as const;

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude & GPT". */
function groupLabel(name: string): string {
  return (
    name
      .replace(/\s+models?$/i, "")
      .replace(/\s+and\s+/gi, " & ")
      .trim() || name.trim()
  );
}

/** Groups name their families and list base model names ("Models within this group: A, B"). */
function groupModelIds(
  group: UsageGroup,
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<string> | undefined {
  const families = MODEL_FAMILIES.filter((family) =>
    new RegExp(`\\b${family}\\b`, "i").test(group.name),
  );
  const listed = (group.description?.replace(/^[^:]*:/, "") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const ids = models.flatMap((model) => {
    const name = model.name.toLowerCase();
    return families.some((family) => model.slug.startsWith(`${family}-`)) ||
      listed.some((entry) => name === entry || name.startsWith(`${entry} (`))
      ? [model.slug]
      : [];
  });
  // An empty list would scope the window to no model; leave it unscoped until models load.
  return ids.length > 0 ? ids : undefined;
}

export function antigravityQuotaWindows(
  groups: ReadonlyArray<UsageGroup>,
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return groups.flatMap((group) => {
    const modelIds = groupModelIds(group, models);
    const label = groupLabel(group.name);
    return group.buckets.flatMap((bucket): ServerProviderUsageWindow[] => {
      const id = bucket.id.trim();
      if (!id) return [];
      const spec = BUCKET_WINDOWS[bucket.window];
      const resetsAt =
        bucket.reset_time === undefined
          ? undefined
          : Option.getOrUndefined(DateTime.make(bucket.reset_time));
      return [
        {
          id,
          kind: spec?.kind ?? "other",
          label: `${spec?.label ?? (bucket.name.trim() || id)} · ${label}`,
          ...(modelIds ? { modelIds } : {}),
          usedPercent: clampPercent(Math.round((1 - bucket.remaining_fraction) * 1000) / 10),
          // An unused bucket reports the Unix epoch.
          ...(resetsAt && DateTime.toEpochMillis(resetsAt) > 0
            ? { resetsAt: DateTime.formatIso(resetsAt) }
            : {}),
          ...(spec ? { windowDurationMins: spec.mins } : {}),
        },
      ];
    });
  });
}

interface AntigravityQuotaState {
  readonly lastGood?: { readonly checkedAt: string; readonly groups: ReadonlyArray<UsageGroup> };
  readonly latest?: { readonly checkedAt: string; readonly tag: AntigravityQuotaRead["_tag"] };
}

/** A failed read keeps the last good bars; with none, it reports the failure. */
function antigravityUsageLimits(
  state: AntigravityQuotaState,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProviderUsageLimits | undefined {
  if (state.latest?.tag === "Unsupported") {
    return makeUnavailableUsageLimits({
      checkedAt: state.latest.checkedAt,
      reason: "unsupported",
      message: "Antigravity has no account quota when connected with an API key.",
    });
  }
  if (state.lastGood) {
    return makeUsageLimits({
      checkedAt: state.lastGood.checkedAt,
      windows: antigravityQuotaWindows(state.lastGood.groups, models),
    });
  }
  return state.latest
    ? makeUnavailableUsageLimits({ checkedAt: state.latest.checkedAt, reason: "probeFailed" })
    : undefined;
}

const antigravityUsageCommandArgs = (logFile: string) => [
  "-p",
  "/usage",
  "--output-format",
  "json",
  "--print-timeout",
  "20s",
  // Keeps the read out of the CLI's shared log folder.
  "--log-file",
  logFile,
];

/** Spawns `agy -p /usage`; the caller's scope owns the child, so closing it kills the CLI. */
export const runAntigravityUsageCommand = Effect.fn("MatterAntigravityQuota.runUsageCommand")(
  function* (input: {
    readonly command: string;
    readonly env: NodeJS.ProcessEnv | undefined;
    readonly cwd: string;
    readonly logFile: string;
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(input.command, antigravityUsageCommandArgs(input.logFile), {
        cwd: input.cwd,
        ...(input.env === undefined ? {} : { env: input.env, extendEnv: false }),
        shell: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_STDOUT_BYTES }),
        child.exitCode,
      ],
      { concurrency: 2 },
    );
    return {
      exitCode: Number(exitCode),
      stdout: stdout.text,
    } satisfies AntigravityUsageCommandResult;
  },
);

type ProviderSnapshot = Pick<
  ManagedServerProvider,
  "getSnapshot" | "refresh" | "refreshUsage" | "applyUsageLimits"
>;

export interface MatterAntigravityQuota {
  /** Adds the latest reading to a snapshot, so provider checks carry it instead of clearing it. */
  readonly attach: (snapshot: ServerProvider) => Effect.Effect<ServerProvider>;
  /** Schedules a read 30 seconds after the last of a burst of turns. */
  readonly afterTurn: Effect.Effect<void>;
  /** Starts polling and routes refreshes through the quota read. */
  readonly start: <S extends ProviderSnapshot>(
    snapshot: S,
    options: { readonly canPoll: Effect.Effect<boolean> },
  ) => Effect.Effect<S>;
}

export const makeMatterAntigravityQuota = Effect.fn("MatterAntigravityQuota.make")(function* <
  E,
>(input: {
  /** False for instances whose account /usage cannot speak for. */
  readonly reports: boolean;
  /** Instances signed in with an API key have no account quota. */
  readonly unsupported: boolean;
  readonly readUsage: Effect.Effect<AntigravityUsageCommandResult, E>;
}) {
  const scope = yield* Effect.scope;
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const stateRef = yield* Ref.make<AntigravityQuotaState>(
    input.unsupported ? { latest: { checkedAt: yield* now, tag: "Unsupported" } } : {},
  );
  let memo:
    | {
        readonly state: AntigravityQuotaState;
        readonly models: ServerProvider["models"];
        readonly limits: ServerProviderUsageLimits | undefined;
      }
    | undefined;
  // attach runs on every stamped snapshot; reuse the object so unchanged snapshots stay equal.
  const limitsFor = (state: AntigravityQuotaState, models: ServerProvider["models"]) => {
    if (memo?.state !== state || memo.models !== models) {
      memo = { state, models, limits: antigravityUsageLimits(state, models) };
    }
    return memo.limits;
  };
  const attach = (snapshot: ServerProvider) =>
    !input.reports && !input.unsupported
      ? Effect.succeed(snapshot)
      : Ref.get(stateRef).pipe(
          Effect.map((state) => {
            const limits = limitsFor(state, snapshot.models);
            return limits ? { ...snapshot, usageLimits: limits } : snapshot;
          }),
        );
  if (!input.reports || input.unsupported) {
    return {
      attach,
      afterTurn: Effect.void,
      start: (snapshot) => Effect.succeed(snapshot),
    } satisfies MatterAntigravityQuota;
  }

  const semaphore = yield* Semaphore.make(1);
  const lastReadAtRef = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const debounceRef = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const providerRef = yield* Ref.make<ProviderSnapshot | undefined>(undefined);

  const read = Effect.fn("MatterAntigravityQuota.read")(function* (provider: ProviderSnapshot) {
    // Timeouts, spawn failures and defects all count as a failed read.
    const exit = yield* input.readUsage.pipe(Effect.timeoutOption(READ_TIMEOUT), Effect.exit);
    const outcome =
      Exit.isSuccess(exit) && Option.isSome(exit.value)
        ? interpretAntigravityUsage(exit.value.value)
        : ({ _tag: "Failed" } as const);
    const checkedAt = yield* now;
    const previous = yield* Ref.getAndUpdate(stateRef, (state) => ({
      ...(outcome._tag === "Groups"
        ? { lastGood: { checkedAt, groups: outcome.groups } }
        : outcome._tag === "Failed" && state.lastGood
          ? { lastGood: state.lastGood }
          : {}),
      latest: { checkedAt, tag: outcome._tag },
    }));
    yield* Ref.set(lastReadAtRef, yield* Clock.currentTimeMillis);
    if (outcome._tag === "Groups") {
      const { models } = yield* provider.getSnapshot;
      yield* provider.applyUsageLimits({
        checkedAt,
        windows: antigravityQuotaWindows(outcome.groups, models),
        complete: true,
      });
    } else if (previous.latest?.tag !== outcome._tag) {
      yield* Effect.logWarning(
        outcome._tag === "Unsupported"
          ? "Antigravity usage is unavailable: the agy CLI is connected with an API key."
          : "Antigravity usage could not be read; keeping the last reading.",
      );
    }
  });

  const readIfReady = Effect.fn("MatterAntigravityQuota.readIfReady")(function* (
    ready: (snapshot: ServerProvider) => boolean,
  ) {
    const provider = yield* Ref.get(providerRef);
    if (provider === undefined) return;
    yield* semaphore.withPermits(1)(
      Effect.gen(function* () {
        const elapsed = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastReadAtRef));
        if (elapsed < MIN_READ_GAP_MS || !ready(yield* provider.getSnapshot)) return;
        yield* read(provider);
      }),
    );
  });
  const usable = (snapshot: ServerProvider) =>
    snapshot.enabled && snapshot.installed && snapshot.auth.status !== "unauthenticated";
  const requested = readIfReady(usable);

  const afterTurn = Effect.gen(function* () {
    const fiber = yield* Effect.sleep(TURN_DEBOUNCE).pipe(
      // The read runs on its own fiber, so a later turn cancels only the wait.
      Effect.andThen(Effect.forkIn(requested, scope)),
      Effect.asVoid,
      Effect.forkIn(scope),
    );
    const previous = yield* Ref.getAndSet(debounceRef, fiber);
    if (previous) yield* Fiber.interrupt(previous);
  });

  const start = Effect.fn("MatterAntigravityQuota.start")(function* <S extends ProviderSnapshot>(
    snapshot: S,
    options: { readonly canPoll: Effect.Effect<boolean> },
  ) {
    yield* Ref.set(providerRef, snapshot);
    const poll = Effect.gen(function* () {
      if (!(yield* options.canPoll)) return;
      yield* readIfReady((current) => usable(current) && current.auth.status === "authenticated");
    });
    yield* Effect.sleep(POLL_INTERVAL).pipe(
      Effect.andThen(poll.pipe(Effect.ignoreCause({ log: true }))),
      Effect.forever,
      Effect.forkIn(scope),
    );
    const started: S = {
      ...snapshot,
      // Read first, so the refreshed snapshot carries the new reading or its failure.
      refresh: requested.pipe(Effect.andThen(snapshot.refresh)),
      refreshUsage: requested,
    };
    return started;
  });

  return { attach, afterTurn, start } satisfies MatterAntigravityQuota;
});
