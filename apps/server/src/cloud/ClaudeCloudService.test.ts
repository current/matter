import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  CLAUDE_CLOUD_ADDON_ID,
  type HostPowerSnapshot,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AddonConfigService from "../bots/AddonConfigService.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeCloudRunner from "./ClaudeCloudRunner.ts";
import * as ClaudeCloudService from "./ClaudeCloudService.ts";

const ROOT = "/repo/matter";
const WORKTREE = "/repo/worktrees/claude-cloud-1";
const PROJECT = ProjectId.make("project:matter");
const CLOUD_ID = "cse_01ABCDEFGH1234";
const LOCAL_SESSION = "0d6c7a0e-1b2c-4d5e-8f90-123456789abc";
const IMPORTED_THREAD = ThreadId.make(`import:claude-alt:${LOCAL_SESSION}`);
const CHAT_THREAD = ThreadId.make("thread:chat");
const CHAT_WORKTREE = "/repo/worktrees/chat";

interface Call {
  readonly kind: "exec" | "pty";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly answers?: ReadonlyArray<{ readonly when: RegExp; readonly send: string }>;
}

/** What the fake `claude` and `git` answer; reset before each test. */
let scenario: {
  calls: Array<Call>;
  loggedIn: boolean;
  remote: string;
  upstream: boolean;
  ahead: number;
  dirty: boolean;
  pushExit: number;
  ptyOutput: string;
  followUp: string;
  teleport: string;
  dispatched: Array<OrchestrationV2ServerCommand>;
};

beforeEach(() => {
  scenario = {
    calls: [],
    loggedIn: true,
    remote: "git@github.com:current/matter.git",
    upstream: true,
    ahead: 0,
    dirty: false,
    pushExit: 0,
    ptyOutput: `Starting cloud session…\n\u001b[1mhttps://claude.ai/code/${CLOUD_ID}\u001b[0m\n`,
    followUp: JSON.stringify({ ok: true, session_id: CLOUD_ID, result: "All 412 tests pass." }),
    teleport: JSON.stringify({
      type: "result",
      is_error: false,
      session_id: LOCAL_SESSION,
      result: "Picked up where the cloud left off.",
    }),
    dispatched: [],
  };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-should-be-stripped";
  process.env.ANTHROPIC_AUTH_TOKEN = "token-should-be-stripped";
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const failed = (stderr: string) => ({ exitCode: 1, stdout: "", stderr, timedOut: false });

const fakeExec = (call: Call) => {
  const args = call.args.join(" ");
  if (call.command === "git") {
    if (args === "remote get-url origin") return ok(`${scenario.remote}\n`);
    if (args === "rev-parse --abbrev-ref HEAD") {
      return ok(call.cwd === WORKTREE ? "claude/fix-flaky-tests\n" : "main\n");
    }
    if (args.startsWith("rev-parse --abbrev-ref --symbolic-full-name")) {
      return scenario.upstream ? ok("origin/main\n") : failed("no upstream");
    }
    if (args.startsWith("rev-list --count")) return ok(`${scenario.ahead}\n`);
    if (args === "status --porcelain") return ok(scenario.dirty ? " M src/index.ts\n" : "");
    if (args === "push -u origin HEAD") {
      return scenario.pushExit === 0 ? ok("") : failed("rejected");
    }
    return failed(`unexpected git ${args}`);
  }
  if (args === "auth status --json") {
    return ok(
      JSON.stringify(
        scenario.loggedIn
          ? {
              loggedIn: true,
              authMethod: "claude.ai",
              apiProvider: "firstParty",
              email: "owner@example.com",
              planTier: "max_20x",
            }
          : { loggedIn: false },
      ),
    );
  }
  if (call.args.includes("--teleport")) return ok(scenario.teleport);
  if (call.args.includes("--cloud")) return ok(scenario.followUp);
  return failed(`unexpected claude ${args}`);
};

const layerRunner = Layer.succeed(ClaudeCloudRunner.ClaudeCloudRunner, {
  exec: (input) =>
    Effect.sync(() => {
      const call: Call = { kind: "exec", ...input };
      scenario.calls.push(call);
      return fakeExec(call);
    }),
  runPty: (input) =>
    Effect.sync(() => {
      scenario.calls.push({ kind: "pty", ...input });
      const output = ClaudeCloudRunner.stripAnsi(scenario.ptyOutput);
      return { match: input.match(output), output, exitCode: null, timedOut: false };
    }),
});

const makeDependencies = (
  settings: { readonly fallbackExcludedInstanceIds?: Array<string> } = {},
) =>
  Layer.mergeAll(
    layerRunner,
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("claude-alt")]: {
          driver: "claudeAgent",
          displayName: "Claude Alt",
          config: { homePath: "/Users/test/.claude-alt" },
        },
      },
      ...(settings.fallbackExcludedInstanceIds === undefined
        ? {}
        : {
            fallbackExcludedInstanceIds: settings.fallbackExcludedInstanceIds.map((id) =>
              ProviderInstanceId.make(id),
            ),
          }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          projectId === PROJECT
            ? Option.some({ id: PROJECT, workspaceRoot: ROOT } as unknown as Project)
            : Option.none(),
        ),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: WORKTREE, refName: input.newRefName ?? input.refName },
        }),
    }),
    Layer.mock(AgentSessionImporter.AgentSessionImporter)({
      importRecentAgentThreads: () => Effect.succeed({ importedCount: 1, skippedCount: 0 }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === IMPORTED_THREAD
            ? ({ id: threadId } as unknown as OrchestrationV2ThreadShell)
            : threadId === CHAT_THREAD
              ? ({
                  id: threadId,
                  projectId: PROJECT,
                  worktreePath: CHAT_WORKTREE,
                } as unknown as OrchestrationV2ThreadShell)
              : null,
        ),
      dispatch: (command) =>
        Effect.sync(() => {
          scenario.dispatched.push(command);
          return {} as never;
        }),
    }),
  ).pipe(
    Layer.provideMerge(AddonConfigService.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-cloud-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const layerDependencies = makeDependencies();

const onPower = (patch: Partial<HostPowerSnapshot>) =>
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    snapshot: Effect.succeed({
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: true,
      updatedAt: DateTime.makeUnsafe(0),
      hostPower: {
        source: "electron-main",
        idle: "false",
        idleSeconds: 0,
        locked: "false",
        suspended: false,
        onBattery: "false",
        lowPowerMode: "unknown",
        thermalState: "nominal",
        stale: false,
        updatedAt: DateTime.makeUnsafe(0),
        ...patch,
      },
    }),
  });

