import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CLAUDE_CLOUD_ADDON_ID,
  CLAUDE_CLOUD_THREAD_ID_PREFIX,
  type OrchestrationV2TurnItem,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  MessageId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AddonConfigService from "../bots/AddonConfigService.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeCloudRunner from "./ClaudeCloudRunner.ts";
import * as ClaudeCloudService from "./ClaudeCloudService.ts";
import * as ClaudeCloudSessionsApi from "./ClaudeCloudSessionsApi.ts";
import { layerClaudeCloudRoutes } from "./claudeCloudHttp.ts";
import type { mapClaudeCloudEvents } from "./claudeCloudTranscript.ts";

type MapClaudeCloudEventsInput = Parameters<typeof mapClaudeCloudEvents>[0];
type MapClaudeCloudEventsResult = ReturnType<typeof mapClaudeCloudEvents>;

const PROJECT = ProjectId.make("project:matter");
const ROOT = "/repo/matter";
const ALT_CONFIG_DIR = "/Users/example/.claude-alt";
const DEFAULT_INSTANCE = ProviderInstanceId.make("claudeAgent");
const ALT_INSTANCE = ProviderInstanceId.make("claude-alt");
const ALT_SERVICE = "Claude Code-credentials-465abecf";
const DEFAULT_SERVICE = "Claude Code-credentials";

interface RecordedExec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface RecordedHttp {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly anthropicVersion: string | undefined;
  readonly anthropicBeta: string | undefined;
  readonly organizationUuid: string | undefined;
}

type HttpResponder = (request: {
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
}) => Effect.Effect<{ readonly status: number; readonly body: unknown }>;

let state: {
  execCalls: Array<RecordedExec>;
  httpCalls: Array<RecordedHttp>;
  keychain: Record<string, Array<{ readonly exitCode: number; readonly stdout: string }>>;
  keychainReads: Record<string, number>;
  accountLoggedIn: Record<string, boolean>;
  httpResponder: HttpResponder;
  followUpReplies: Array<string>;
};

const makeTokenPayload = (token: string, expiresAt: number, asHex = false) => {
  const json = JSON.stringify({
    claudeAiOauth: { accessToken: token, expiresAt },
  });
  return asHex ? Buffer.from(json, "utf8").toString("hex") : json;
};

const makeRemoteSessionApi = (overrides: Record<string, unknown> = {}) => ({
  id: "session_01SYNTH000001",
  title: "Synthetic cloud run",
  session_status: "idle",
  status_bucket: "idle",
  unread: false,
  connection_status: "disconnected",
  environment_kind: "anthropic_cloud",
  origin: "cli",
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-20T12:00:00.000Z",
  configured_model: "claude-opus-5-5",
  post_turn_summary: {
    status_category: "completed",
    status_detail: "Finished synthetic checks",
    recent_action: "Ran checks",
    needs_action: null,
  },
  external_metadata: {
    current_branches: { "": "claude/synthetic-branch" },
    context_usage: { used_tokens: 1200, max_tokens: 200000 },
  },
  session_context: {
    sources: [{ type: "git_repository", url: "https://github.com/acme/widget.git" }],
    cwd: "",
    model: "claude-opus-5-5",
    permission_mode: "auto",
  },
  ...overrides,
});

const makeTurnItem = (
  sessionId: string,
  itemId: string,
  ordinal: number,
  text: string,
): OrchestrationV2TurnItem => ({
  type: "user_message",
  id: TurnItemId.make(itemId),
  threadId: ThreadId.make(`${CLAUDE_CLOUD_THREAD_ID_PREFIX}${sessionId}`),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  startedAt: DateTime.makeUnsafe("2026-11-20T10:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-11-20T10:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-11-20T10:00:01.000Z"),
  creationSource: "provider",
  createdBy: "user",
  messageId: MessageId.make(`msg-${itemId}`),
  inputIntent: "turn_start",
  text,
  attachments: [],
});

const FAR_FUTURE_MS = 4_000_000_000_000;

beforeEach(() => {
  state = {
    execCalls: [],
    httpCalls: [],
    keychain: {
      [DEFAULT_SERVICE]: [
        { exitCode: 0, stdout: makeTokenPayload("tok-default-1", FAR_FUTURE_MS) },
      ],
      [ALT_SERVICE]: [{ exitCode: 0, stdout: makeTokenPayload("tok-alt-1", FAR_FUTURE_MS, true) }],
    },
    keychainReads: {},
    accountLoggedIn: { default: true, alt: true },
    httpResponder: () => Effect.succeed({ status: 200, body: { data: [], has_more: false } }),
    followUpReplies: [JSON.stringify({ ok: true, result: "Synthetic follow-up ack" })],
  };
});

const okExec = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const failExec = (stderr: string) => ({ exitCode: 1, stdout: "", stderr, timedOut: false });

