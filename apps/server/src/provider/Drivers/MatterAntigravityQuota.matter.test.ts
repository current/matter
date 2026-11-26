import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ProviderUsageLimitsReport } from "@t3tools/provider-core/server/snapshot";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import {
  type AntigravityUsageCommandResult,
  antigravityQuotaWindows,
  interpretAntigravityUsage,
  makeMattrAntigravityQuota,
} from "./MattrAntigravityQuota.ts";

// Recorded from `agy -p /usage --output-format json --print-timeout 20s` (agy 1.5.18).
const USAGE_OUTPUT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response:
    "Gemini Models\tWeekly Limit Remaining\t97%\t2026-12-03T07:25:57Z\nGemini Models\tFive Hour Limit Remaining\t92%\t2026-11-26T18:25:41Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      description:
        "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens.",
      groups: [
        {
          name: "Gemini Models",
          description:
            "Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              description:
                "You have used some of your weekly limit, it will fully refresh in 6 days, 14 hours.",
              window: "weekly",
              remaining_fraction: 0.9740023612976074,
              reset_time: "2026-12-03T07:25:57Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              description:
                "You have used some of your 5-hour limit, it will fully refresh in 1 hour, 32 minutes.",
              window: "5h",
              remaining_fraction: 0.9238702058792114,
              reset_time: "2026-11-26T18:25:41Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
});
// Recorded from a signed-out CLI.
const SIGNED_OUT_OUTPUT = JSON.stringify({
  conversation_id: "",
  status: "ERROR",
  response: "",
  error: "authentication failed or timed out",
  duration_seconds: 0,
  num_turns: 0,
  finished_reason: "error",
});

const ok: AntigravityUsageCommandResult = { exitCode: 0, stdout: USAGE_OUTPUT };
const signedOut: AntigravityUsageCommandResult = { exitCode: 1, stdout: SIGNED_OUT_OUTPUT };
const apiKey: AntigravityUsageCommandResult = { exitCode: 2, stdout: "" };

const model = (slug: string, name: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});
const MODELS = [
  model("gemini-4-neon-high", "Gemini 4 Neon (High)"),
  model("gemini-pro-orchestrator-neon", "Orchestrator (Neon)"),
  model("claude-opus-5-5-high", "Claude Opus 5.5 (High)"),
  model("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
];

const providerSnapshot = (auth: ServerProvider["auth"]["status"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: "1.5.18",
  status: "ready",
  auth: { status: auth },
  checkedAt: "2026-11-26T17:00:00.000Z",
  models: MODELS,
  slashCommands: [],
  skills: [],
});

const NOW = Date.parse("2026-11-26T17:00:00.000Z");

/** A quota reader over scripted `agy -p /usage` results and a fake managed provider. */
const setup = Effect.fn("setup")(function* (options: {
  readonly results: ReadonlyArray<AntigravityUsageCommandResult | "hang">;
  readonly auth?: ServerProvider["auth"]["status"];
  readonly canPoll?: boolean;
  readonly gate?: Deferred.Deferred<void>;
}) {
  yield* TestClock.setTime(NOW);
  const calls = yield* Ref.make(0);
  const interrupted = yield* Ref.make(false);
  const reports: ProviderUsageLimitsReport[] = [];
  const snapshotRef = yield* Ref.make(providerSnapshot(options.auth ?? "authenticated"));
  const quota = yield* makeMattrAntigravityQuota({
    reports: true,
    unsupported: false,
    readUsage: Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(calls, (count) => count + 1);
      if (options.gate) yield* Deferred.await(options.gate);
      const result = options.results[Math.min(index, options.results.length - 1)]!;
      if (result === "hang") {
        return yield* Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true)));
      }
      return result;
    }),
  });
  const getSnapshot = Ref.get(snapshotRef).pipe(Effect.flatMap(quota.attach));
  const snapshot = yield* quota.start(
    {
      getSnapshot,
      refresh: getSnapshot,
      refreshUsage: Effect.void,
      applyUsageLimits: (report) => Effect.sync(() => void reports.push(report)),
    },
    { canPoll: Effect.succeed(options.canPoll ?? true) },
  );
  return { quota, snapshot, calls, interrupted, reports, getSnapshot };
});

const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