const withWeeklyUsage = (usedPercent: number) =>
  Layer.mock(ProviderRegistry)({
    getProviders: Effect.succeed([
      {
        instanceId: ProviderInstanceId.make("claude-alt"),
        usageLimits: {
          checkedAt: "2026-11-27T00:00:00.000Z",
          windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent }],
        },
      } as unknown as ServerProvider,
    ]),
  });

const configure = (enabled: boolean, config: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const addons = yield* AddonConfigService.AddonConfigService;
    yield* addons.setEnabled({ id: CLAUDE_CLOUD_ADDON_ID, enabled });
    if (Object.keys(config).length > 0) yield* addons.updateConfig(CLAUDE_CLOUD_ADDON_ID, config);
  });

const failureOf = <A, R>(effect: Effect.Effect<A, ClaudeCloudService.ClaudeCloudError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ({ code: error.code, message: error.message })),
  );

const claudeCalls = () => scenario.calls.filter((call) => call.command !== "git");

describe("ClaudeCloudService", () => {
  it.effect("does nothing while the add-on is off: no CLI runs, no agent instructions", () =>
    Effect.gen(function* () {
      yield* configure(false);
      const cloud = yield* ClaudeCloudService.make;
      assert.notInclude(buildRuntimeInstructions({ harness: "Claude Code" }), "claude_cloud");
      assert.isFalse(yield* cloud.agentToolsListed);
      const status = yield* cloud.getStatus({ refresh: true });
      assert.isFalse(status.enabled);
      assert.deepStrictEqual(status.accounts, []);
      const launch = yield* failureOf(
        cloud.launchSession({ prompt: "Run the suite", projectId: PROJECT, createdBy: "user" }),
      );
      assert.strictEqual(launch.code, "addon_disabled");
      assert.include(launch.message, "claude-cloud add-on is disabled");
      assert.strictEqual(
        (yield* failureOf(cloud.sendFollowUp({ sessionId: CLOUD_ID, prompt: "hi" }))).code,
        "addon_disabled",
      );
      assert.strictEqual(
        (yield* failureOf(cloud.teleportToWorktree({ sessionId: CLOUD_ID, projectId: PROJECT })))
          .code,
        "addon_disabled",
      );
      assert.deepStrictEqual(scenario.calls, []);
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("adds the delegation note with the user's rules only while agents may delegate", () =>
    Effect.gen(function* () {
      yield* configure(true, {
        agentDelegationMode: "ask",
        delegationRules: "Only test suites over five minutes.",
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const cloud = yield* ClaudeCloudService.make;
          const text = buildRuntimeInstructions({ harness: "Claude Code" });
          assert.include(text, "claude_cloud_launch");
          assert.include(text, "Only test suites over five minutes.");
          assert.include(text, "userApproved: true");
          assert.isTrue(yield* cloud.agentToolsListed);
        }),
      );
      // Closing the service's scope removes its note.
      assert.notInclude(buildRuntimeInstructions({ harness: "Claude Code" }), "claude_cloud");

      yield* configure(true, { agentDelegationMode: "off" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const cloud = yield* ClaudeCloudService.make;
          assert.notInclude(buildRuntimeInstructions({ harness: "Claude Code" }), "claude_cloud");
          assert.isFalse(yield* cloud.agentToolsListed);
        }),
      );
    }).pipe(Effect.provide(layerDependencies)),
  );

  it.effect("enforces the delegation mode and rules for agents, not for the user", () =>
    Effect.gen(function* () {
      const launch = (input: Partial<ClaudeCloudService.ClaudeCloudLaunchInput>) =>
        Effect.gen(function* () {
          const cloud = yield* ClaudeCloudService.make;
          return yield* cloud.launchSession({
            prompt: "Run the full e2e suite",
            projectId: PROJECT,
            createdBy: "agent",
            ...input,
          });
        }).pipe(Effect.scoped);

      yield* configure(true, { agentDelegationMode: "off" });
      assert.strictEqual((yield* failureOf(launch({}))).code, "delegation_off");
      assert.strictEqual((yield* launch({ createdBy: "user" })).session.createdBy, "user");

      yield* configure(true, { agentDelegationMode: "ask" });
      assert.strictEqual((yield* failureOf(launch({}))).code, "approval_required");
      assert.strictEqual((yield* launch({ userApproved: true })).session.createdBy, "agent");

      yield* configure(true, { agentDelegationMode: "auto", delegationRules: "Only e2e suites." });
      const missingReason = yield* failureOf(launch({}));
      assert.strictEqual(missingReason.code, "reason_required");
      assert.include(missingReason.message, "Only e2e suites.");
      const launched = yield* launch({ reason: "The e2e suite takes 20 minutes locally." });
      assert.strictEqual(launched.session.reason, "The e2e suite takes 20 minutes locally.");
    }).pipe(Effect.provide(layerDependencies)),
  );

  it.effect("launches in a PTY with API keys stripped and tracks the session privately", () =>
    Effect.gen(function* () {
      yield* configure(true, { defaultInstanceId: "claude-alt" });
      const cloud = yield* ClaudeCloudService.make;
      const result = yield* cloud.launchSession({
        prompt: "Run the full test suite and fix failures",
        title: "Fix flaky tests",
        projectId: PROJECT,
        createdBy: "user",
      });

      assert.strictEqual(result.session.id, CLOUD_ID);
      assert.strictEqual(result.session.url, `https://claude.ai/code/${CLOUD_ID}`);
      assert.strictEqual(result.session.instanceId, "claude-alt");
      assert.strictEqual(result.session.branch, "main");
      assert.isFalse(result.pushed);

      const pty = scenario.calls.find((call) => call.kind === "pty");
      assert.deepStrictEqual(pty?.args, [
        "-n",
        "Fix flaky tests",
        "--cloud",
        "Run the full test suite and fix failures",
      ]);
      assert.strictEqual(pty?.cwd, ROOT);
      for (const call of claudeCalls()) {
        assert.isUndefined(call.env.ANTHROPIC_API_KEY);
        assert.isUndefined(call.env.ANTHROPIC_AUTH_TOKEN);
        assert.strictEqual(call.env.CLAUDE_CONFIG_DIR, "/Users/test/.claude-alt");
      }

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const file = path.join(config.stateDir, ClaudeCloudService.CLAUDE_CLOUD_SESSIONS_FILENAME);
      assert.strictEqual((yield* fileSystem.stat(file)).mode & 0o777, 0o600);
      const stored = yield* fileSystem.readFileString(file);
      assert.include(stored, CLOUD_ID);
      assert.notInclude(stored, "sk-ant");

      // A fresh service, as after a restart, reads the registry back.
      const restarted = yield* ClaudeCloudService.make;
      assert.deepStrictEqual(
        (yield* restarted.listSessions(PROJECT)).map((session) => session.id),
        [CLOUD_ID],
      );
      assert.isTrue(yield* restarted.forgetSession(`https://claude.ai/code/${CLOUD_ID}`));
      assert.deepStrictEqual(yield* restarted.listSessions(), []);
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("launches from a chat's own worktree and remembers the chat to report back to", () =>
    Effect.gen(function* () {
      yield* configure(true, { defaultInstanceId: "claude-alt" });
      const cloud = yield* ClaudeCloudService.make;
      const result = yield* cloud.launchSession({
        prompt: "Run the e2e suite",
        threadId: CHAT_THREAD,
        createdBy: "user",
      });
      assert.strictEqual(scenario.calls.find((call) => call.kind === "pty")?.cwd, CHAT_WORKTREE);
      assert.strictEqual(result.session.projectId, PROJECT);
      assert.strictEqual(result.session.sourceThreadId, CHAT_THREAD);

      yield* cloud.recordReportedState(CLOUD_ID, "idle");
      assert.strictEqual((yield* cloud.listSessions())[0]?.reportedState, "idle");

      const missing = yield* failureOf(
        cloud.launchSession({
          prompt: "Run the e2e suite",
          threadId: ThreadId.make("thread:gone"),
          createdBy: "user",
        }),
      );
      assert.strictEqual(missing.code, "invalid_request");
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("accepts the folder-trust dialog whichever option the cursor starts on", () =>
    Effect.gen(function* () {
      yield* configure(true);
      const cloud = yield* ClaudeCloudService.make;
      yield* cloud.launchSession({ prompt: "Smoke test", projectId: PROJECT, createdBy: "user" });
      const answers = scenario.calls.find((call) => call.kind === "pty")?.answers ?? [];
      const keysFor = (frame: string) => {
        const output = ClaudeCloudRunner.stripAnsi(frame);
        return answers.find((answer) => answer.when.test(output))?.send;
      };

      // Captured from claude 2.1.332 in a folder whose settings declare hooks.
      const hooksDialog =
        "\u001b[2GTrusting\u001b[11Gthis\u001b[16Gfolder\r\r\n\r\r\n" +
        "\u001b[2G\u276f\u001b[4GNo,\u001b[8Gexit\r\r\n" +
        "\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n" +
        "\u001b[2GEnter\u001b[8Gto\u001b[11Gconfirm\r\r\n";
      assert.strictEqual(keysFor(hooksDialog), "\u001b[B\r");
      assert.strictEqual(
        keysFor("Do you trust the files in this folder?\n\u276f 1. Yes, proceed\n  2. No, exit\n"),
        "\r",
      );
      assert.isUndefined(keysFor("Starting cloud session\u2026\n"));
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("refuses unpushed work unless asked to push, and needs a GitHub remote", () =>
    Effect.gen(function* () {
      yield* configure(true);
      const cloud = yield* ClaudeCloudService.make;
      const launch = (pushFirst?: boolean) =>
        cloud.launchSession({
          prompt: "Build everything",
          projectId: PROJECT,
          createdBy: "user",
          ...(pushFirst === undefined ? {} : { pushFirst }),
        });

      scenario.ahead = 2;
      scenario.dirty = true;
      const refused = yield* failureOf(launch());
      assert.strictEqual(refused.code, "not_eligible");
      assert.include(refused.message, "2 unpushed commit");
      assert.isUndefined(scenario.calls.find((call) => call.kind === "pty"));

      const eligibility = yield* cloud.checkEligibility({ projectId: PROJECT });
      assert.deepStrictEqual(eligibility.blockers, ["unpushed_commits"]);
      assert.strictEqual(eligibility.warnings.length, 1);

      const pushed = yield* launch(true);
      assert.isTrue(pushed.pushed);
      assert.strictEqual(pushed.warnings.length, 1);
      assert.isDefined(
        scenario.calls.find((call) => call.args.join(" ") === "push -u origin HEAD"),
      );

      scenario.remote = "https://gitlab.com/current/matter.git";
      assert.strictEqual((yield* failureOf(launch(true))).code, "not_eligible");
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("reports a signed-out account and a launch that never prints a session", () =>
    Effect.gen(function* () {
      yield* configure(true);
      const cloud = yield* ClaudeCloudService.make;
      scenario.loggedIn = false;
      const signedOut = yield* failureOf(
        cloud.launchSession({ prompt: "Run tests", projectId: PROJECT, createdBy: "user" }),
      );
      assert.strictEqual(signedOut.code, "account_not_ready");
      assert.deepStrictEqual(yield* cloud.addonStatus, {
        kind: "auth_required",
        detail: "No Claude instance has a claude.ai login that can run cloud sessions.",
        action: { kind: "sign-in" },
      });

      scenario.loggedIn = true;
      scenario.ptyOutput = "Error: something went wrong\n";
      yield* cloud.getStatus({ refresh: true });
      assert.deepStrictEqual(yield* cloud.addonStatus, { kind: "connected" });
      const noSession = yield* failureOf(
        cloud.launchSession({ prompt: "Run tests", projectId: PROJECT, createdBy: "user" }),
      );
      assert.strictEqual(noSession.code, "cli_failed");
      assert.include(noSession.message, "something went wrong");
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("sends follow-ups with --cloud and JSON output and records the reply", () =>
    Effect.gen(function* () {
      yield* configure(true);
      const cloud = yield* ClaudeCloudService.make;
      yield* cloud.launchSession({ prompt: "Run tests", projectId: PROJECT, createdBy: "user" });
      const result = yield* cloud.sendFollowUp({
        sessionId: `https://claude.ai/code/${CLOUD_ID}`,
        prompt: "Did they pass?",
      });
      assert.deepStrictEqual(result, { sessionId: CLOUD_ID, reply: "All 412 tests pass." });
      const call = claudeCalls().find((entry) => entry.args.includes("-p"));
      assert.deepStrictEqual(call?.args, [
        "-p",
        "Did they pass?",
        "--cloud",
        CLOUD_ID,
        "--output-format",
        "json",
      ]);
      const [tracked] = yield* cloud.listSessions();
      assert.strictEqual(tracked?.lastReplyPreview, "All 412 tests pass.");
      assert.isString(tracked?.lastMessageAt);

      scenario.followUp = JSON.stringify({
        ok: false,
        session_id: CLOUD_ID,
        error: `Session not found: ${CLOUD_ID}`,
      });
      assert.strictEqual(
        (yield* failureOf(cloud.sendFollowUp({ sessionId: CLOUD_ID, prompt: "hi" }))).code,
        "not_found",
      );
      assert.strictEqual(
        (yield* failureOf(cloud.sendFollowUp({ sessionId: "not-a-session", prompt: "hi" }))).code,
        "invalid_request",
      );
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("teleports into a fresh worktree and opens the imported thread", () =>
    Effect.gen(function* () {
      yield* configure(true, { defaultInstanceId: "claude-alt" });
      const cloud = yield* ClaudeCloudService.make;
      yield* cloud.launchSession({ prompt: "Run tests", projectId: PROJECT, createdBy: "user" });
      const result = yield* cloud.teleportToWorktree({ sessionId: CLOUD_ID, projectId: PROJECT });

      assert.deepStrictEqual(result, {
        sessionId: CLOUD_ID,
        worktreePath: WORKTREE,
        branch: "claude/fix-flaky-tests",
        threadId: IMPORTED_THREAD,
      });
      const teleport = claudeCalls().find((call) => call.args.includes("--teleport"));
      assert.strictEqual(teleport?.cwd, WORKTREE);
      assert.deepStrictEqual(teleport?.args.slice(0, 3), ["--teleport", CLOUD_ID, "-p"]);
      assert.isUndefined(teleport?.env.ANTHROPIC_API_KEY);
      assert.deepStrictEqual(
        scenario.dispatched.map((command) => command.type),
        ["thread.unsettle"],
      );
      const [tracked] = yield* cloud.listSessions();
      assert.strictEqual(tracked?.teleportedThreadId, IMPORTED_THREAD);
      assert.strictEqual(tracked?.teleportedWorktreePath, WORKTREE);

      scenario.teleport = JSON.stringify({
        type: "result",
        is_error: true,
        errors: [`Session not found: ${CLOUD_ID}`],
      });
      const missing = yield* failureOf(
        cloud.teleportToWorktree({ sessionId: CLOUD_ID, projectId: PROJECT }),
      );
      assert.strictEqual(missing.code, "not_found");
      assert.include(missing.message, WORKTREE);
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );
});

describe("ClaudeCloudService offload policy", () => {
  it.effect("advises the cloud on battery and returns the advice with status", () =>
    Effect.gen(function* () {
      yield* configure(true, { offloadPolicy: "balanced" });
      const cloud = yield* ClaudeCloudService.make;
      const status = yield* cloud.getStatus({ refresh: true, projectId: PROJECT });
      assert.deepStrictEqual(status.advice, {
        level: "prefer_cloud",
        reasons: ["On battery power"],
      });

      yield* cloud.updateSettings({ offloadPolicy: "off" });
      assert.strictEqual((yield* cloud.getStatus()).advice?.level, "unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(onPower({ onBattery: "true" }), withWeeklyUsage(10), layerDependencies),
      ),
    ),
  );

  it.effect("keeps agent launches local near the usage limit unless the user agrees", () =>
    Effect.gen(function* () {
      yield* configure(true, { offloadPolicy: "cloud_first" });
      const cloud = yield* ClaudeCloudService.make;
      const status = yield* cloud.getStatus({ refresh: true });
      assert.deepStrictEqual(status.advice, {
        level: "prefer_local",
        reasons: ["Claude weekly limit 95% used"],
      });
      const launch = (input: Partial<ClaudeCloudService.ClaudeCloudLaunchInput>) =>
        cloud.launchSession({
          prompt: "Run the full e2e suite",
          projectId: PROJECT,
          createdBy: "agent",
          ...input,
        });
      const refused = yield* failureOf(launch({}));
      assert.strictEqual(refused.code, "usage_limit");
      assert.include(refused.message, "Claude weekly limit 95% used");
      assert.strictEqual((yield* launch({ userApproved: true })).session.createdBy, "agent");
      assert.strictEqual((yield* launch({ createdBy: "user" })).session.createdBy, "user");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(onPower({ onBattery: "true" }), withWeeklyUsage(95), layerDependencies),
      ),
    ),
  );

  it.effect("writes the policy and the older mode together so either client reads the same", () =>
    Effect.gen(function* () {
      yield* configure(true);
      const cloud = yield* ClaudeCloudService.make;
      assert.deepInclude(yield* cloud.updateSettings({ offloadPolicy: "battery_saver" }), {
        offloadPolicy: "battery_saver",
        agentDelegationMode: "auto",
      });
      // An older client re-saving the same mode keeps the finer policy.
      assert.strictEqual(
        (yield* cloud.updateSettings({ agentDelegationMode: "auto" })).offloadPolicy,
        "battery_saver",
      );
      assert.deepInclude(yield* cloud.updateSettings({ agentDelegationMode: "ask" }), {
        offloadPolicy: "ask",
        agentDelegationMode: "ask",
      });
    }).pipe(Effect.scoped, Effect.provide(layerDependencies)),
  );

  it.effect("never picks an excluded account on its own, but uses it when chosen", () =>
    Effect.gen(function* () {
      yield* configure(true);
      const launch = Effect.gen(function* () {
        const cloud = yield* ClaudeCloudService.make;
        return yield* cloud.launchSession({
          prompt: "Run the suite",
          projectId: PROJECT,
          createdBy: "agent",
        });
      }).pipe(Effect.scoped);
      const refused = yield* failureOf(launch);
      assert.strictEqual(refused.code, "account_not_ready");
      assert.include(refused.message, "kept out of automatic picks");
      assert.deepStrictEqual(claudeCalls(), []);

      yield* configure(true, { defaultInstanceId: "claude-alt" });
      assert.strictEqual((yield* launch).session.instanceId, "claude-alt");
    }).pipe(
      Effect.provide(
        makeDependencies({ fallbackExcludedInstanceIds: ["claude-alt", "claudeAgent"] }),
      ),
    ),
  );
});

describe("findLaunchedSessionId", () => {
  it("prefers the claude.ai link and falls back to a bare id", () => {
    assert.strictEqual(
      ClaudeCloudService.findLaunchedSessionId(
        "Created session_01XYZ98765 at https://claude.ai/code/cse_0abcdEFGH999",
      ),
      "cse_0abcdEFGH999",
    );
    assert.strictEqual(
      ClaudeCloudService.findLaunchedSessionId("Cloud session session_01XYZ98765 started"),
      "session_01XYZ98765",
    );
    assert.isNull(ClaudeCloudService.findLaunchedSessionId("Quick safety check: trust?"));
  });
});
