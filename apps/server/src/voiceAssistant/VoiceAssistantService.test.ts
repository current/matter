import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { vi } from "vite-plus/test";

import type {
  VoiceAssistantTurnRequest,
  VoiceWorkspaceContext,
} from "../../../../antimatter/voice-assistant/types.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VoiceAssistantService from "./VoiceAssistantService.ts";
import * as VoiceAssistantFluxWs from "./voiceAssistantFluxWs.ts";
import * as VoiceTtsService from "./VoiceTtsService.ts";

const LOCAL_ENV_ID = EnvironmentId.make("env-local-test");

const emptyContext = (overrides: Partial<VoiceWorkspaceContext> = {}): VoiceWorkspaceContext => ({
  activeEnvironmentId: LOCAL_ENV_ID,
  activeThreadId: null,
  activeRoute: "/",
  mainWindowFocused: true,
  composerFocused: false,
  projects: [],
  threads: [],
  pendingApprovals: [],
  pendingQuestions: [],
  ...overrides,
});

function makeTestHarness(options: {
  readonly llmReplies?: ReadonlyArray<string>;
  readonly llmFail?: boolean;
  readonly onCreateNamedProject?: (name: string) => {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  };
  readonly onLaunchThread?: (input: ThreadLaunchService.ThreadLaunchInput) => void;
  readonly threadProjections?: Readonly<Record<string, OrchestrationV2ThreadProjection>>;
  readonly projectsById?: Readonly<Record<string, Project>>;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) {
  let replyIndex = 0;
  const llmPrompts: Array<string> = [];
  const launchedInputs: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const createdNames: Array<string> = [];
  const projectMap = new Map<string, Project>(Object.entries(options.projectsById ?? {}));

  const fakeProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    supportsTextGeneration: true,
    supportedRuntimeModes: ["approval-required", "full-access"],
    models: [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
  } as unknown as ServerProvider;

  const layer = VoiceAssistantService.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest({
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        ...options.settings,
      }),
    ),
    Layer.provide(
      Layer.succeed(SecretResolver.SecretResolver, {
        read: () => Effect.succeed([]),
        label: () => Effect.succeed("test"),
        invalidate: () => Effect.void,
      } as unknown as SecretResolver.SecretResolver["Service"]),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generateTranscriptionPostProcessing: (input: { readonly prompt: string }) => {
          llmPrompts.push(input.prompt);
          if (options.llmFail) {
            return Effect.fail(new Error("LLM unavailable") as never);
          }
          const next = options.llmReplies?.[replyIndex] ?? "{}";
          replyIndex++;
          return Effect.succeed({ transcription: next });
        },
      } as unknown as TextGeneration.TextGeneration["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProjectService.ProjectService, {
        getById: (projectId: ProjectId) =>
          Effect.succeed(Option.fromUndefinedOr(projectMap.get(projectId))),
        listPage: () => Effect.succeed({ projects: [...projectMap.values()], nextCursor: null }),
        create: (input: ProjectService.ProjectCreateInput) => {
          const now = DateTime.nowUnsafe();
          const created = {
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            repositoryIdentity: null,
            faviconPath: null,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            projectIcon: null,
            scripts: [],
            trackedFolders: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          } as unknown as Project;
          projectMap.set(created.id, created);
          return Effect.succeed(created);
        },
      } as unknown as ProjectService.ProjectService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ManagedProjectFolders.ManagedProjectFolders, {
        createNamedProject: (input: { readonly name: string }) => {
          createdNames.push(input.name);
          const result = options.onCreateNamedProject?.(input.name) ?? {
            projectId: ProjectId.make("project-placket-123"),
            workspaceRoot: "/tmp/projects/placket",
          };
          const now = DateTime.nowUnsafe();
          projectMap.set(result.projectId, {
            id: result.projectId,
            title: input.name,
            workspaceRoot: result.workspaceRoot,
            repositoryIdentity: null,
            faviconPath: null,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            projectIcon: null,
            scripts: [],
            trackedFolders: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          } as unknown as Project);
          return Effect.succeed(result);
        },
        ensureScratchProject: Effect.succeed({
          projectId: ProjectId.make("project-scratch"),
        }),
      } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
        checkWorktreeBase: () => Effect.void,
        launch: (input: ThreadLaunchService.ThreadLaunchInput) => {
          launchedInputs.push(input);
          options.onLaunchThread?.(input);
          const now = DateTime.nowUnsafe();
          const threadId = input.threadId ?? ThreadId.make(`thread-${launchedInputs.length}`);
          return Effect.succeed({
            threadId,
            resumed: false,
            projection: {
              thread: {
                id: threadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                updatedAt: now,
              },
              runs: [],
              messages: [],
              turnItems: [],
            },
          } as unknown as ThreadLaunchService.ThreadLaunchResult);
        },
      } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ThreadManagementService.ThreadManagementService, {
        getThreadShell: (threadId: ThreadId) => {
          const projection = options.threadProjections?.[threadId];
          return Effect.succeed(projection ? projection.thread : null);
        },
        getThreadProjection: (threadId: ThreadId) => {
          const projection = options.threadProjections?.[threadId];
          return projection
            ? Effect.succeed(projection)
            : Effect.fail(new Error(`Missing thread ${threadId}`) as never);
        },
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([fakeProvider]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
    ),
    Layer.provide(
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        execute: () =>
          Effect.succeed({
            exitCode: 0,
            stdout: "main\n",
            stderr: "",
          }),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(LOCAL_ENV_ID),
      } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );

  return { layer, llmPrompts, launchedInputs, createdNames };
}

// Read once outside Effect code: a developer key in the shell changes the expected error.
const DEEPGRAM_ENV_KEY = process.env.DEEPGRAM_API_KEY?.trim();