const layerFakeRunner = Layer.succeed(ClaudeCloudRunner.ClaudeCloudRunner, {
  exec: (input) =>
    Effect.sync(() => {
      state.execCalls.push({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
      });
      if (input.command === "security") {
        const serviceIndex = input.args.indexOf("-s");
        const service = serviceIndex >= 0 ? (input.args[serviceIndex + 1] ?? "") : "";
        const count = state.keychainReads[service] ?? 0;
        state.keychainReads[service] = count + 1;
        const responses = state.keychain[service];
        if (!responses || responses.length === 0) {
          return failExec("item not found");
        }
        const entry = responses[Math.min(count, responses.length - 1)]!;
        return { exitCode: entry.exitCode, stdout: entry.stdout, stderr: "", timedOut: false };
      }
      if (input.command === "git") {
        const args = input.args.join(" ");
        if (args === "remote get-url origin") return okExec("git@github.com:acme/widget.git\n");
        if (args === "rev-parse --abbrev-ref HEAD") return okExec("main\n");
        if (args.startsWith("rev-parse --abbrev-ref --symbolic-full-name")) {
          return okExec("origin/main\n");
        }
        if (args.startsWith("rev-list --count")) return okExec("0\n");
        if (args === "status --porcelain") return okExec("");
        return failExec(`unexpected git ${args}`);
      }
      const args = input.args.join(" ");
      if (args === "auth status --json") {
        const isAlt = input.env.CLAUDE_CONFIG_DIR === ALT_CONFIG_DIR;
        const loggedIn = isAlt ? state.accountLoggedIn.alt : state.accountLoggedIn.default;
        return okExec(
          JSON.stringify(
            loggedIn
              ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }
              : { loggedIn: false },
          ),
        );
      }
      if (input.args.includes("--cloud") && input.args.includes("-p")) {
        return okExec(state.followUpReplies[0] ?? JSON.stringify({ ok: true, result: "ok" }));
      }
      return failExec(`unexpected command ${input.command} ${args}`);
    }),
  runPty: (input) =>
    Effect.sync(() => {
      const output = "https://claude.ai/code/session_01TRACKED0001\n";
      return { match: input.match(output), output, exitCode: null, timedOut: false };
    }),
});

const layerFakeHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const parsedUrl = new URL(request.url);
      for (const [key, value] of request.urlParams) {
        parsedUrl.searchParams.append(
          key,
          Redacted.isRedacted(value) ? Redacted.value(value) : value,
        );
      }
      const headers = request.headers as Readonly<Record<string, string>>;
      state.httpCalls.push({
        method: request.method,
        url: parsedUrl.toString(),
        authorization: headers.authorization,
        anthropicVersion: headers["anthropic-version"],
        anthropicBeta: headers["anthropic-beta"],
        organizationUuid: headers["x-organization-uuid"],
      });
      const result = yield* state.httpResponder({
        method: request.method,
        url: parsedUrl.toString(),
        pathname: parsedUrl.pathname,
        searchParams: parsedUrl.searchParams,
        headers,
      });
      const webResponse = new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
      return HttpClientResponse.fromWeb(request, webResponse);
    }),
  ),
);

const makeBaseLayer = (homeDir: string, platform: NodeJS.Platform = "darwin") =>
  Layer.mergeAll(
    layerFakeRunner,
    layerFakeHttpClient,
    ServerSettings.layerTest({
      providerInstances: {
        [DEFAULT_INSTANCE]: {
          driver: "claudeAgent",
          displayName: "Claude Default",
          config: {},
        },
        [ALT_INSTANCE]: {
          driver: "claudeAgent",
          displayName: "Claude Alt",
          config: { homePath: ALT_CONFIG_DIR },
        },
      },
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          projectId === PROJECT
            ? Option.some({ id: PROJECT, workspaceRoot: ROOT } as unknown as Project)
            : Option.none(),
        ),
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  ).pipe(
    Layer.provideMerge(AddonConfigService.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-sessions-api-" }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, platform)),
    Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, homeDir)),
  );

const enableAddon = Effect.gen(function* () {
  const addons = yield* AddonConfigService.AddonConfigService;
  yield* addons.setEnabled({ id: CLAUDE_CLOUD_ADDON_ID, enabled: true });
});

const makeLayerWithServices = (
  homeDir: string,
  options?: ClaudeCloudSessionsApi.ClaudeCloudSessionsApiOptions,
) => {
  const base = makeBaseLayer(homeDir);
  const cloudLayer = Layer.effect(
    ClaudeCloudService.ClaudeCloudService,
    ClaudeCloudService.make,
  ).pipe(Layer.provideMerge(base));
  return Layer.effect(
    ClaudeCloudSessionsApi.ClaudeCloudSessionsApi,
    ClaudeCloudSessionsApi.make(options),
  ).pipe(Layer.provideMerge(cloudLayer));
};

