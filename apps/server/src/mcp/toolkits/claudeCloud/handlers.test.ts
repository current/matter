import { assert, it } from "@effect/vitest";
import {
  CLAUDE_CLOUD_DEFAULT_SETTINGS,
  type ClaudeCloudAddonSettings,
  type ClaudeCloudStatus,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ClaudeCloudService from "../../../cloud/ClaudeCloudService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ClaudeCloudHandlers from "./handlers.ts";
import { ClaudeCloudToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:claude-cloud");
const threadId = ThreadId.make("thread:claude-cloud");
const WORKTREE = "/repo/worktrees/feature";
const CLOUD_ID = "cse_01ABCDEFGH1234";

const statusWith = (
  enabled: boolean,
  settings: Partial<ClaudeCloudAddonSettings> = {},
): ClaudeCloudStatus => ({
  enabled,
  settings: { ...CLAUDE_CLOUD_DEFAULT_SETTINGS, ...settings },
  advice: { level: "prefer_cloud", reasons: ["On battery power"] },
  instances: [],
  accounts: [],
  sessions: [],
});

const statusRequests: Array<unknown> = [];

const run = (
  status: ClaudeCloudStatus,
  body: (
    call: (name: string, params: Record<string, unknown>) => Effect.Effect<unknown>,
    launches: Array<ClaudeCloudService.ClaudeCloudLaunchInput>,
  ) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const launches: Array<ClaudeCloudService.ClaudeCloudLaunchInput> = [];
    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:claude-cloud",
        thread: {
          threadId,
          providerSessionId: "provider:claude-cloud",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), worktreePath: WORKTREE }),
      }),
      Layer.mock(ClaudeCloudService.ClaudeCloudService)({
        getStatus: (options) =>
          Effect.sync(() => {
            statusRequests.push(options);
            return status;
          }),
        launchSession: (input) =>
          Effect.sync(() => {
            launches.push(input);
            return {
              session: {
                id: CLOUD_ID,
                url: `https://claude.ai/code/${CLOUD_ID}`,
                title: "Run e2e",
                promptPreview: input.prompt,
                instanceId: ProviderInstanceId.make("claudeAgent"),
                projectId: input.projectId ?? null,
                cwd: input.cwd ?? null,
                branch: "feature",
                createdBy: input.createdBy,
                sourceThreadId: input.sourceThreadId ?? null,
                reason: input.reason ?? null,
                createdAt: "2026-11-25T00:00:00.000Z",
                lastMessageAt: null,
                lastReplyPreview: null,
                teleportedThreadId: null,
                teleportedWorktreePath: null,
              },
              pushed: false,
              warnings: [],
            };
          }),
        sendFollowUp: (input) =>
          Effect.succeed({ sessionId: CLOUD_ID, reply: `echo ${input.prompt}` }),
        teleportToWorktree: () =>
          Effect.succeed({
            sessionId: CLOUD_ID,
            worktreePath: "/repo/worktrees/cloud",
            branch: "claude/run-e2e",
            threadId: ThreadId.make("import:claudeAgent:abc"),
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* ClaudeCloudToolkit;
      const services = yield* Effect.context<
        | McpInvocationContext.McpInvocationContext
        | ThreadManagement.ThreadManagementService
        | ClaudeCloudService.ClaudeCloudService
      >();
      const call = (name: string, params: Record<string, unknown>) =>
        toolkit.handle(name as "claude_cloud_status", params as never).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts): unknown => parts.at(-1)?.result),
          Effect.provide(services),
          Effect.orDie,
        );
      yield* body(call, launches);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ClaudeCloudHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  });