describe("VoiceAssistantService", () => {
  it.effect("chains create_project into multiple launch_thread actions in one turn", () =>
    Effect.gen(function* () {
      const createdProjectId = ProjectId.make("project-placket-new");
      const planJson = JSON.stringify({
        route: "assistant",
        actions: [
          { type: "create_project", title: "Placket" },
          {
            type: "launch_thread",
            projectName: "Placket",
            title: "Security Audit",
            prompt: "Run a security audit across auth and API endpoints.",
            useWorktree: true,
          },
          {
            type: "launch_thread",
            title: "Performance Audit",
            prompt: "Profile startup latency and memory usage.",
            useWorktree: false,
          },
        ],
        spokenReply:
          "Created the Placket project and opened two threads for security and performance audits.",
        displayReply: "Created Placket · Launched 2 audit threads",
        expectFollowUp: false,
      });

      const harness = makeTestHarness({
        llmReplies: [planJson],
        onCreateNamedProject: () => ({
          projectId: createdProjectId,
          workspaceRoot: "/tmp/projects/placket",
        }),
      });

      const req: VoiceAssistantTurnRequest = {
        utterance:
          "Start a new project for my Placket app and open two threads to run security and perf audits",
        mode: "voice-mode",
        history: [],
        context: emptyContext(),
      };

      const result = yield* VoiceAssistantService.VoiceAssistantService.pipe(
        Effect.flatMap((service) => service.handleTurn(req)),
        Effect.provide(harness.layer),
      );

      assert.strictEqual(result.route, "assistant");
      assert.deepStrictEqual(harness.createdNames, ["Placket"]);
      assert.strictEqual(harness.launchedInputs.length, 2);
      assert.strictEqual(harness.launchedInputs[0]?.projectId, createdProjectId);
      assert.strictEqual(harness.launchedInputs[1]?.projectId, createdProjectId);
      assert.strictEqual(harness.launchedInputs[0]?.workspaceStrategy.type, "worktree");
      assert.strictEqual(harness.launchedInputs[1]?.workspaceStrategy.type, "root");
      assert.strictEqual(result.toolResults.length, 3);
      assert.isTrue(result.toolResults.every((entry) => entry.ok));
      assert.strictEqual(result.toolResults[0]?.projectId, createdProjectId);
      assert.strictEqual(result.toolResults[1]?.projectId, createdProjectId);
      assert.strictEqual(result.toolResults[2]?.projectId, createdProjectId);
    }),
  );

  it.effect("runs a second pass when read_thread is requested", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-auth-refactor");
      const projectId = ProjectId.make("project-mattr");
      const now = DateTime.nowUnsafe();

      const firstPlan = JSON.stringify({
        route: "assistant",
        actions: [{ type: "read_thread", threadTitle: "auth refactor" }],
        spokenReply: "Let me check that thread.",
        displayReply: "Checking Auth Refactor…",
        expectFollowUp: false,
      });
      const secondPlan = JSON.stringify({
        route: "assistant",
        actions: [],
        spokenReply:
          "Auth Refactor finished updating the token middleware and all twelve tests are passing.",
        displayReply: "Auth Refactor done · 12 tests passing",
        expectFollowUp: true,
      });

      const harness = makeTestHarness({
        llmReplies: [firstPlan, secondPlan],
        threadProjections: {
          [threadId]: {
            thread: {
              id: threadId,
              projectId,
              title: "Auth Refactor",
              deletedAt: null,
              updatedAt: now,
            },
            runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
            messages: [
              { id: "m1", role: "user", text: "Refactor token middleware" },
              {
                id: "m2",
                role: "assistant",
                text: "Updated token middleware in `auth/middleware.ts`. All 12 unit tests pass.",
              },
            ],
          } as unknown as OrchestrationV2ThreadProjection,
        },
      });

      const result = yield* VoiceAssistantService.VoiceAssistantService.pipe(
        Effect.flatMap((service) =>
          service.handleTurn({
            utterance: "What did the auth refactor thread finish?",
            mode: "assistant",
            history: [],
            context: emptyContext({
              threads: [
                {
                  environmentId: LOCAL_ENV_ID,
                  threadId,
                  title: "Auth Refactor",
                  projectId,
                  projectTitle: "mattr",
                  status: "done",
                  updatedAt: DateTime.formatIso(now),
                  latestUserMessage: "Refactor token middleware",
                  latestAssistantMessage: null,
                },
              ],
            }),
          }),
        ),
        Effect.provide(harness.layer),
      );

      assert.strictEqual(harness.llmPrompts.length, 2);
      assert.include(harness.llmPrompts[1] ?? "", "All 12 unit tests pass");
      assert.strictEqual(result.toolResults.length, 1);
      assert.strictEqual(result.toolResults[0]?.tool, "read_thread");
      assert.strictEqual(result.toolResults[0]?.ok, true);
      assert.include(result.spokenReply, "twelve tests are passing");
      assert.strictEqual(result.expectFollowUp, true);
    }),
  );

  it.effect("maps client approval and dictation actions to contract shapes", () =>
    Effect.gen(function* () {
      const approvalPlan = JSON.stringify({
        route: "approval",
        actions: [{ type: "respond_approval", decision: "acceptForSession" }],
        spokenReply: "Approved for this session.",
        displayReply: "Approved for session",
        expectFollowUp: false,
      });

      const harness = makeTestHarness({ llmReplies: [approvalPlan] });

      const approvalResult = yield* VoiceAssistantService.VoiceAssistantService.pipe(
        Effect.flatMap((service) =>
          service.handleTurn({
            utterance: "Allow that for this session",
            mode: "smart",
            history: [],
            context: emptyContext({
              pendingApprovals: [
                {
                  environmentId: LOCAL_ENV_ID,
                  threadId: "thread-1",
                  threadTitle: "Deploy Script",
                  requestId: "req-42",
                  requestKind: "command",
                  title: "Run npm test",
                  detail: "npm test",
                  reason: null,
                },
              ],
            }),
          }),
        ),
        Effect.provide(harness.layer),
      );

      assert.strictEqual(approvalResult.route, "approval");
      assert.deepStrictEqual(approvalResult.clientActions, [
        {
          type: "respond-approval",
          environmentId: LOCAL_ENV_ID,
          threadId: "thread-1",
          requestId: "req-42",
          decision: "acceptForSession",
        },
      ]);

      const dictationResult = yield* VoiceAssistantService.VoiceAssistantService.pipe(
        Effect.flatMap((service) =>
          service.handleTurn({
            utterance: "Fix the retry backoff in WebSocket client",
            mode: "dictation",
            history: [],
            context: emptyContext({ composerFocused: true }),
          }),
        ),
        Effect.provide(harness.layer),
      );

      assert.strictEqual(dictationResult.route, "dictation");
      assert.strictEqual(dictationResult.spokenReply, "");
      assert.deepStrictEqual(dictationResult.clientActions, [
        {
          type: "insert-dictation",
          text: "Fix the retry backoff in WebSocket client",
          autoSend: false,
        },
      ]);
    }),
  );

  it.effect(
    "generates deterministic briefings for approvals, questions, and fallback completions",
    () =>
      Effect.gen(function* () {
        const harness = makeTestHarness({ llmFail: true });

        const approval = yield* VoiceAssistantService.VoiceAssistantService.pipe(
          Effect.flatMap((service) =>
            service.generateBriefing({
              kind: "approval",
              threadTitle: "API Migration",
              projectTitle: "mattr",
              detail: "run database migration",
              latestAssistantMessage: null,
            }),
          ),
          Effect.provide(harness.layer),
        );

        assert.strictEqual(harness.llmPrompts.length, 0);
        assert.strictEqual(approval.expectFollowUp, true);
        assert.include(approval.spokenText, "API Migration");
        assert.include(approval.spokenText, "run database migration");
        assert.include(approval.spokenText, "Say approve, always allow, or deny.");

        const question = yield* VoiceAssistantService.VoiceAssistantService.pipe(
          Effect.flatMap((service) =>
            service.generateBriefing({
              kind: "question",
              threadTitle: "UI Polish",
              projectTitle: "mattr",
              detail: null,
              latestAssistantMessage: null,
              questionPrompts: ["Should we keep the compact header on mobile?"],
            }),
          ),
          Effect.provide(harness.layer),
        );

        assert.strictEqual(harness.llmPrompts.length, 0);
        assert.strictEqual(question.expectFollowUp, true);
        assert.include(question.spokenText, "UI Polish has a question");
        assert.include(question.spokenText, "compact header on mobile?");

        const completion = yield* VoiceAssistantService.VoiceAssistantService.pipe(
          Effect.flatMap((service) =>
            service.generateBriefing({
              kind: "completed",
              threadTitle: "Voice Engine",
              projectTitle: "mattr",
              detail: null,
              latestAssistantMessage:
                "## Summary\n\nImplemented `VoiceTtsService` and verified **all tests** pass.\n\n```ts\nconst ok = true;\n```",
            }),
          ),
          Effect.provide(harness.layer),
        );

        assert.strictEqual(completion.expectFollowUp, false);
        assert.include(completion.spokenText, "Voice Engine finished.");
        assert.notInclude(completion.spokenText, "```");
        assert.notInclude(completion.spokenText, "**");
        assert.notInclude(completion.spokenText, "##");
      }),
  );
});

