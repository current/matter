import { ClaudeSettings, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
} from "../../provider/Drivers/ClaudeHome.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { predictionRoutes, type PredictionRoute } from "./predictionPolicy.ts";
import {
  buildPredictionPrompt,
  PREDICTION_OUTPUT_JSON_SCHEMA,
  PREDICTION_SYSTEM_PROMPT,
  predictionFormatInstruction,
} from "./predictionText.ts";

export class MattrPredictionRunError extends Schema.TaggedError<MattrPredictionRunError>()(
  "MattrPredictionRunError",
  {
    routeKind: Schema.Literals(["claude", "codex"]),
    instanceId: ProviderInstanceId,
    stage: Schema.Literals(["setup", "spawn", "exit", "output"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The ${this.routeKind} prediction on ${this.instanceId} failed at ${this.stage}.`;
  }
}

/** Runs one stateless prediction call; the coordinator owns timing, caching and clean-up. */
export class MattrPredictionRunner extends Context.Service<
  MattrPredictionRunner,
  {
    readonly routes: (input: {
      readonly threadInstanceId: ProviderInstanceId | null;
    }) => Effect.Effect<ReadonlyArray<PredictionRoute>>;
    /** The model's raw answer for the sanitizer. Interrupting it kills the CLI process. */
    readonly run: (input: {
      readonly route: PredictionRoute;
      readonly threadId: ThreadId;
      readonly transcript: string;
    }) => Effect.Effect<unknown, MattrPredictionRunError>;
  }
>()("t3/mattr/composerPredictions/MattrPredictionRunner") {}

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const ClaudeResult = Schema.Struct({
  is_error: Schema.optional(Schema.Boolean),
  structured_output: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.String),
});
const decodeClaudeResult = Schema.decodeUnknownOption(ClaudeResult);
const PREDICTION_JSON_SCHEMA = JSON.stringify(PREDICTION_OUTPUT_JSON_SCHEMA);

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const readSettings = settingsService.getSettings.pipe(Effect.option);

  const routes = Effect.fn("MattrPredictionRunner.routes")(function* (input: {
    readonly threadInstanceId: ProviderInstanceId | null;
  }) {
    const settings = yield* readSettings;
    if (Option.isNone(settings)) return [];
    const configs = deriveProviderInstanceConfigMap(settings.value);
    // A secret-backed variable the predictor cannot read would fall back to another login.
    const unreadableInstanceIds = new Set(
      Object.entries(configs)
        .filter(([, config]) =>
          (config.environment ?? []).some((variable) => typeof variable.value !== "string"),
        )
        .map(([instanceId]) => ProviderInstanceId.make(instanceId)),
    );
    return predictionRoutes({
      providers: yield* providerRegistry.getProviders,
      threadInstanceId: input.threadInstanceId,
      excludedInstanceIds: settings.value.fallbackExcludedInstanceIds,
      unreadableInstanceIds,
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
    });
  });

  const fail = (route: PredictionRoute, stage: MattrPredictionRunError["stage"], cause?: unknown) =>
    new MattrPredictionRunError({
      routeKind: route.kind,
      instanceId: route.instanceId,
      stage,
      ...(cause === undefined ? {} : { cause }),
    });

  const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );

  const runClaude = Effect.fn("MattrPredictionRunner.runClaude")(
    function* (route: PredictionRoute, transcript: string) {
      const settings = yield* readSettings;
      const config = Option.isSome(settings)
        ? deriveProviderInstanceConfigMap(settings.value)[route.instanceId]
        : undefined;
      if (config === undefined) return yield* fail(route, "setup");
      const claudeConfig = Option.getOrElse(decodeClaudeSettings(config.config ?? {}), () =>
        Option.getOrThrow(decodeClaudeSettings({})),
      );
      const processEnv = yield* mergeClaudeProcessEnvironment(
        claudeConfig,
        config.environment,
        process.env,
      );
      const env = yield* makeClaudeEnvironment(claudeConfig, processEnv);
      const binary = claudeConfig.binaryPath.trim();
      const command =
        binary.length > 0 ? expandHomePath(binary, yield* HostProcess.HomeDirectory) : "claude";
      // An empty folder keeps project CLAUDE.md files and settings out of the call.
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "mattr-prediction-" })
        .pipe(Effect.mapError((cause) => fail(route, "setup", cause)));
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      const spawnCommand = yield* resolveSpawnCommand(
        command,
        [
          "-p",
          "--setting-sources",
          "",
          ...(managedMcpConfig ? [] : ["--strict-mcp-config"]),
          "--no-session-persistence",
          "--tools",
          "",
          "--disable-slash-commands",
          "--permission-mode",
          "dontAsk",
          "--settings",
          '{"disableAllHooks":true}',
          "--system-prompt",
          `${PREDICTION_SYSTEM_PROMPT}\n\n${predictionFormatInstruction("suggestion")}`,
          "--output-format",
          "json",
          "--json-schema",
          PREDICTION_JSON_SCHEMA,
          "--model",
          route.model,
          "--effort",
          "low",
        ],
        { env },
      );
      // The prompt goes in on stdin, which then closes, so the CLI never waits for input.
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env,
            cwd,
            shell: spawnCommand.shell,
            stdin: { stream: Stream.encodeText(Stream.make(buildPredictionPrompt(transcript))) },
            forceKillAfter: "1 second",
          }),
        )
        .pipe(Effect.mapError((cause) => fail(route, "spawn", cause)));
      const [stdout, , exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError((cause) => fail(route, "exit", cause)));
      const result = decodeJson(stdout).pipe(Option.flatMap(decodeClaudeResult));
      if (exitCode !== 0 || Option.isNone(result) || result.value.is_error === true) {
        return yield* fail(route, exitCode !== 0 ? "exit" : "output");
      }
      return result.value.structured_output ?? result.value.result ?? null;
    },
    Effect.scoped,
    Effect.provide(services),
  );

  const runCodex = Effect.fn("MattrPredictionRunner.runCodex")(function* (
    route: PredictionRoute,
    transcript: string,
  ) {
    const instance = yield* instanceRegistry.getInstance(route.instanceId);
    if (instance === undefined) return yield* fail(route, "setup");
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "mattr-prediction-" })
      .pipe(Effect.mapError((cause) => fail(route, "setup", cause)));
    const generated = yield* instance.textGeneration
      .generateTranscriptionPostProcessing({
        cwd,
        prompt: `${PREDICTION_SYSTEM_PROMPT}\n\n${predictionFormatInstruction("transcription")}\n\n${buildPredictionPrompt(transcript)}`,
        modelSelection: { instanceId: route.instanceId, model: route.model },
      })
      .pipe(Effect.mapError((cause) => fail(route, "output", cause)));
    return generated.transcription.trim().length === 0 ? null : generated.transcription;
  }, Effect.scoped);

  const run = Effect.fn("MattrPredictionRunner.run")(function* (input: {
    readonly route: PredictionRoute;
    readonly threadId: ThreadId;
    readonly transcript: string;
  }) {
    yield* Effect.annotateCurrentSpan({
      "mattr.prediction.route": input.route.kind,
      "mattr.prediction.instance_id": input.route.instanceId,
      "orchestration_v2.thread_id": input.threadId,
    });
    return input.route.kind === "claude"
      ? yield* runClaude(input.route, input.transcript)
      : yield* runCodex(input.route, input.transcript);
  });

  return MattrPredictionRunner.of({ routes, run });
});

export const layer = Layer.effect(MattrPredictionRunner, make);
