import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/**
 * The processes the Claude Cloud add-on runs: short `claude`/`git` commands, and the one
 * interactive `claude --cloud` launch that only works in a terminal. Tests swap this layer
 * so nothing ever reaches Anthropic's servers or a real repository.
 */

const PTY_OUTPUT_LIMIT = 256_000;

export interface ClaudeCloudExecInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

export interface ClaudeCloudExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ClaudeCloudPtyInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Ends the run as soon as it returns a value for the output so far (ANSI removed). */
  readonly match: (output: string) => string | null;
  /** Each answer is typed once, the first time its pattern shows up. */
  readonly answers?: ReadonlyArray<{ readonly when: RegExp; readonly send: string }>;
}

export interface ClaudeCloudPtyResult {
  readonly match: string | null;
  /** The output so far, ANSI removed. */
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export class ClaudeCloudRunnerError extends Schema.TaggedError<ClaudeCloudRunnerError>()(
  "ClaudeCloudRunnerError",
  { command: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not run ${this.command}: ${this.detail}`;
  }
}

export class ClaudeCloudRunner extends Context.Service<
  ClaudeCloudRunner,
  {
    readonly exec: (
      input: ClaudeCloudExecInput,
    ) => Effect.Effect<ClaudeCloudExecResult, ClaudeCloudRunnerError>;
    readonly runPty: (
      input: ClaudeCloudPtyInput,
    ) => Effect.Effect<ClaudeCloudPtyResult, ClaudeCloudRunnerError>;
  }
>()("t3/cloud/ClaudeCloudRunner") {}

// CSI, OSC and two-byte escape sequences, so prompts and URLs match on plain text.
const ANSI_PATTERN = new RegExp(
  [
    String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`,
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`,
    String.raw`\u001b[@-Z\\-_]`,
  ].join("|"),
  "g",
);

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

const appendCapped = (buffer: string, chunk: string) => {
  const next = buffer + chunk;
  return next.length > PTY_OUTPUT_LIMIT ? next.slice(next.length - PTY_OUTPUT_LIMIT) : next;
};

const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;
  const pty = yield* PtyAdapter.PtyAdapter;

  const exec = Effect.fn("ClaudeCloudRunner.exec")(function* (input: ClaudeCloudExecInput) {
    const result = yield* processes
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        timeout: Duration.millis(input.timeoutMs),
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (error) => new ClaudeCloudRunnerError({ command: input.command, detail: error.message }),
        ),
      );
    return {
      exitCode: result.code === null ? null : Number(result.code),
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    } satisfies ClaudeCloudExecResult;
  });

  const runPty = Effect.fn("ClaudeCloudRunner.runPty")(function* (input: ClaudeCloudPtyInput) {
    const child = yield* pty
      .spawn({
        shell: input.command,
        args: [...input.args],
        cwd: input.cwd,
        cols: 200,
        rows: 50,
        env: input.env,
      })
      .pipe(
        Effect.mapError(
          (error) => new ClaudeCloudRunnerError({ command: input.command, detail: error.message }),
        ),
      );
    const seen = { output: "" };
    const finished = Effect.callback<{ match: string | null; exitCode: number | null }>(
      (resume) => {
        const answered = new Set<number>();
        let settled = false;
        const settle = (result: { match: string | null; exitCode: number | null }) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(result));
        };
        const stopData = child.onData((chunk) => {
          seen.output = appendCapped(seen.output, stripAnsi(chunk));
          const match = input.match(seen.output);
          if (match !== null) {
            settle({ match, exitCode: null });
            return;
          }
          input.answers?.forEach((answer, index) => {
            if (answered.has(index) || !answer.when.test(seen.output)) return;
            answered.add(index);
            child.write(answer.send);
          });
        });
        const stopExit = child.onExit((event) =>
          settle({ match: input.match(seen.output), exitCode: event.exitCode }),
        );
        return Effect.sync(() => {
          stopData();
          stopExit();
        });
      },
    );
    const outcome = yield* finished.pipe(
      Effect.timeoutOption(Duration.millis(input.timeoutMs)),
      // The cloud session outlives this terminal; only the local client stops.
      Effect.ensuring(Effect.sync(() => child.kill())),
    );
    return Option.match(outcome, {
      onNone: () => ({ match: null, output: seen.output, exitCode: null, timedOut: true }),
      onSome: (result) => ({ ...result, output: seen.output, timedOut: false }),
    }) satisfies ClaudeCloudPtyResult;
  });

  return ClaudeCloudRunner.of({ exec, runPty });
});

export const layer = Layer.effect(ClaudeCloudRunner, make).pipe(Layer.provide(ProcessRunner.layer));