describe("interpretAntigravityUsage", () => {
  it("reads every bucket group", () => {
    const read = interpretAntigravityUsage(ok);
    assert.equal(read._tag, "Groups");
    if (read._tag !== "Groups") return;
    assert.deepEqual(
      read.groups.map((group) => group.buckets.map((bucket) => bucket.id)),
      [
        ["gemini-weekly", "gemini-5h"],
        ["3p-weekly", "3p-5h"],
      ],
    );
  });

  it("treats exit code 2 as an API-key connection without quota", () => {
    assert.equal(interpretAntigravityUsage(apiKey)._tag, "Unsupported");
  });

  it("fails on a non-zero exit, an error status, or malformed output", () => {
    assert.equal(interpretAntigravityUsage(signedOut)._tag, "Failed");
    assert.equal(
      interpretAntigravityUsage({ exitCode: 0, stdout: SIGNED_OUT_OUTPUT })._tag,
      "Failed",
    );
    assert.equal(interpretAntigravityUsage({ exitCode: 0, stdout: "{not json" })._tag, "Failed");
    assert.equal(
      interpretAntigravityUsage({ exitCode: 0, stdout: JSON.stringify({ status: "SUCCESS" }) })
        ._tag,
      "Failed",
    );
  });
});

describe("antigravityQuotaWindows", () => {
  const read = interpretAntigravityUsage(ok);
  const groups = read._tag === "Groups" ? read.groups : [];

  it("maps buckets to session and weekly windows scoped to their models", () => {
    assert.deepEqual(antigravityQuotaWindows(groups, MODELS), [
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Weekly · Gemini",
        modelIds: ["gemini-4-neon-high", "gemini-pro-orchestrator-neon"],
        usedPercent: 2.6,
        resetsAt: "2026-12-03T07:25:57.000Z",
        windowDurationMins: 10_080,
      },
      {
        id: "gemini-5h",
        kind: "session",
        label: "Session · Gemini",
        modelIds: ["gemini-4-neon-high", "gemini-pro-orchestrator-neon"],
        usedPercent: 7.6,
        resetsAt: "2026-11-26T18:25:41.000Z",
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        kind: "weekly",
        label: "Weekly · Claude & GPT",
        modelIds: ["claude-opus-5-5-high", "gpt-oss-120b-medium"],
        usedPercent: 0,
        windowDurationMins: 10_080,
      },
      {
        id: "3p-5h",
        kind: "session",
        label: "Session · Claude & GPT",
        modelIds: ["claude-opus-5-5-high", "gpt-oss-120b-medium"],
        usedPercent: 0,
        windowDurationMins: 300,
      },
    ]);
  });

  it("leaves windows unscoped until models load", () => {
    assert.isTrue(antigravityQuotaWindows(groups, []).every((window) => !window.modelIds));
  });

  it("matches a model by its listed name when its slug names no family", () => {
    const [gemini] = antigravityQuotaWindows(groups, [
      model("neon-preview", "Gemini 4 Neon (Low)"),
    ]);
    assert.deepEqual(gemini?.modelIds, ["neon-preview"]);
  });
});

