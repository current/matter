import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { VoiceWorkspaceContext } from "../../../../matter/voice-assistant/types.ts";
import type { ActiveThreadListEntry } from "../orchestration-v2/ProjectionStore.ts";
import {
  hydrateVoiceWorkspaceContext,
  type VoiceHydratorProjectService,
  type VoiceHydratorThreadManagement,
} from "./voiceWorkspaceHydrator.ts";

const LOCAL_ENV = EnvironmentId.make("env-local");
const REMOTE_ENV = EnvironmentId.make("env-remote-vps");
const BASE_NOW_MS = 1_760_000_000_000;

function makeProject(overrides: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot?: string;
  readonly archived?: boolean;
}): Project {
  const now = DateTime.nowUnsafe();
  return {
    id: ProjectId.make(overrides.id),
    title: overrides.title,
    workspaceRoot: overrides.workspaceRoot ?? `/tmp/${overrides.id}`,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    projectIcon: null,
    scripts: [],
    trackedFolders: [],
    pinnedAt: null,
    archivedAt: overrides.archived ? now : null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  } as unknown as Project;
}

function makeShell(overrides: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status?: OrchestrationV2ThreadShell["status"];
  readonly updatedAtMs?: number;
  readonly parentThreadId?: string | null;
  readonly relationshipToParent?: "subagent" | "fork" | null;
  readonly rootThreadId?: string;
  readonly pendingRuntimeRequest?: OrchestrationV2ThreadShell["pendingRuntimeRequest"];
  readonly latestVisibleMessage?: OrchestrationV2ThreadShell["latestVisibleMessage"];
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly branch?: string | null;
}): OrchestrationV2ThreadShell {
  const updatedAt = DateTime.makeUnsafe(overrides.updatedAtMs ?? BASE_NOW_MS);
  const id = ThreadId.make(overrides.id);
  const parentId = overrides.parentThreadId ? ThreadId.make(overrides.parentThreadId) : null;
  const rootId = overrides.rootThreadId ? ThreadId.make(overrides.rootThreadId) : (parentId ?? id);
  const providerInstanceId = ProviderInstanceId.make(overrides.providerInstanceId ?? "claudeAgent");
  return {
    id,
    projectId: ProjectId.make(overrides.projectId),
    title: overrides.title,
    providerInstanceId,
    modelSelection: {
      instanceId: providerInstanceId,
      model: overrides.model ?? "claude-sonnet-4-6",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: overrides.branch ?? "main",
    worktreePath: null,
    lineage: {
      parentThreadId: parentId,
      relationshipToParent: overrides.relationshipToParent ?? null,
      rootThreadId: rootId,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: overrides.status ?? "idle",
    pendingRuntimeRequest: overrides.pendingRuntimeRequest ?? null,
    latestVisibleMessage: overrides.latestVisibleMessage ?? null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    createdBy: "user",
    creationSource: "ui",
  } as unknown as OrchestrationV2ThreadShell;
}

function toListEntry(shell: OrchestrationV2ThreadShell): ActiveThreadListEntry {
  return {
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    lineage: shell.lineage,
    delegatedFrom: undefined,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    snoozedUntil: undefined,
    updatedAt: shell.updatedAt,
  };
}

function emptyContext(overrides: Partial<VoiceWorkspaceContext> = {}): VoiceWorkspaceContext {
  return {
    activeEnvironmentId: LOCAL_ENV,
    activeThreadId: null,
    activeRoute: "/",
    mainWindowFocused: true,
    composerFocused: false,
    projects: [],
    threads: [],
    pendingApprovals: [],
    pendingQuestions: [],
    ...overrides,
  };
}

describe("voiceWorkspaceHydrator", () => {
  it.effect(
    "surfaces parent/main threads and child subagent hierarchy even when client sent only subagents or empty context",
    () =>
      Effect.gen(function* () {
        const now = BASE_NOW_MS;
        const project = makeProject({ id: "proj-matter", title: "Matter" });
        const archivedProject = makeProject({
          id: "proj-old",
          title: "Archived Repo",
          archived: true,
        });

        const parentShell = makeShell({
          id: "thread-main",
          projectId: "proj-matter",
          title: "Matter setup check",
          status: "running",
          updatedAtMs: now - 5_000,
          branch: "feat/voice-brain",
          latestVisibleMessage: {
            id: MessageId.make("m-parent"),
            role: "user",
            text: "Check Claude Cloud and Devin Bot setup",
            updatedAt: DateTime.makeUnsafe(now - 5_000),
          },
        });
        const childA = makeShell({
          id: "thread-child-a",
          projectId: "proj-matter",
          title: "Claude Cloud",
          status: "running",
          updatedAtMs: now - 1_000,
          parentThreadId: "thread-main",
          relationshipToParent: "subagent",
          model: "claude-opus-4-6",
        });
        const childB = makeShell({
          id: "thread-child-b",
          projectId: "proj-matter",
          title: "Devin Bot",
          status: "waiting",
          updatedAtMs: now - 2_000,
          parentThreadId: "thread-main",
          relationshipToParent: "subagent",
          providerInstanceId: "codex",
          model: "gpt-5.3-codex",
        });

        const shells = [parentShell, childA, childB];
        const shellById = new Map(shells.map((s) => [s.id, s]));

        const projectService: VoiceHydratorProjectService = {
          listPage: () =>
            Effect.succeed({ projects: [project, archivedProject], nextCursor: null }),
        };
        const threadManagement: VoiceHydratorThreadManagement = {
          listProjectThreads: () => Effect.succeed(shells.map(toListEntry)),
          listActiveShellIndex: () =>
            Effect.succeed(
              shells.map((s) => ({
                id: s.id,
                projectId: s.projectId,
                lineage: s.lineage,
                settledOverride: null,
                settledAt: null,
                pinnedAt: null,
                pinOrderKey: null,
                snoozedUntil: null,
                mayBeLive: true,
                hasRemoteTasks: false,
              })),
            ),
          getShellSnapshot: (opts) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: (opts?.threadIds ?? []).flatMap((id) => {
                const found = shellById.get(id);
                return found ? [found] : [];
              }),
              archivedThreads: [],
            }),
          getThreadRecords: () =>
            Effect.succeed({
              messages: [],
              runtimeRequests: [],
              turnItems: [],
            } as never),
        };

        // Client (e.g. iPhone) sent empty context with zero threads and zero projects.
        const hydrated = yield* hydrateVoiceWorkspaceContext({
          reqContext: emptyContext(),
          localEnvironmentId: LOCAL_ENV,
          projectService,
          threadManagement,
        });

        // Non-archived projects only
        assert.deepStrictEqual(
          hydrated.projects.map((p) => p.id),
          ["proj-matter"],
        );

        const main = hydrated.threads.find((t) => t.threadId === "thread-main");
        const subA = hydrated.threads.find((t) => t.threadId === "thread-child-a");
        const subB = hydrated.threads.find((t) => t.threadId === "thread-child-b");

        assert.isDefined(main);
        assert.strictEqual(main?.parentThreadId, null);
        assert.strictEqual(main?.relationshipToParent, null);
        assert.strictEqual(main?.activeChildCount, 2);
        assert.deepStrictEqual(main?.childTitles, ["Claude Cloud", "Devin Bot"]);
        assert.strictEqual(main?.branch, "feat/voice-brain");

        assert.isDefined(subA);
        assert.strictEqual(subA?.parentThreadId, "thread-main");
        assert.strictEqual(subA?.parentThreadTitle, "Matter setup check");
        assert.strictEqual(subA?.relationshipToParent, "subagent");
        assert.strictEqual(subA?.model, "claude-opus-4-6");

        assert.isDefined(subB);
        assert.strictEqual(subB?.parentThreadId, "thread-main");
        assert.strictEqual(subB?.parentThreadTitle, "Matter setup check");
        assert.strictEqual(subB?.relationshipToParent, "subagent");
        assert.strictEqual(subB?.providerInstanceId, "codex");
      }),
  );

  it.effect(
    "surfaces live pending user-input questions (with options & descriptions) and pending approvals even when client sent none, and merges remote entries",
    () =>
      Effect.gen(function* () {
        const now = BASE_NOW_MS;
        const project = makeProject({ id: "proj-1", title: "Matter" });

        const questionShell = makeShell({
          id: "thread-q",
          projectId: "proj-1",
          title: "Voice Mode Overhaul",
          status: "waiting",
          updatedAtMs: now - 1_000,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("req-q-1"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(now - 500),
          },
        });
        const approvalShell = makeShell({
          id: "thread-a",
          projectId: "proj-1",
          title: "Deploy Script",
          status: "waiting",
          updatedAtMs: now - 2_000,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("req-a-1"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(now - 1_000),
          },
        });
        const brokenShell = makeShell({
          id: "thread-broken",
          projectId: "proj-1",
          title: "Flaky Thread",
          status: "waiting",
          updatedAtMs: now - 3_000,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("req-broken"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(now - 1_500),
          },
        });

        const shells = [questionShell, approvalShell, brokenShell];
        const shellById = new Map(shells.map((s) => [s.id, s]));

        const questionRequest: OrchestrationV2RuntimeRequest = {
          id: RuntimeRequestId.make("req-q-1"),
          nodeId: NodeId.make("node-1"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.makeUnsafe(now - 500),
          resolvedAt: null,
        };
        const questionItem: OrchestrationV2TurnItem = {
          id: TurnItemId.make("item-q-1"),
          threadId: ThreadId.make("thread-q"),
          runId: null,
          nodeId: NodeId.make("node-1"),
          providerTurnId: null,
          type: "user_input_request",
          status: "waiting",
          requestId: RuntimeRequestId.make("req-q-1"),
          questions: [
            {
              id: "tts_mode",
              header: "TTS Format",
              question: "Which audio bitrate should ElevenLabs use on 5G?",
              multiSelect: false,
              options: [
                {
                  label: "64kbps streaming (Recommended)",
                  description: "Fastest start on cellular with crisp voice quality",
                },
                {
                  label: "128kbps standard",
                  description: "Higher bitrate but slower over cell",
                },
              ],
            },
          ],
          createdAt: DateTime.makeUnsafe(now - 500),
          updatedAt: DateTime.makeUnsafe(now - 500),
        } as unknown as OrchestrationV2TurnItem;

        const approvalRequest: OrchestrationV2RuntimeRequest = {
          id: RuntimeRequestId.make("req-a-1"),
          nodeId: NodeId.make("node-2"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.makeUnsafe(now - 1_000),
          resolvedAt: null,
        };
        const approvalItem: OrchestrationV2TurnItem = {
          id: TurnItemId.make("item-a-1"),
          threadId: ThreadId.make("thread-a"),
          runId: null,
          nodeId: NodeId.make("node-2"),
          providerTurnId: null,
          type: "approval_request",
          status: "waiting",
          requestId: RuntimeRequestId.make("req-a-1"),
          requestKind: "command",
          prompt: "pnpm run deploy:staging",
          reason: "Push build to staging cluster",
          createdAt: DateTime.makeUnsafe(now - 1_000),
          updatedAt: DateTime.makeUnsafe(now - 1_000),
        } as unknown as OrchestrationV2TurnItem;

        const qMessages: ReadonlyArray<OrchestrationV2ConversationMessage> = [
          { id: MessageId.make("m1"), role: "user", text: "Upgrade ElevenLabs TTS" } as never,
          {
            id: MessageId.make("m2"),
            role: "assistant",
            text: "Ready to switch — waiting on your bitrate choice.",
          } as never,
        ];

        const threadManagement: VoiceHydratorThreadManagement = {
          listProjectThreads: () => Effect.succeed(shells.map(toListEntry)),
          getShellSnapshot: (opts) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: (opts?.threadIds ?? []).flatMap((id) => {
                const found = shellById.get(id);
                return found ? [found] : [];
              }),
              archivedThreads: [],
            }),
          getThreadRecords: (threadId) => {
            if (threadId === "thread-q") {
              return Effect.succeed({
                runtimeRequests: [questionRequest],
                turnItems: [questionItem],
                messages: qMessages,
              } as never);
            }
            if (threadId === "thread-a") {
              return Effect.succeed({
                runtimeRequests: [approvalRequest],
                turnItems: [approvalItem],
                messages: [],
              } as never);
            }
            return Effect.fail(new Error("Simulated SQLite read failure") as never);
          },
        };

        const hydrated = yield* hydrateVoiceWorkspaceContext({
          reqContext: emptyContext({
            // Remote question should be preserved & merged; stale local question for thread-a dropped.
            pendingQuestions: [
              {
                environmentId: REMOTE_ENV,
                threadId: "remote-thread-1",
                threadTitle: "VPS Migration",
                requestId: "remote-req-9",
                questions: [
                  {
                    id: "confirm",
                    header: "Confirm",
                    question: "Restart nginx?",
                    options: ["Yes", "No"],
                  },
                ],
              },
            ],
            pendingApprovals: [
              {
                environmentId: LOCAL_ENV,
                threadId: "thread-q",
                threadTitle: "Voice Mode Overhaul",
                requestId: "stale-local-approval",
                requestKind: "command",
                title: "Stale already-answered approval",
                detail: null,
                reason: null,
              },
            ],
          }),
          localEnvironmentId: LOCAL_ENV,
          projectService: {
            listPage: () => Effect.succeed({ projects: [project], nextCursor: null }),
          },
          threadManagement,
        });

        // Local question hydrated from server + remote question preserved
        assert.strictEqual(hydrated.pendingQuestions.length, 2);
        const localQ = hydrated.pendingQuestions.find((q) => q.requestId === "req-q-1");
        assert.isDefined(localQ);
        assert.strictEqual(localQ?.threadTitle, "Voice Mode Overhaul");
        assert.strictEqual(localQ?.questions[0]?.id, "tts_mode");
        assert.deepStrictEqual(localQ?.questions[0]?.options, [
          "64kbps streaming (Recommended)",
          "128kbps standard",
        ]);
        assert.strictEqual(
          localQ?.questions[0]?.optionDetails?.[0]?.description,
          "Fastest start on cellular with crisp voice quality",
        );
        assert.isDefined(hydrated.pendingQuestions.find((q) => q.requestId === "remote-req-9"));

        // Local approval hydrated from server, stale local client approval dropped
        assert.strictEqual(hydrated.pendingApprovals.length, 1);
        assert.strictEqual(hydrated.pendingApprovals[0]?.requestId, "req-a-1");
        assert.strictEqual(hydrated.pendingApprovals[0]?.detail, "pnpm run deploy:staging");
        assert.strictEqual(hydrated.pendingApprovals[0]?.reason, "Push build to staging cluster");

        // Snippets populated on hydrated question thread
        const qThread = hydrated.threads.find((t) => t.threadId === "thread-q");
        assert.strictEqual(qThread?.status, "input");
        assert.strictEqual(qThread?.latestUserMessage, "Upgrade ElevenLabs TTS");
        assert.include(qThread?.latestAssistantMessage ?? "", "waiting on your bitrate choice");
      }),
  );

  it.effect("guarantees parent threads are never orphaned even with >40 threads", () =>
    Effect.gen(function* () {
      const now = BASE_NOW_MS;
      const project = makeProject({ id: "proj-1", title: "Matter" });

      // Old parent thread + 45 newer unrelated top-level threads + 1 live subagent of the old parent
      const oldParent = makeShell({
        id: "thread-old-parent",
        projectId: "proj-1",
        title: "Original Parent Thread",
        status: "idle",
        updatedAtMs: now - 10_000_000,
      });
      const liveChild = makeShell({
        id: "thread-live-child",
        projectId: "proj-1",
        title: "Active Subagent",
        status: "running",
        updatedAtMs: now - 100,
        parentThreadId: "thread-old-parent",
        relationshipToParent: "subagent",
      });
      const recentThreads = Array.from({ length: 45 }, (_, idx) =>
        makeShell({
          id: `thread-recent-${idx}`,
          projectId: "proj-1",
          title: `Recent Thread ${idx}`,
          status: "completed",
          updatedAtMs: now - 1_000 * (idx + 1),
        }),
      );

      const shells = [oldParent, liveChild, ...recentThreads];
      const shellById = new Map(shells.map((s) => [s.id, s]));

      const hydrated = yield* hydrateVoiceWorkspaceContext({
        reqContext: emptyContext(),
        localEnvironmentId: LOCAL_ENV,
        projectService: {
          listPage: () => Effect.succeed({ projects: [project], nextCursor: null }),
        },
        threadManagement: {
          listProjectThreads: () => Effect.succeed(shells.map(toListEntry)),
          getShellSnapshot: (opts) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: (opts?.threadIds ?? []).flatMap((id) => {
                const found = shellById.get(id);
                return found ? [found] : [];
              }),
              archivedThreads: [],
            }),
        },
      });

      assert.strictEqual(hydrated.threads.length, 40);
      assert.isTrue(hydrated.threads.some((t) => t.threadId === "thread-live-child"));
      assert.isTrue(hydrated.threads.some((t) => t.threadId === "thread-old-parent"));
      const childSummary = hydrated.threads.find((t) => t.threadId === "thread-live-child");
      assert.strictEqual(childSummary?.parentThreadTitle, "Original Parent Thread");
    }),
  );
});