function sseResponse(lines: ReadonlyArray<string>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const openAiDelta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("VoiceAssistantService.streamTurn", () => {
  const directLlmSettings = {
    textGenerators: {
      [ProviderInstanceId.make("voice-llm")]: {
        kind: "openaiCompatible" as const,
        baseUrl: "https://llm.test/v1",
        apiKey: "sk-test",
        enabled: true,
      },
    },
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make("voice-llm"),
      model: "gpt-test",
    },
  };

  it("parses OpenAI-compatible and Anthropic SSE deltas", () => {
    assert.strictEqual(VoiceAssistantService.parseSseTextDelta(openAiDelta("Hi").trim()), "Hi");
    assert.strictEqual(
      VoiceAssistantService.parseSseTextDelta(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yo"}}',
      ),
      "Yo",
    );
    assert.strictEqual(VoiceAssistantService.parseSseTextDelta("data: [DONE]"), "");
    assert.strictEqual(VoiceAssistantService.parseSseTextDelta("event: ping"), "");
  });

  it.effect("speaks an action-free plan while the model is still streaming it", () =>
    Effect.gen(function* () {
      // The plan arrives in pieces that split the field name and the reply mid-sentence.
      const upstream = vi.fn<typeof fetch>(async () =>
        sseResponse([
          openAiDelta('{"route":"assistant","actions":[],"spo'),
          openAiDelta('kenReply":"Hey! Two threads'),
          openAiDelta(' are running."'),
          openAiDelta(',"displayReply":"2 running","expectFollowUp":true}'),
          "data: [DONE]\n\n",
        ]),
      );
      const harness = makeTestHarness({ settings: directLlmSettings });
      const deltas: string[] = [];
      const result = yield* VoiceAssistantService.VoiceAssistantService.pipe(
        Effect.flatMap((service) =>
          service.streamTurn(
            { utterance: "what's up", mode: "voice-mode", history: [], context: emptyContext() },
            {
              onSpokenDelta: (text) => Effect.sync(() => deltas.push(text)),
              onToolResults: () => Effect.die("no tools in this plan"),
            },
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provide(harness.layer),
      );

      assert.deepStrictEqual(deltas, ["Hey! Two threads", " are running."]);
      assert.strictEqual(result.spokenReply, "Hey! Two threads are running.");
      assert.strictEqual(result.expectFollowUp, true);
      assert.strictEqual(harness.llmPrompts.length, 0);
      const [url, init] = upstream.mock.calls[0]!;
      assert.strictEqual(String(url), "https://llm.test/v1/chat/completions");
      assert.strictEqual(JSON.parse(String(init?.body)).stream, true);
    }),
  );

  it.effect("holds a plan with actions until its tools ran, then reports them", () =>
    Effect.gen(function* () {
      const harness = makeTestHarness({
        llmReplies: [
          JSON.stringify({
            route: "assistant",
            actions: [{ type: "launch_thread", prompt: "Run the audit", title: "Audit" }],
            spokenReply: "Started the audit thread.",
            displayReply: "Launched Audit",
            expectFollowUp: false,
          }),
        ],
      });
      const deltas: string[] = [];
      const toolBatches: Array<ReadonlyArray<{ readonly tool: string }>> = [];
      const result = yield* VoiceAssistantService.VoiceAssistantService.pipe(
        Effect.flatMap((service) =>
          service.streamTurn(
            { utterance: "run an audit", mode: "voice-mode", history: [], context: emptyContext() },
            {
              onSpokenDelta: (text) => Effect.sync(() => deltas.push(text)),
              onToolResults: (results) => Effect.sync(() => toolBatches.push(results)),
            },
          ),
        ),
        Effect.provide(harness.layer),
      );

      assert.deepStrictEqual(deltas, []);
      assert.strictEqual(toolBatches.length, 1);
      assert.strictEqual(toolBatches[0]?.[0]?.tool, "launch_thread");
      assert.strictEqual(result.spokenReply, "Started the audit thread.");
    }),
  );
});

describe("VoiceTtsService", () => {
  it("sanitizes markdown, code blocks, and URLs for speech", () => {
    const raw = [
      "## Build Complete",
      "",
      "- Fixed `VoiceTtsService` in [PR #42](https://github.com/current/mattr/pull/42)",
      "- See https://example.com/logs/123 for details",
      "",
      "```ts",
      "console.log('should not be spoken');",
      "```",
      "",
      "**All checks passed.**",
    ].join("\n");

    const sanitized = VoiceTtsService.sanitizeSpeechText(raw);
    assert.notInclude(sanitized, "```");
    assert.notInclude(sanitized, "console.log");
    assert.notInclude(sanitized, "https://");
    assert.notInclude(sanitized, "**");
    assert.notInclude(sanitized, "##");
    assert.include(sanitized, "Build Complete");
    assert.include(sanitized, "PR #42");
    assert.include(sanitized, "All checks passed.");
  });

  it("caps long speech text cleanly", () => {
    const longText = "Sentence one is short. ".repeat(80);
    const capped = VoiceTtsService.sanitizeSpeechText(longText, 120);
    assert.isAtMost(capped.length, 120);
    assert.isTrue(capped.endsWith("."));
  });

  it.effect("synthesizes RIFF WAVE audio via macOS say", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") {
        return;
      }
      const ttsLayer = VoiceTtsService.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mattr-voice-tts-macos-" })),
        Layer.provide(ServerSettings.layerTest({})),
        Layer.provide(
          Layer.succeed(SecretResolver.SecretResolver, {
            read: () => Effect.succeed([]),
            label: () => Effect.succeed("test"),
            invalidate: () => Effect.void,
          } as unknown as SecretResolver.SecretResolver["Service"]),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ProcessRunner.layer),
        Layer.provide(NodeServices.layer),
      );

      const [info, audio] = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        const available = yield* tts.getAvailableTtsInfo;
        const spoken = yield* tts.speak({
          text: "Hello from mattr voice assistant.",
          provider: "macos",
          voice: "Samantha",
          speed: 1.08,
        });
        return [available, spoken] as const;
      }).pipe(Effect.provide(ttsLayer));

      assert.strictEqual(info.macosAvailable, true);
      assert.isAbove(info.macosVoices.length, 0);
      assert.strictEqual(audio.contentType, "audio/wav");
      assert.isAbove(audio.bytes.byteLength, 44);
      const header = new TextDecoder().decode(audio.bytes.slice(0, 4));
      const format = new TextDecoder().decode(audio.bytes.slice(8, 12));
      assert.strictEqual(header, "RIFF");
      assert.strictEqual(format, "WAVE");
    }),
  );

  it.effect("synthesizes MP3 audio via Deepgram Aura-2 TTS with Token auth", () =>
    Effect.gen(function* () {
      const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x01, 0x02]);
      const upstream = vi.fn<typeof fetch>(
        async () =>
          new Response(mp3Bytes, {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          }),
      );
      const ttsLayer = VoiceTtsService.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mattr-voice-dg-tts-" })),
        Layer.provide(ServerSettings.layerTest({})),
        Layer.provide(
          Layer.succeed(SecretResolver.SecretResolver, {
            read: () => Effect.succeed([]),
            label: () => Effect.succeed("test"),
            invalidate: () => Effect.void,
          } as unknown as SecretResolver.SecretResolver["Service"]),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ProcessRunner.layer),
        Layer.provide(NodeServices.layer),
      );

      const [info, audio] = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        const saved = yield* tts.saveDeepgramApiKey("test-deepgram-key-tts");
        assert.strictEqual(saved.deepgramAvailable, true);
        const available = yield* tts.getAvailableTtsInfo;
        const spoken = yield* tts
          .speak({
            text: "Hello from Deepgram Aura two.",
            provider: "deepgram",
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
        return [available, spoken] as const;
      }).pipe(Effect.provide(ttsLayer));

      assert.strictEqual(info.deepgramAvailable, true);
      assert.strictEqual(info.defaultProvider, "deepgram");
      assert.include(info.deepgramVoices, "aura-2-thalia-en");
      assert.strictEqual(audio.contentType, "audio/mpeg");
      assert.deepStrictEqual(audio.bytes, mp3Bytes);

      assert.strictEqual(upstream.mock.calls.length, 1);
      const [url, init] = upstream.mock.calls[0]!;
      assert.strictEqual(
        String(url),
        "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3",
      );
      assert.strictEqual(
        new Headers(init?.headers).get("authorization"),
        "Token test-deepgram-key-tts",
      );
      assert.deepStrictEqual(JSON.parse(String(init?.body)), {
        text: "Hello from Deepgram Aura two.",
      });
    }),
  );

  it.effect("transcribes WAV audio via Deepgram Nova-3 STT with Token auth", () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () =>
        Response.json({
          results: {
            channels: [
              {
                alternatives: [{ transcript: "Approve the iOS build." }],
              },
            ],
          },
        }),
      );
      const ttsLayer = VoiceTtsService.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mattr-voice-dg-stt-" })),
        Layer.provide(ServerSettings.layerTest({})),
        Layer.provide(
          Layer.succeed(SecretResolver.SecretResolver, {
            read: () => Effect.succeed([]),
            label: () => Effect.succeed("test"),
            invalidate: () => Effect.void,
          } as unknown as SecretResolver.SecretResolver["Service"]),
        ),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ProcessRunner.layer),
        Layer.provide(NodeServices.layer),
      );

      const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
      const result = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        yield* tts.saveDeepgramApiKey("test-deepgram-key-stt");
        return yield* tts
          .transcribeDeepgram(fakeWav, "en")
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      }).pipe(Effect.provide(ttsLayer));

      assert.deepStrictEqual(result, {
        text: "Approve the iOS build.",
        provider: "deepgram",
      });
      assert.strictEqual(upstream.mock.calls.length, 1);
      const [url, init] = upstream.mock.calls[0]!;
      assert.strictEqual(
        String(url),
        "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&language=en",
      );
      const headers = new Headers(init?.headers);
      assert.strictEqual(headers.get("authorization"), "Token test-deepgram-key-stt");
      assert.strictEqual(headers.get("content-type"), "audio/wav");
    }),
  );

  it.effect("persists and clears the Deepgram API key in stateDir/mattr-voice-secrets.json", () =>
    Effect.gen(function* () {
      const configLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "mattr-voice-dg-secrets-",
      }).pipe(Layer.provide(NodeServices.layer));
      const fullLayer = Layer.mergeAll(
        configLayer,
        NodeServices.layer,
        VoiceTtsService.layer.pipe(
          Layer.provide(configLayer),
          Layer.provide(ServerSettings.layerTest({})),
          Layer.provide(
            Layer.succeed(SecretResolver.SecretResolver, {
              read: () => Effect.succeed([]),
              label: () => Effect.succeed("test"),
              invalidate: () => Effect.void,
            } as unknown as SecretResolver.SecretResolver["Service"]),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ProcessRunner.layer),
          Layer.provide(NodeServices.layer),
        ),
      );

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tts = yield* VoiceTtsService.VoiceTtsService;
        const secretsPath = path.join(config.stateDir, "mattr-voice-secrets.json");

        const saved = yield* tts.saveDeepgramApiKey("  dg-persisted-key  ");
        assert.strictEqual(saved.deepgramAvailable, true);
        assert.strictEqual(yield* tts.resolveDeepgramApiKey(), "dg-persisted-key");
        const rawSaved = yield* fs.readFileString(secretsPath);
        assert.deepStrictEqual(JSON.parse(rawSaved), { deepgramApiKey: "dg-persisted-key" });

        const cleared = yield* tts.saveDeepgramApiKey("   ");
        const rawCleared = yield* fs.readFileString(secretsPath);
        assert.deepStrictEqual(JSON.parse(rawCleared), {});
        const envKey = yield* Config.String("DEEPGRAM_API_KEY").pipe(
          Config.withDefault(""),
          Effect.orElseSucceed(() => ""),
        );
        if (!envKey.trim()) {
          assert.strictEqual(cleared.deepgramAvailable, false);
          assert.strictEqual(yield* tts.resolveDeepgramApiKey(), null);
        }
      }).pipe(Effect.provide(fullLayer));
    }),
  );
});