describe("ClaudeCloudSessionsApi", () => {
  it.effect("derives macOS Keychain service names from configDir", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* ClaudeCloudSessionsApi.claudeKeychainServiceName(undefined),
        DEFAULT_SERVICE,
      );
      assert.strictEqual(
        yield* ClaudeCloudSessionsApi.claudeKeychainServiceName(ALT_CONFIG_DIR),
        ALT_SERVICE,
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    "caches tokens until expiry, sends required headers, re-reads once on 401 and never refreshes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const fakeHome = path.join(config.stateDir, "fake-home");
        yield* fs.makeDirectory(fakeHome, { recursive: true });
        yield* fs.writeFileString(
          path.join(fakeHome, ".claude.json"),
          JSON.stringify({ oauthAccount: { organizationUuid: "org-synthetic-123" } }),
        );

        yield* Effect.gen(function* () {
          yield* enableAddon;
          state.keychain[DEFAULT_SERVICE] = [
            { exitCode: 0, stdout: makeTokenPayload("tok-default-1", 60_000) },
          ];
          const api = yield* ClaudeCloudSessionsApi.ClaudeCloudSessionsApi;
          let authAttempts = 0;

          state.httpResponder = ({ headers }) =>
            Effect.sync(() => {
              if (headers.authorization === "Bearer tok-default-1") {
                authAttempts += 1;
                if (authAttempts === 3) {
                  return { status: 401, body: { error: "unauthorized" } };
                }
              }
              return {
                status: 200,
                body: makeRemoteSessionApi({ id: "session_01CACHE00001" }),
              };
            });

          // Two calls before expiry hit the keychain only once.
          yield* api.getSession({
            sessionId: "session_01CACHE00001",
            instanceId: DEFAULT_INSTANCE,
          });
          yield* api.getSession({
            sessionId: "session_01CACHE00001",
            instanceId: DEFAULT_INSTANCE,
          });
          assert.strictEqual(state.keychainReads[DEFAULT_SERVICE], 1);
          assert.strictEqual(state.httpCalls[0]?.authorization, "Bearer tok-default-1");
          assert.strictEqual(state.httpCalls[0]?.anthropicVersion, "2023-06-01");
          assert.strictEqual(state.httpCalls[0]?.anthropicBeta, "ccr-byoc-2025-07-29");
          assert.strictEqual(state.httpCalls[0]?.organizationUuid, "org-synthetic-123");

          // 401 triggers a single keychain re-read and retries once with the fresh token.
          state.keychain[DEFAULT_SERVICE] = [
            { exitCode: 0, stdout: makeTokenPayload("tok-default-1", 60_000) },
            { exitCode: 0, stdout: makeTokenPayload("tok-default-2", 120_000) },
          ];
          yield* api.getSession({
            sessionId: "session_01CACHE00001",
            instanceId: DEFAULT_INSTANCE,
          });
          assert.strictEqual(state.keychainReads[DEFAULT_SERVICE], 2);
          assert.strictEqual(state.httpCalls.at(-1)?.authorization, "Bearer tok-default-2");

          // Advancing past expiry re-reads once; if still expired, fails with api_unavailable and never leaks the token.
          state.keychain[DEFAULT_SERVICE] = [
            { exitCode: 0, stdout: makeTokenPayload("tok-default-1", 60_000) },
            { exitCode: 0, stdout: makeTokenPayload("tok-default-2", 120_000) },
            { exitCode: 0, stdout: makeTokenPayload("tok-secret-expired-xyz", 100_000) },
          ];
          yield* TestClock.adjust("130 seconds");
          const failure = yield* api
            .getSession({ sessionId: "session_01CACHE00001", instanceId: DEFAULT_INSTANCE })
            .pipe(Effect.flip);
          assert.strictEqual(failure.code, "api_unavailable");
          assert.strictEqual(
            failure.message,
            ClaudeCloudSessionsApi.CLAUDE_CLOUD_REFRESH_REQUIRED_DETAIL,
          );
          assert.notInclude(failure.message, "tok-secret-expired-xyz");
          assert.strictEqual(state.keychainReads[DEFAULT_SERVICE], 3);

          // Never calls any refresh endpoint or non-GET method.
          assert.isTrue(state.httpCalls.every((call) => call.method === "GET"));
          assert.isFalse(
            state.httpCalls.some(
              (call) => call.url.includes("oauth") || call.url.includes("refresh"),
            ),
          );

          // If 401 persists after the single re-read, fail cleanly without looping.
          state.keychain[DEFAULT_SERVICE] = [
            { exitCode: 0, stdout: makeTokenPayload("tok-default-valid-ts", FAR_FUTURE_MS) },
          ];
          let readsBefore = state.keychainReads[DEFAULT_SERVICE] ?? 0;
          let callsBefore = state.httpCalls.length;
          state.httpResponder = () => Effect.succeed({ status: 401, body: { error: "revoked" } });
          const revoked = yield* api
            .getSession({ sessionId: "session_01CACHE00001", instanceId: DEFAULT_INSTANCE })
            .pipe(Effect.flip);
          assert.strictEqual(revoked.code, "api_unavailable");
          assert.strictEqual(
            revoked.message,
            ClaudeCloudSessionsApi.CLAUDE_CLOUD_REFRESH_REQUIRED_DETAIL,
          );
          assert.strictEqual((state.keychainReads[DEFAULT_SERVICE] ?? 0) - readsBefore, 2);
          assert.strictEqual(state.httpCalls.length - callsBefore, 2);
        }).pipe(Effect.provide(makeLayerWithServices(fakeHome)));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-home-setup-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("reads credentials from .credentials.json off macOS", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const fakeHome = path.join(config.stateDir, "linux-home");
      yield* fs.makeDirectory(path.join(fakeHome, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(fakeHome, ".claude", ".credentials.json"),
        makeTokenPayload("tok-linux-1", FAR_FUTURE_MS),
      );

      const linuxBase = makeBaseLayer(fakeHome, "linux");
      const linuxCloud = Layer.effect(
        ClaudeCloudService.ClaudeCloudService,
        ClaudeCloudService.make,
      ).pipe(Layer.provideMerge(linuxBase));
      const linuxApi = Layer.effect(
        ClaudeCloudSessionsApi.ClaudeCloudSessionsApi,
        ClaudeCloudSessionsApi.make(),
      ).pipe(Layer.provideMerge(linuxCloud));

      state.httpResponder = () =>
        Effect.succeed({
          status: 200,
          body: makeRemoteSessionApi({ id: "session_01LINUX00001" }),
        });

      yield* Effect.gen(function* () {
        yield* enableAddon;
        const api = yield* ClaudeCloudSessionsApi.ClaudeCloudSessionsApi;
        const session = yield* api.getSession({
          sessionId: "session_01LINUX00001",
          instanceId: DEFAULT_INSTANCE,
        });
        assert.strictEqual(session.id, "session_01LINUX00001");
        assert.strictEqual(state.httpCalls[0]?.authorization, "Bearer tok-linux-1");
        assert.isFalse(state.execCalls.some((call) => call.command === "security"));
      }).pipe(Effect.provide(linuxApi));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-linux-home-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "excludes bridge sessions, collects per-account problems, merges tracked sessions and sorts newest first",
    () =>
      Effect.gen(function* () {
        yield* enableAddon;
        const cloud = yield* ClaudeCloudService.ClaudeCloudService;
        const api = yield* ClaudeCloudSessionsApi.ClaudeCloudSessionsApi;

        // Launch one tracked session on default account.
        yield* cloud.launchSession({
          prompt: "Synthetic tracked task",
          title: "Tracked task",
          projectId: PROJECT,
          instanceId: DEFAULT_INSTANCE,
          createdBy: "user",
        });

        // Alt account returns one valid cloud session, one bridge session (excluded), one archived session.
        // Default account returns one tracked remote session and one newer remote session.
        state.httpResponder = ({ headers }) => {
          if (headers.authorization === "Bearer tok-default-1") {
            return Effect.succeed({
              status: 200,
              body: {
                data: [
                  makeRemoteSessionApi({
                    id: "session_01TRACKED0001",
                    title: "Tracked task (remote title)",
                    updated_at: "2026-11-22T10:00:00.000Z",
                  }),
                  makeRemoteSessionApi({
                    id: "session_01NEWEST00001",
                    title: "Newest remote task",
                    session_status: "running",
                    updated_at: "2026-11-24T15:00:00.000Z",
                  }),
                ],
                has_more: false,
              },
            });
          }
          return Effect.succeed({
            status: 200,
            body: {
              data: [
                makeRemoteSessionApi({
                  id: "session_01BRIDGE00001",
                  title: "Local machine bridge",
                  environment_kind: "bridge",
                  updated_at: "2026-11-25T00:00:00.000Z",
                }),
                makeRemoteSessionApi({
                  id: "session_01ARCHIVED001",
                  title: "Archived session",
                  session_status: "archived",
                  updated_at: "2026-11-23T12:00:00.000Z",
                }),
                makeRemoteSessionApi({
                  id: "session_01ALTCLOUD001",
                  title: "Alt account session",
                  updated_at: "2026-11-21T08:00:00.000Z",
                  post_turn_summary: {
                    status_category: "need_input",
                    status_detail: "Waiting for review",
                    needs_action: "Approve migration",
                  },
                }),
              ],
              has_more: false,
            },
          });
        };

        const active = yield* api.listRemoteSessions();
        assert.deepStrictEqual(active.problems, []);
        assert.deepStrictEqual(
          active.sessions.map((session) => session.id),
          ["session_01NEWEST00001", "session_01TRACKED0001", "session_01ALTCLOUD001"],
        );
        assert.strictEqual(active.sessions[0]?.state, "running");
        assert.strictEqual(active.sessions[1]?.tracked?.id, "session_01TRACKED0001");
        assert.strictEqual(active.sessions[1]?.repository, "acme/widget");
        assert.strictEqual(active.sessions[1]?.branch, "claude/synthetic-branch");
        assert.strictEqual(active.sessions[2]?.state, "needs_input");
        assert.strictEqual(active.sessions[2]?.needsAction, "Approve migration");
        assert.strictEqual(active.sessions[2]?.instanceId, ALT_INSTANCE);

        // Archived sessions appear only when requested.
        const withArchived = yield* api.listRemoteSessions({ includeArchived: true });
        assert.include(
          withArchived.sessions.map((session) => session.id),
          "session_01ARCHIVED001",
        );
        assert.isFalse(
          withArchived.sessions.some((session) => session.id === "session_01BRIDGE00001"),
        );

        // When default account's API fails, it reports a problem and keeps its tracked session.
        state.httpResponder = ({ headers }) => {
          if (headers.authorization === "Bearer tok-default-1") {
            return Effect.succeed({ status: 503, body: { error: "down" } });
          }
          return Effect.succeed({
            status: 200,
            body: {
              data: [
                makeRemoteSessionApi({
                  id: "session_01ALTCLOUD001",
                  updated_at: "2026-11-21T08:00:00.000Z",
                }),
              ],
              has_more: false,
            },
          });
        };

        const degraded = yield* api.listRemoteSessions();
        assert.strictEqual(degraded.problems.length, 1);
        assert.strictEqual(degraded.problems[0]?.instanceId, DEFAULT_INSTANCE);
        assert.isTrue(degraded.sessions.some((session) => session.id === "session_01TRACKED0001"));
        assert.isTrue(degraded.sessions.some((session) => session.id === "session_01ALTCLOUD001"));
      }).pipe(Effect.scoped, Effect.provide(makeLayerWithServices("/tmp/matter-test-home"))),
  );

  it("maps session states in priority order", () => {
    assert.strictEqual(
      ClaudeCloudSessionsApi.mapClaudeCloudSessionState({
        sessionStatus: "archived",
        postTurnSummaryCategory: "need_input",
        transcriptActivity: "running",
      }),
      "archived",
    );
    assert.strictEqual(
      ClaudeCloudSessionsApi.mapClaudeCloudSessionState({
        sessionStatus: "running",
        postTurnSummaryCategory: "need_input",
        transcriptActivity: "idle",
      }),
      "running",
    );
    assert.strictEqual(
      ClaudeCloudSessionsApi.mapClaudeCloudSessionState({
        sessionStatus: "running",
        postTurnSummaryCategory: "completed",
        transcriptActivity: "needs_input",
      }),
      "needs_input",
    );
    assert.strictEqual(
      ClaudeCloudSessionsApi.mapClaudeCloudSessionState({
        sessionStatus: "idle",
        postTurnSummaryCategory: "need_input",
        transcriptActivity: "idle",
      }),
      "needs_input",
    );
    assert.strictEqual(
      ClaudeCloudSessionsApi.mapClaudeCloudSessionState({
        sessionStatus: "idle",
        postTurnSummaryCategory: "completed",
        transcriptActivity: "failed",
      }),
      "failed",
    );
    assert.strictEqual(
      ClaudeCloudSessionsApi.mapClaudeCloudSessionState({
        sessionStatus: "idle",
        postTurnSummaryCategory: "completed",
        transcriptActivity: null,
      }),
      "idle",
    );
  });

  it.effect(
    "pages events, serves full/delta transcript revs, rate-limits to 1s and single-flights concurrent fetches",
    () => {
      const fakeMapper = ({
        sessionId,
        events,
      }: MapClaudeCloudEventsInput): MapClaudeCloudEventsResult => {
        const byId = new Map<string, { ordinal: number; text: string }>();
        let activity: MapClaudeCloudEventsResult["activity"] = null;
        for (const raw of events) {
          const event = raw as Record<string, unknown>;
          if (typeof event.itemId === "string" && typeof event.text === "string") {
            const prev = byId.get(event.itemId);
            byId.set(event.itemId, {
              ordinal: prev?.ordinal ?? byId.size,
              text: event.text,
            });
          }
          if (event.activity === "failed") activity = "failed";
        }
        const turnItems = [...byId.entries()].map(([id, entry]) =>
          makeTurnItem(sessionId, id, entry.ordinal, entry.text),
        );
        return { turnItems, pendingRequest: null, activity };
      };

      return Effect.gen(function* () {
        yield* enableAddon;
        const api = yield* ClaudeCloudSessionsApi.ClaudeCloudSessionsApi;
        const sessionId = "session_01TRANSCRIPT1";
        let eventCalls = 0;

        const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
        const log: Array<Record<string, unknown>> = [
          { uuid: "ev-1", created_at: at(0), itemId: "item-1", text: "Hello" },
          { uuid: "ev-2", created_at: at(120), itemId: "item-2", text: "Working..." },
        ];
        const afterIds: Array<string | null> = [];

        state.httpResponder = ({ pathname, searchParams }) =>
          Effect.sync(() => {
            if (pathname === `/v1/sessions/${sessionId}`) {
              return { status: 200, body: makeRemoteSessionApi({ id: sessionId }) };
            }
            if (pathname === `/v1/sessions/${sessionId}/events`) {
              eventCalls += 1;
              const afterId = searchParams.get("after_id");
              afterIds.push(afterId);
              const start = afterId ? log.findIndex((event) => event.uuid === afterId) + 1 : 0;
              // The first page holds one event, so the initial load pages.
              const data = afterId ? log.slice(start) : log.slice(0, 1);
              const hasMore = start + data.length < log.length;
              return {
                status: 200,
                body: { data, has_more: hasMore, last_id: data.at(-1)?.uuid ?? afterId },
              };
            }
            return { status: 404, body: {} };
          });

        // First load: pages across ev-1 and ev-2, returns full transcript.
        const first = yield* api.getTranscript({ sessionId, instanceId: DEFAULT_INSTANCE });
        assert.isTrue(first.full);
        assert.strictEqual(first.rev, 2);
        assert.strictEqual(first.turnItems.length, 2);
        assert.isFalse(first.canInterrupt);
        assert.strictEqual(eventCalls, 2);

        // Immediate second call within 1s hits cache without fetching.
        const throttled = yield* api.getTranscript({
          sessionId,
          sinceRev: first.rev,
          instanceId: DEFAULT_INSTANCE,
        });
        assert.isFalse(throttled.full);
        assert.deepStrictEqual(throttled.turnItems, []);
        assert.strictEqual(eventCalls, 2);

        // After 1s with no new events, delta is empty and rev stays 2. Refreshes re-read the
        // last minute after ev-1, so an event stored late is still picked up.
        yield* TestClock.adjust("1 second");
        const unchanged = yield* api.getTranscript({
          sessionId,
          sinceRev: first.rev,
          instanceId: DEFAULT_INSTANCE,
        });
        assert.isFalse(unchanged.full);
        assert.strictEqual(unchanged.rev, 2);
        assert.deepStrictEqual(unchanged.turnItems, []);
        assert.strictEqual(eventCalls, 3);
        assert.strictEqual(afterIds.at(-1), "ev-1");

        // After 1s with item-2 updated and item-3 added, only changed/new items return in delta.
        log.push(
          { uuid: "ev-3", created_at: at(121), itemId: "item-2", text: "Done!" },
          {
            uuid: "ev-4",
            created_at: at(122),
            itemId: "item-3",
            text: "Summary",
            activity: "failed",
          },
        );
        yield* TestClock.adjust("1 second");
        const delta = yield* api.getTranscript({
          sessionId,
          sinceRev: unchanged.rev,
          instanceId: DEFAULT_INSTANCE,
        });
        assert.isFalse(delta.full);
        assert.strictEqual(delta.rev, 4);
        assert.deepStrictEqual(
          delta.turnItems.map((item) => item.id),
          ["item-2", "item-3"],
        );
        assert.strictEqual(delta.session.state, "failed");

        // Unknown higher sinceRev returns full transcript.
        const reset = yield* api.getTranscript({
          sessionId,
          sinceRev: 99,
          instanceId: DEFAULT_INSTANCE,
        });
        assert.isTrue(reset.full);
        assert.strictEqual(reset.rev, 4);
        assert.strictEqual(reset.turnItems.length, 3);

        // Single-flight: concurrent calls share one upstream fetch.
        yield* TestClock.adjust("1 second");
        const gate = yield* Deferred.make<void>();
        let concurrentFetches = 0;
        state.httpResponder = ({ pathname }) =>
          Effect.gen(function* () {
            if (pathname === `/v1/sessions/${sessionId}/events`) {
              concurrentFetches += 1;
              yield* Deferred.await(gate);
              return { status: 200, body: { data: [], has_more: false, last_id: "ev-4" } };
            }
            return { status: 200, body: makeRemoteSessionApi({ id: sessionId }) };
          });

        const fiberA = yield* Effect.forkChild(
          api.getTranscript({ sessionId, sinceRev: 4, instanceId: DEFAULT_INSTANCE }),
        );
        const fiberB = yield* Effect.forkChild(
          api.getTranscript({ sessionId, sinceRev: 4, instanceId: DEFAULT_INSTANCE }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        const [resA, resB] = yield* Effect.all([Fiber.join(fiberA), Fiber.join(fiberB)]);
        assert.strictEqual(concurrentFetches, 1);
        assert.strictEqual(resA.rev, 4);
        assert.strictEqual(resB.rev, 4);
      }).pipe(
        Effect.scoped,
        Effect.provide(makeLayerWithServices("/tmp/matter-test-home", { mapEvents: fakeMapper })),
      );
    },
  );

  it.effect("evicts the least-recently-used transcript entry once cache exceeds 12 sessions", () =>
    Effect.gen(function* () {
      yield* enableAddon;
      const api = yield* ClaudeCloudSessionsApi.ClaudeCloudSessionsApi;
      const seenEventAfterIds: Array<{
        readonly sessionId: string;
        readonly afterId: string | null;
      }> = [];

      state.httpResponder = ({ pathname, searchParams }) => {
        const match = /^\/v1\/sessions\/([^/]+)(\/events)?$/.exec(pathname);
        if (!match) return Effect.succeed({ status: 404, body: {} });
        const sessionId = match[1]!;
        if (match[2] === "/events") {
          const afterId = searchParams.get("after_id");
          seenEventAfterIds.push({ sessionId, afterId });
          const events = [
            { uuid: `ev-old-${sessionId}`, created_at: "2026-01-01T00:00:00.000Z" },
            { uuid: `ev-${sessionId}`, created_at: "2026-01-01T00:02:00.000Z" },
          ];
          const data = afterId ? events.slice(1) : events;
          return Effect.succeed({
            status: 200,
            body: { data, has_more: false, last_id: `ev-${sessionId}` },
          });
        }
        return Effect.succeed({ status: 200, body: makeRemoteSessionApi({ id: sessionId }) });
      };

      for (let i = 1; i <= 13; i += 1) {
        const sid = `session_01LRU${String(i).padStart(8, "0")}`;
        yield* api.getTranscript({ sessionId: sid, instanceId: DEFAULT_INSTANCE });
      }
      // Session 1 was evicted when session 13 entered; refetching after 1s sends no after_id (and evicts session 2).
      yield* TestClock.adjust("1 second");
      yield* api.getTranscript({
        sessionId: "session_01LRU00000001",
        instanceId: DEFAULT_INSTANCE,
      });
      const session1Calls = seenEventAfterIds.filter(
        (c) => c.sessionId === "session_01LRU00000001",
      );
      assert.strictEqual(session1Calls.length, 2);
      assert.isNull(session1Calls[1]?.afterId);

      // Session 3 is still cached, so its refetch reads after its overlap cursor.
      yield* api.getTranscript({
        sessionId: "session_01LRU00000003",
        instanceId: DEFAULT_INSTANCE,
      });
      const session3Calls = seenEventAfterIds.filter(
        (c) => c.sessionId === "session_01LRU00000003",
      );
      assert.strictEqual(session3Calls.length, 2);
      assert.strictEqual(session3Calls[1]?.afterId, "ev-old-session_01LRU00000003");
    }).pipe(Effect.scoped, Effect.provide(makeLayerWithServices("/tmp/matter-test-home"))),
  );

  it.effect("picks up an event the API stores after later ones and slots it in by time", () => {
    const orderMapper = ({
      sessionId,
      events,
    }: MapClaudeCloudEventsInput): MapClaudeCloudEventsResult => ({
      turnItems: events.map((raw, index) => {
        const event = raw as Record<string, unknown>;
        return makeTurnItem(sessionId, String(event.uuid), index, String(event.uuid));
      }),
      pendingRequest: null,
      activity: null,
    });
    return Effect.gen(function* () {
      yield* enableAddon;
      const api = yield* ClaudeCloudSessionsApi.ClaudeCloudSessionsApi;
      const sessionId = "session_01LATEEVENT1";
      const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
      const log: Array<Record<string, unknown>> = [
        { uuid: "ev-old", created_at: at(0) },
        { uuid: "ev-result", created_at: at(300) },
        { uuid: "ev-tool", created_at: at(302) },
      ];
      const afterIds: Array<string | null> = [];
      state.httpResponder = ({ pathname, searchParams }) =>
        Effect.sync(() => {
          if (pathname === `/v1/sessions/${sessionId}/events`) {
            const afterId = searchParams.get("after_id");
            afterIds.push(afterId);
            const start = afterId ? log.findIndex((event) => event.uuid === afterId) + 1 : 0;
            const data = log.slice(start);
            return { status: 200, body: { data, has_more: false, last_id: data.at(-1)?.uuid } };
          }
          return { status: 200, body: makeRemoteSessionApi({ id: sessionId }) };
        });

      yield* api.getTranscript({ sessionId, instanceId: DEFAULT_INSTANCE });
      // The follow-up prompt lands in storage after the tool event that it precedes.
      log.splice(2, 0, { uuid: "ev-prompt", created_at: at(301) });
      yield* TestClock.adjust("1 second");
      const next = yield* api.getTranscript({ sessionId, instanceId: DEFAULT_INSTANCE });

      assert.strictEqual(afterIds.at(-1), "ev-old");
      assert.deepStrictEqual(
        next.turnItems.map((item) => item.id),
        ["ev-old", "ev-result", "ev-prompt", "ev-tool"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(makeLayerWithServices("/tmp/matter-test-home", { mapEvents: orderMapper })),
    );
  });

  it.effect(
    "enforces auth scopes, addon enablement, interrupt_unsupported, and untracked followup routing on HTTP routes",
    () =>
      Effect.gen(function* () {
        const fakeHome = "/tmp/matter-http-home";
        let grantedScopes: ReadonlyArray<string> = [AuthOrchestrationReadScope];
        let addonEnabled = false;

        const mockAuthLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: () =>
            Effect.succeed({
              scopes: grantedScopes,
            } as unknown as EnvironmentAuth.AuthenticatedSession),
        });

        const makeHttpLayer = (enabled: boolean) => {
          const base = makeBaseLayer(fakeHome);
          const enableLayer = Layer.effectDiscard(
            Effect.gen(function* () {
              const addons = yield* AddonConfigService.AddonConfigService;
              yield* addons.setEnabled({ id: CLAUDE_CLOUD_ADDON_ID, enabled });
            }),
          ).pipe(Layer.provideMerge(base));
          const cloudLayer = Layer.effect(
            ClaudeCloudService.ClaudeCloudService,
            ClaudeCloudService.make,
          ).pipe(Layer.provideMerge(enableLayer));
          const apiLayer = Layer.effect(
            ClaudeCloudSessionsApi.ClaudeCloudSessionsApi,
            ClaudeCloudSessionsApi.make(),
          ).pipe(Layer.provideMerge(cloudLayer));
          return layerClaudeCloudRoutes.pipe(
            Layer.provide(apiLayer),
            Layer.provideMerge(mockAuthLayer),
            Layer.provideMerge(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
          );
        };

        state.httpResponder = ({ headers, pathname }) => {
          if (pathname === "/v1/sessions") {
            if (headers.authorization === "Bearer tok-alt-1") {
              return Effect.succeed({
                status: 200,
                body: {
                  data: [makeRemoteSessionApi({ id: "session_01UNTRACKED99", title: "From web" })],
                  has_more: false,
                },
              });
            }
            return Effect.succeed({ status: 200, body: { data: [], has_more: false } });
          }
          if (pathname === "/v1/sessions/session_01UNTRACKED99") {
            return Effect.succeed({
              status: 200,
              body: makeRemoteSessionApi({ id: "session_01UNTRACKED99", title: "From web" }),
            });
          }
          if (pathname === "/v1/sessions/session_01UNTRACKED99/events") {
            return Effect.succeed({ status: 200, body: { data: [], has_more: false } });
          }
          return Effect.succeed({ status: 404, body: {} });
        };

        // 1. Add-on disabled -> 409 for all new routes.
        const disabledWeb = HttpRouter.toWebHandler(makeHttpLayer(addonEnabled), {
          disableLogger: true,
        });
        yield* Effect.ensuring(
          Effect.promise(async () => {
            grantedScopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
            const r1 = await disabledWeb.handler(
              new Request("http://127.0.0.1/api/mattr/claude-cloud/remote-sessions"),
            );
            assert.strictEqual(r1.status, 409);
            assert.strictEqual(((await r1.json()) as { error: string }).error, "addon_disabled");

            const r2 = await disabledWeb.handler(
              new Request(
                "http://127.0.0.1/api/mattr/claude-cloud/remote-sessions/session_01UNTRACKED99/transcript",
              ),
            );
            assert.strictEqual(r2.status, 409);

            const r3 = await disabledWeb.handler(
              new Request("http://127.0.0.1/api/mattr/claude-cloud/interrupt", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: "session_01UNTRACKED99" }),
              }),
            );
            assert.strictEqual(r3.status, 409);
          }),
          Effect.promise(() => disabledWeb.dispose()),
        );

        // 2. Add-on enabled -> check read vs operate scopes, interrupt_unsupported, and untracked followup.
        addonEnabled = true;
        const enabledWeb = HttpRouter.toWebHandler(makeHttpLayer(addonEnabled), {
          disableLogger: true,
        });
        yield* Effect.ensuring(
          Effect.promise(async () => {
            // Read-only scope can GET remote-sessions and transcript, but gets 403 on POST interrupt/followup.
            grantedScopes = [AuthOrchestrationReadScope];
            const listResp = await enabledWeb.handler(
              new Request("http://127.0.0.1/api/mattr/claude-cloud/remote-sessions"),
            );
            assert.strictEqual(listResp.status, 200);
            const listJson = (await listResp.json()) as {
              sessions: ReadonlyArray<{ id: string; instanceId: string }>;
            };
            assert.strictEqual(listJson.sessions.length, 1);
            assert.strictEqual(listJson.sessions[0]?.id, "session_01UNTRACKED99");
            assert.strictEqual(listJson.sessions[0]?.instanceId, ALT_INSTANCE);

            const transcriptResp = await enabledWeb.handler(
              new Request(
                `http://127.0.0.1/api/mattr/claude-cloud/remote-sessions/session_01UNTRACKED99/transcript?sinceRev=0&instanceId=${ALT_INSTANCE}`,
              ),
            );
            assert.strictEqual(transcriptResp.status, 200);
            const transcriptJson = (await transcriptResp.json()) as {
              canInterrupt: boolean;
              full: boolean;
              rev: number;
            };
            assert.isFalse(transcriptJson.canInterrupt);
            assert.strictEqual(transcriptJson.rev, 0);

            const badRevResp = await enabledWeb.handler(
              new Request(
                "http://127.0.0.1/api/mattr/claude-cloud/remote-sessions/session_01UNTRACKED99/transcript?sinceRev=abc",
              ),
            );
            assert.strictEqual(badRevResp.status, 400);

            const forbiddenInterrupt = await enabledWeb.handler(
              new Request("http://127.0.0.1/api/mattr/claude-cloud/interrupt", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: "session_01UNTRACKED99" }),
              }),
            );
            assert.strictEqual(forbiddenInterrupt.status, 403);

            const forbiddenFollowUp = await enabledWeb.handler(
              new Request("http://127.0.0.1/api/mattr/claude-cloud/followup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: "session_01UNTRACKED99", prompt: "Status?" }),
              }),
            );
            assert.strictEqual(forbiddenFollowUp.status, 403);

            // Operate scope can call interrupt (501 interrupt_unsupported) and followup on untracked session.
            grantedScopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
            const interruptResp = await enabledWeb.handler(
              new Request("http://127.0.0.1/api/mattr/claude-cloud/interrupt", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: "session_01UNTRACKED99" }),
              }),
            );
            assert.strictEqual(interruptResp.status, 501);
            assert.strictEqual(
              ((await interruptResp.json()) as { error: string }).error,
              "interrupt_unsupported",
            );

            const followUpResp = await enabledWeb.handler(
              new Request("http://127.0.0.1/api/mattr/claude-cloud/followup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: "session_01UNTRACKED99", prompt: "Keep going" }),
              }),
            );
            assert.strictEqual(followUpResp.status, 200);
            const followUpCall = state.execCalls.find(
              (call) => call.args.includes("-p") && call.args.includes("session_01UNTRACKED99"),
            );
            assert.isDefined(followUpCall);
            assert.strictEqual(followUpCall?.cwd, fakeHome);
            assert.strictEqual(followUpCall?.env.CLAUDE_CONFIG_DIR, ALT_CONFIG_DIR);
          }),
          Effect.promise(() => enabledWeb.dispose()),
        );
      }).pipe(Effect.scoped),
  );
});