it.effect("refuses every tool with a clear message while the add-on is off", () =>
  run(statusWith(false), (call, launches) =>
    Effect.gen(function* () {
      for (const [name, params] of [
        ["claude_cloud_status", {}],
        ["claude_cloud_launch", { prompt: "Run tests" }],
        ["claude_cloud_send", { sessionId: CLOUD_ID, prompt: "hi" }],
        ["claude_cloud_teleport", { sessionId: CLOUD_ID }],
      ] as const) {
        const result = (yield* call(name, params)) as { code: string; message: string };
        assert.strictEqual(result.code, "capability_denied", name);
        assert.include(result.message, "claude-cloud add-on is disabled", name);
      }
      assert.deepStrictEqual(launches, []);
    }),
  ),
);

it.effect("refuses launch, send and teleport while the user turned delegation off", () =>
  run(statusWith(true, { agentDelegationMode: "off" }), (call, launches) =>
    Effect.gen(function* () {
      const launched = (yield* call("claude_cloud_launch", { prompt: "Run tests" })) as {
        code: string;
        message: string;
      };
      assert.strictEqual(launched.code, "capability_denied");
      assert.include(launched.message, "turned off agent delegation");
      const sent = (yield* call("claude_cloud_send", { sessionId: CLOUD_ID, prompt: "hi" })) as {
        code: string;
      };
      assert.strictEqual(sent.code, "capability_denied");
      // Status still answers, so an agent can tell the user why.
      const status = (yield* call("claude_cloud_status", {})) as { agentDelegationMode: string };
      assert.strictEqual(status.agentDelegationMode, "off");
      assert.deepStrictEqual(launches, []);
    }),
  ),
);

it.effect("launches as the calling agent from its own worktree and project", () =>
  run(
    statusWith(true, { agentDelegationMode: "auto", delegationRules: "Only e2e suites." }),
    (call, launches) =>
      Effect.gen(function* () {
        const result = yield* call("claude_cloud_launch", {
          prompt: "Run the e2e suite",
          reason: "e2e takes 20 minutes locally",
        });
        assert.deepStrictEqual(result, {
          sessionId: CLOUD_ID,
          url: `https://claude.ai/code/${CLOUD_ID}`,
          title: "Run e2e",
          branch: "feature",
          pushed: false,
          warnings: [],
        });
        assert.strictEqual(launches.length, 1);
        assert.deepInclude(launches[0], {
          createdBy: "agent",
          cwd: WORKTREE,
          projectId: ProjectId.make("project:mcp-test"),
          sourceThreadId: threadId,
          reason: "e2e takes 20 minutes locally",
        });

        statusRequests.length = 0;
        const status = (yield* call("claude_cloud_status", {})) as {
          delegationRules: string;
          advice: unknown;
        };
        assert.strictEqual(status.delegationRules, "Only e2e suites.");
        assert.deepStrictEqual(status.advice, {
          level: "prefer_cloud",
          reasons: ["On battery power"],
        });
        // Readiness is judged by the calling thread's own checkout.
        assert.deepStrictEqual(statusRequests, [
          { projectId: ProjectId.make("project:mcp-test"), cwd: WORKTREE },
        ]);
        assert.deepStrictEqual(
          yield* call("claude_cloud_send", { sessionId: CLOUD_ID, prompt: "ok?" }),
          {
            sessionId: CLOUD_ID,
            reply: "echo ok?",
          },
        );
        const teleported = (yield* call("claude_cloud_teleport", { sessionId: CLOUD_ID })) as {
          threadLink: string | null;
          worktreePath: string;
        };
        assert.strictEqual(teleported.worktreePath, "/repo/worktrees/cloud");
        assert.isString(teleported.threadLink);
      }),
  ),
);

it.effect("hides the tools from tool lists unless agents may delegate, never from calls", () =>
  Effect.gen(function* () {
    const check = (listed: boolean) =>
      ClaudeCloudHandlers.toolListCheck({ agentToolsListed: Effect.succeed(listed) });
    assert.isFalse(yield* check(false)({ method: "tools/list" }));
    assert.isTrue(yield* check(false)({ method: "tools/call" }));
    assert.isTrue(yield* check(true)({ method: "tools/list" }));
  }),
);