const makeTtsTestLayer = (prefix: string) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(
    configLayer,
    NodeServices.layer,
    VoiceTtsService.layer.pipe(
      Layer.provide(configLayer),
      Layer.provide(ServerSettings.layerTest({})),
      Layer.provide(
        Layer.succeed(SecretResolver.SecretResolver, {
          read: () => Effect.succeed([]),
          label: () => Effect.succeed("test"),
          invalidate: () => Effect.void,
        } as unknown as SecretResolver.SecretResolver["Service"]),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(ProcessRunner.layer),
      Layer.provide(NodeServices.layer),
    ),
  );
};

const mp3Response = (bytes: Uint8Array) =>
  new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg" } });

describe("VoiceTtsService ElevenLabs", () => {
  it.effect("synthesizes MP3 via ElevenLabs with xi-api-key, River, and Eleven v4 Turbo", () =>
    Effect.gen(function* () {
      const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
      const upstream = vi.fn<typeof fetch>(async () => mp3Response(mp3Bytes));

      const [status, audio] = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        const saved = yield* tts.saveCredentials({ elevenlabsApiKey: " xi-test-key " });
        const spoken = yield* tts
          .speak({ text: "Hello from **ElevenLabs**.", provider: "elevenlabs" })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
        return [saved, spoken] as const;
      }).pipe(Effect.provide(makeTtsTestLayer("mattr-voice-el-tts-")));

      assert.strictEqual(status.elevenlabsConfigured, true);
      assert.notInclude(JSON.stringify(status), "xi-test-key");
      assert.strictEqual(audio.contentType, "audio/mpeg");
      assert.deepStrictEqual(audio.bytes, mp3Bytes);
      assert.strictEqual(upstream.mock.calls.length, 1);
      const [url, init] = upstream.mock.calls[0]!;
      assert.strictEqual(
        String(url),
        "https://api.elevenlabs.io/v1/text-to-speech/SAz9YHcvj6GT2YYXdXww?output_format=mp3_44100_128",
      );
      assert.strictEqual(new Headers(init?.headers).get("xi-api-key"), "xi-test-key");
      assert.deepStrictEqual(JSON.parse(String(init?.body)), {
        text: "Hello from ElevenLabs.",
        model_id: "eleven_v4_turbo",
        voice_settings: { stability: 0.45, similarity_boost: 0.78 },
      });
    }),
  );

  it.effect("allowlists ElevenLabs models and accepts custom voice ids", () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => mp3Response(new Uint8Array([1])));
      yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        yield* tts.saveCredentials({ elevenlabsApiKey: "xi-key" });
        yield* tts
          .speak({
            text: "One.",
            provider: "elevenlabs",
            voice: "customVoiceId1234567890",
            model: "eleven_flash_v2_5",
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
        yield* tts
          .speak({
            text: "Two.",
            provider: "elevenlabs",
            voice: "../../v1/user",
            model: "eleven_multilingual_evil",
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      }).pipe(Effect.provide(makeTtsTestLayer("mattr-voice-el-allow-")));

      const [firstUrl, firstInit] = upstream.mock.calls[0]!;
      assert.include(String(firstUrl), "/text-to-speech/customVoiceId1234567890?");
      assert.strictEqual(JSON.parse(String(firstInit?.body)).model_id, "eleven_flash_v2_5");
      const [secondUrl, secondInit] = upstream.mock.calls[1]!;
      assert.include(String(secondUrl), "/text-to-speech/SAz9YHcvj6GT2YYXdXww?");
      assert.strictEqual(JSON.parse(String(secondInit?.body)).model_id, "eleven_v4_turbo");
    }),
  );

  it.effect("auto prefers ElevenLabs and falls back to Deepgram when ElevenLabs fails", () =>
    Effect.gen(function* () {
      const dgBytes = new Uint8Array([0xff, 0xfb]);
      const upstream = vi.fn<typeof fetch>(async (input) =>
        String(input).startsWith("https://api.elevenlabs.io/")
          ? new Response("quota", { status: 401 })
          : mp3Response(dgBytes),
      );

      const [info, audio] = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        yield* tts.saveCredentials({ elevenlabsApiKey: "xi-key", deepgramApiKey: "dg-key" });
        const available = yield* tts.getAvailableTtsInfo;
        const spoken = yield* tts
          .speak({ text: "Fallback please." })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
        return [available, spoken] as const;
      }).pipe(Effect.provide(makeTtsTestLayer("mattr-voice-el-fallback-")));

      assert.strictEqual(info.elevenlabsAvailable, true);
      assert.strictEqual(info.deepgramAvailable, true);
      assert.strictEqual(info.defaultProvider, "elevenlabs");
      assert.include(info.elevenlabsModels, "eleven_v4_turbo");
      assert.include(info.elevenlabsVoices, "SAz9YHcvj6GT2YYXdXww");
      assert.deepStrictEqual(audio.bytes, dgBytes);
      assert.deepStrictEqual(
        upstream.mock.calls.map(([url]) => new URL(String(url)).host),
        ["api.elevenlabs.io", "api.deepgram.com"],
      );
    }),
  );

  it.effect("uses saved server preferences when a client sends no provider", () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => mp3Response(new Uint8Array([1])));

      const [saved, info] = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        yield* tts.saveCredentials({ elevenlabsApiKey: "xi-key", deepgramApiKey: "dg-key" });
        const prefs = yield* tts.saveTtsPreferences({
          ttsProvider: "deepgram",
          deepgramVoice: "aura-2-luna-en",
          elevenlabsModel: "not-a-model",
        });
        yield* tts
          .speak({ text: "Deepgram from the phone." })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));

        yield* tts.saveTtsPreferences({
          ttsProvider: "elevenlabs",
          elevenlabsVoice: "EXAVITQu4vr4xnSDxMaL",
          elevenlabsModel: "eleven_v3_conversational",
        });
        yield* tts
          .speak({ text: "ElevenLabs from the phone." })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
        return [prefs, yield* tts.getAvailableTtsInfo] as const;
      }).pipe(Effect.provide(makeTtsTestLayer("mattr-voice-el-prefs-")));

      assert.deepStrictEqual(saved, {
        ttsProvider: "deepgram",
        elevenlabsModel: "eleven_v4_turbo",
        elevenlabsVoice: "SAz9YHcvj6GT2YYXdXww",
        deepgramVoice: "aura-2-luna-en",
      });
      assert.deepStrictEqual(info.preferences, {
        ttsProvider: "elevenlabs",
        elevenlabsModel: "eleven_v3_conversational",
        elevenlabsVoice: "EXAVITQu4vr4xnSDxMaL",
        deepgramVoice: "aura-2-luna-en",
      });
      assert.strictEqual(info.defaultProvider, "elevenlabs");
      const [dgUrl] = upstream.mock.calls[0]!;
      assert.strictEqual(
        String(dgUrl),
        "https://api.deepgram.com/v1/speak?model=aura-2-luna-en&encoding=mp3",
      );
      const [elUrl, elInit] = upstream.mock.calls[1]!;
      assert.include(String(elUrl), "/text-to-speech/EXAVITQu4vr4xnSDxMaL?");
      assert.strictEqual(JSON.parse(String(elInit?.body)).model_id, "eleven_v3_conversational");
    }),
  );

  it.effect("server browser preference disables server TTS for auto requests", () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => mp3Response(new Uint8Array([1])));
      const error = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        yield* tts.saveCredentials({ elevenlabsApiKey: "xi-key" });
        yield* tts.saveTtsPreferences({ ttsProvider: "browser" });
        return yield* tts
          .speak({ text: "Hello." })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.flip);
      }).pipe(Effect.provide(makeTtsTestLayer("mattr-voice-el-browser-")));

      assert.strictEqual(error._tag, "VoiceTtsUnavailableError");
      assert.strictEqual(upstream.mock.calls.length, 0);
    }),
  );

  it.effect("merges ElevenLabs and Deepgram keys in one owner-only secrets file", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tts = yield* VoiceTtsService.VoiceTtsService;
      const secretsPath = path.join(config.stateDir, "mattr-voice-secrets.json");

      yield* tts.saveDeepgramApiKey("dg-key");
      const status = yield* tts.saveCredentials({ elevenlabsApiKey: "xi-key" });
      assert.strictEqual(status.deepgramConfigured, true);
      assert.strictEqual(status.deepgramAvailable, true);
      assert.strictEqual(status.elevenlabsConfigured, true);
      assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(secretsPath)), {
        deepgramApiKey: "dg-key",
        elevenlabsApiKey: "xi-key",
      });
      assert.strictEqual((yield* fs.stat(secretsPath)).mode & 0o777, 0o600);

      yield* tts.saveCredentials({ elevenlabsApiKey: "" });
      assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(secretsPath)), {
        deepgramApiKey: "dg-key",
      });
    }).pipe(Effect.provide(makeTtsTestLayer("mattr-voice-el-secrets-"))),
  );

  it.effect("keeps speech-to-text on Deepgram even when only ElevenLabs is configured", () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
      const error = yield* Effect.gen(function* () {
        const tts = yield* VoiceTtsService.VoiceTtsService;
        yield* tts.saveCredentials({ elevenlabsApiKey: "xi-key" });
        return yield* tts
          .transcribeDeepgram(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "en")
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.flip);
      }).pipe(Effect.provide(makeTtsTestLayer("mattr-voice-el-stt-")));

      if (!DEEPGRAM_ENV_KEY) {
        assert.strictEqual(error._tag, "VoiceTtsUnavailableError");
      }
      assert.isFalse(upstream.mock.calls.some(([url]) => String(url).includes("elevenlabs")));
    }),
  );
});