describe("makeMattrAntigravityQuota", () => {
  it.effect("publishes a reading and keeps it when a later read fails", () =>
    Effect.gen(function* () {
      const { snapshot, reports, getSnapshot } = yield* setup({ results: [ok, signedOut] });
      yield* snapshot.refreshUsage!;
      assert.equal(reports.length, 1);
      assert.isTrue(reports[0]!.complete);
      assert.equal(reports[0]!.windows.length, 4);
      const first = (yield* getSnapshot).usageLimits;
      assert.equal(first?.windows.length, 4);
      assert.isUndefined(first?.unavailable);

      yield* TestClock.adjust("1 minute");
      yield* snapshot.refreshUsage!;
      assert.equal(reports.length, 1);
      assert.deepEqual((yield* getSnapshot).usageLimits, first);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed read when there is no earlier reading", () =>
    Effect.gen(function* () {
      const { snapshot, getSnapshot } = yield* setup({ results: [{ exitCode: 0, stdout: "{" }] });
      yield* snapshot.refreshUsage!;
      const limits = (yield* getSnapshot).usageLimits;
      assert.deepEqual(limits?.windows, []);
      assert.equal(limits?.unavailable?.reason, "probeFailed");
    }).pipe(Effect.scoped),
  );

  it.effect("marks an API-key CLI unsupported", () =>
    Effect.gen(function* () {
      const { snapshot, getSnapshot } = yield* setup({ results: [ok, apiKey] });
      yield* snapshot.refreshUsage!;
      yield* TestClock.adjust("1 minute");
      yield* snapshot.refreshUsage!;
      const limits = (yield* getSnapshot).usageLimits;
      assert.deepEqual(limits?.windows, []);
      assert.equal(limits?.unavailable?.reason, "unsupported");
    }).pipe(Effect.scoped),
  );

  it.effect("kills a read after 20 seconds and keeps the last reading", () =>
    Effect.gen(function* () {
      const { snapshot, getSnapshot, interrupted } = yield* setup({ results: [ok, "hang"] });
      yield* snapshot.refreshUsage!;
      const first = (yield* getSnapshot).usageLimits;
      yield* TestClock.adjust("1 minute");
      const fiber = yield* Effect.forkChild(snapshot.refreshUsage!);
      yield* settle;
      yield* TestClock.adjust("19 seconds");
      yield* settle;
      assert.isFalse(yield* Ref.get(interrupted));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.isTrue(yield* Ref.get(interrupted));
      assert.deepEqual((yield* getSnapshot).usageLimits, first);
    }).pipe(Effect.scoped),
  );

  it.effect("runs one CLI call for concurrent refreshes", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { snapshot, calls, reports } = yield* setup({ results: [ok], gate });
      const fibers = yield* Effect.forEach(
        [snapshot.refreshUsage!, snapshot.refresh, snapshot.refreshUsage!],
        (effect) => Effect.forkChild(effect),
      );
      yield* settle;
      assert.equal(yield* Ref.get(calls), 1);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.joinAll(fibers);
      assert.equal(yield* Ref.get(calls), 1);
      assert.equal(reports.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("reads once, 30 seconds after the last of a burst of turns", () =>
    Effect.gen(function* () {
      const { quota, calls } = yield* setup({ results: [ok] });
      for (let turn = 0; turn < 3; turn++) {
        yield* quota.afterTurn;
        yield* settle;
        yield* TestClock.adjust("10 seconds");
      }
      yield* TestClock.adjust("19 seconds");
      yield* settle;
      assert.equal(yield* Ref.get(calls), 0);
      yield* TestClock.adjust("1 second");
      yield* settle;
      assert.equal(yield* Ref.get(calls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("polls every 5 minutes while signed in and watched", () =>
    Effect.gen(function* () {
      const { calls } = yield* setup({ results: [ok] });
      yield* TestClock.adjust("4 minutes");
      yield* settle;
      assert.equal(yield* Ref.get(calls), 0);
      yield* TestClock.adjust("1 minute");
      yield* settle;
      assert.equal(yield* Ref.get(calls), 1);
      yield* TestClock.adjust("5 minutes");
      yield* settle;
      assert.equal(yield* Ref.get(calls), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not poll before sign-in is confirmed or without a client", () =>
    Effect.gen(function* () {
      const unchecked = yield* setup({ results: [ok], auth: "unknown" });
      const unwatched = yield* setup({ results: [ok], canPoll: false });
      yield* TestClock.adjust("15 minutes");
      yield* settle;
      assert.equal(yield* Ref.get(unchecked.calls), 0);
      assert.equal(yield* Ref.get(unwatched.calls), 0);
      // A manual refresh still reads before sign-in is confirmed.
      yield* unchecked.snapshot.refreshUsage!;
      assert.equal(yield* Ref.get(unchecked.calls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves other instances untouched and marks API-key instances unsupported", () =>
    Effect.gen(function* () {
      const base = providerSnapshot("authenticated");
      const other = yield* makeMattrAntigravityQuota({
        reports: false,
        unsupported: false,
        readUsage: Effect.die("never read"),
      });
      assert.strictEqual(yield* other.attach(base), base);
      const keyed = yield* makeMattrAntigravityQuota({
        reports: false,
        unsupported: true,
        readUsage: Effect.die("never read"),
      });
      assert.equal((yield* keyed.attach(base)).usageLimits?.unavailable?.reason, "unsupported");
    }).pipe(Effect.scoped),
  );
});