describe("voiceAssistantFluxWs", () => {
  it("parses Deepgram Flux Connected, TurnInfo, and Error events", () => {
    assert.deepStrictEqual(
      VoiceAssistantFluxWs.parseDeepgramFluxEvent(
        JSON.stringify({ type: "Connected", request_id: "req-flux-1", sequence_id: 0 }),
      ),
      { type: "Connected", request_id: "req-flux-1" },
    );

    assert.deepStrictEqual(
      VoiceAssistantFluxWs.parseDeepgramFluxEvent(
        JSON.stringify({
          type: "TurnInfo",
          event: "StartOfTurn",
          turn_index: 0,
          transcript: "",
        }),
      ),
      { type: "TurnInfo", event: "StartOfTurn", transcript: "", turn_index: 0 },
    );

    assert.deepStrictEqual(
      VoiceAssistantFluxWs.parseDeepgramFluxEvent(
        JSON.stringify({
          type: "TurnInfo",
          event: "Update",
          turn_index: 0,
          transcript: "open the auth",
        }),
      ),
      { type: "TurnInfo", event: "Update", transcript: "open the auth", turn_index: 0 },
    );

    assert.deepStrictEqual(
      VoiceAssistantFluxWs.parseDeepgramFluxEvent(
        JSON.stringify({
          type: "TurnInfo",
          event: "EndOfTurn",
          turn_index: 0,
          transcript: "open the auth thread",
          end_of_turn_confidence: 0.91,
        }),
      ),
      {
        type: "TurnInfo",
        event: "EndOfTurn",
        transcript: "open the auth thread",
        turn_index: 0,
        end_of_turn_confidence: 0.91,
      },
    );

    assert.deepStrictEqual(
      VoiceAssistantFluxWs.parseDeepgramFluxEvent(
        JSON.stringify({ type: "FatalError", description: "quota exceeded" }),
      ),
      { type: "Error", description: "quota exceeded" },
    );

    assert.strictEqual(VoiceAssistantFluxWs.parseDeepgramFluxEvent("not-json"), null);
    assert.strictEqual(
      VoiceAssistantFluxWs.parseDeepgramFluxEvent(
        JSON.stringify({ type: "TurnInfo", event: "UnknownEvent", transcript: "hi" }),
      ),
      null,
    );
  });

  const makeAuthLayers = (options: {
    readonly authorized: boolean;
    readonly scopes?: ReadonlyArray<
      typeof AuthOrchestrationOperateScope | typeof AuthOrchestrationReadScope
    >;
  }) =>
    Layer.mergeAll(
      Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
        authenticateWebSocketUpgrade: () =>
          options.authorized
            ? Effect.succeed({
                sessionId: AuthSessionId.make("sess-flux-test"),
                subject: "test-user",
                method: "bearer-access-token" as const,
                scopes: options.scopes ?? [AuthOrchestrationOperateScope],
              })
            : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      Layer.succeed(SessionStore.SessionStore, {
        awaitInvalidation: () => Effect.never,
      } as unknown as SessionStore.SessionStore["Service"]),
    );

  it.live("closes with 4401 deepgram_not_configured when no Deepgram API key is set", () =>
    Effect.gen(function* () {
      const route = VoiceAssistantFluxWs.makeVoiceAssistantFluxRoute({
        resolveDeepgramApiKey: () => Effect.succeed(null),
      });
      yield* Layer.build(HttpRouter.serve(route, { disableLogger: true, disableListenLog: true }));
      const server = yield* HttpServer.HttpServer;
      const address = server.address as NetAddress.InetAddress;
      const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
      const wsUrl = `ws://${host}:${address.port}${VoiceAssistantFluxWs.VOICE_ASSISTANT_FLUX_WS_PATH}`;

      const closed = yield* Effect.promise(
        () =>
          new Promise<{ readonly code: number; readonly reason: string }>((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            ws.addEventListener("close", (event) => {
              resolve({ code: event.code, reason: event.reason });
            });
            ws.addEventListener("error", () => {
              reject(new Error("Unexpected WebSocket error before close"));
            });
          }),
      );

      assert.strictEqual(closed.code, VoiceAssistantFluxWs.FLUX_NOT_CONFIGURED_CLOSE_CODE);
      assert.strictEqual(closed.reason, "deepgram_not_configured");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeHttpServer.layerTest, makeAuthLayers({ authorized: true }))),
    ),
  );

  it("rejects unauthenticated and read-only WebSocket upgrades before upgrading", async () => {
    const unauth = HttpRouter.toWebHandler(
      VoiceAssistantFluxWs.makeVoiceAssistantFluxRoute({
        resolveDeepgramApiKey: () => Effect.succeed("dg-test-key"),
      }).pipe(Layer.provideMerge(makeAuthLayers({ authorized: false }))),
    );
    try {
      const res401 = await unauth.handler(
        new Request(`http://localhost${VoiceAssistantFluxWs.VOICE_ASSISTANT_FLUX_WS_PATH}`, {
          headers: { upgrade: "websocket" },
        }),
      );
      assert.strictEqual(res401.status, 401);
    } finally {
      await unauth.dispose();
    }

    const readOnly = HttpRouter.toWebHandler(
      VoiceAssistantFluxWs.makeVoiceAssistantFluxRoute({
        resolveDeepgramApiKey: () => Effect.succeed("dg-test-key"),
      }).pipe(
        Layer.provideMerge(
          makeAuthLayers({
            authorized: true,
            scopes: [AuthOrchestrationReadScope],
          }),
        ),
      ),
    );
    try {
      const res403 = await readOnly.handler(
        new Request(`http://localhost${VoiceAssistantFluxWs.VOICE_ASSISTANT_FLUX_WS_PATH}`, {
          headers: { upgrade: "websocket" },
        }),
      );
      assert.strictEqual(res403.status, 403);
    } finally {
      await readOnly.dispose();
    }
  });

  it.live("proxies binary PCM to upstream Flux WS and forwards TurnInfo events back", () =>
    Effect.gen(function* () {
      let receivedAuthHeader: string | undefined;
      const receivedBinaryLengths: Array<number> = [];
      const upstreamClosed = Promise.withResolvers<void>();

      const mockUpstreamRoute = HttpRouter.add(
        "GET",
        "/v2/listen",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          receivedAuthHeader = request.headers.authorization;
          const socket = yield* request.upgrade;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const writer = yield* socket.writer;
              const { pull } = yield* socket.reader;
              yield* writer.write(JSON.stringify({ type: "Connected", request_id: "mock-dg-1" }));
              const frames = yield* pull;
              for (const frame of frames) {
                if (frame instanceof Uint8Array) {
                  receivedBinaryLengths.push(frame.byteLength);
                }
              }
              yield* writer.write(
                JSON.stringify({
                  type: "TurnInfo",
                  event: "StartOfTurn",
                  turn_index: 0,
                  transcript: "",
                }),
              );
              yield* writer.write(
                JSON.stringify({
                  type: "TurnInfo",
                  event: "Update",
                  turn_index: 0,
                  transcript: "check build",
                }),
              );
              yield* writer.write(
                JSON.stringify({
                  type: "TurnInfo",
                  event: "EndOfTurn",
                  turn_index: 0,
                  transcript: "check build status",
                  end_of_turn_confidence: 0.94,
                }),
              );
              // Wait until client disconnects so we verify cleanup.
              while (true) {
                yield* pull;
              }
            }),
          ).pipe(Effect.ensuring(Effect.sync(() => upstreamClosed.resolve())), Effect.ignoreCause);
          return HttpServerResponse.empty();
        }),
      );

      yield* Layer.build(
        HttpRouter.serve(mockUpstreamRoute, { disableLogger: true, disableListenLog: true }),
      );
      const upstreamServer = yield* HttpServer.HttpServer;
      const upstreamAddress = upstreamServer.address as NetAddress.InetAddress;
      const upstreamHost = upstreamAddress._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
      const upstreamUrl = `ws://${upstreamHost}:${upstreamAddress.port}/v2/listen`;

      const proxyRoute = VoiceAssistantFluxWs.makeVoiceAssistantFluxRoute(
        { resolveDeepgramApiKey: () => Effect.succeed("dg-secret-token") },
        { upstreamUrl },
      );
      const proxyContext = yield* Layer.build(
        HttpRouter.serve(proxyRoute, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(Layer.fresh(NodeHttpServer.layerTest)),
        ),
      );
      const proxyServer = Context.get(proxyContext, HttpServer.HttpServer);
      const proxyAddress = proxyServer.address as NetAddress.InetAddress;
      const proxyHost = proxyAddress._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
      const proxyUrl = `ws://${proxyHost}:${proxyAddress.port}${VoiceAssistantFluxWs.VOICE_ASSISTANT_FLUX_WS_PATH}`;

      const events = yield* Effect.promise(
        () =>
          new Promise<Array<VoiceAssistantFluxWs.DeepgramFluxEvent>>((resolve, reject) => {
            const received: Array<VoiceAssistantFluxWs.DeepgramFluxEvent> = [];
            const ws = new WebSocket(proxyUrl);
            ws.addEventListener("open", () => {
              ws.send(new Uint8Array(2560));
            });
            ws.addEventListener("message", (event) => {
              const parsed = VoiceAssistantFluxWs.parseDeepgramFluxEvent(String(event.data));
              if (parsed) received.push(parsed);
              if (parsed?.type === "TurnInfo" && parsed.event === "EndOfTurn") {
                ws.close(1000);
                resolve(received);
              }
            });
            ws.addEventListener("error", () => {
              reject(new Error("Proxy WebSocket error"));
            });
          }),
      );

      yield* Effect.promise(() => upstreamClosed.promise);

      assert.strictEqual(receivedAuthHeader, "Token dg-secret-token");
      assert.deepStrictEqual(receivedBinaryLengths, [2560]);
      assert.deepStrictEqual(events, [
        { type: "Connected", request_id: "mock-dg-1" },
        { type: "TurnInfo", event: "StartOfTurn", transcript: "", turn_index: 0 },
        { type: "TurnInfo", event: "Update", transcript: "check build", turn_index: 0 },
        {
          type: "TurnInfo",
          event: "EndOfTurn",
          transcript: "check build status",
          turn_index: 0,
          end_of_turn_confidence: 0.94,
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeHttpServer.layerTest, makeAuthLayers({ authorized: true }))),
    ),
  );
});
