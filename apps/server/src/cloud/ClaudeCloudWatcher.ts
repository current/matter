import {
  CLAUDE_CLOUD_ADDON_ID,
  type ClaudeCloudRemoteSession,
  type ClaudeCloudSessionState,
  CommandId,
  MessageId,
  type TrackedClaudeCloudSession,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as AddonConfigService from "../bots/AddonConfigService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ClaudeCloudService from "./ClaudeCloudService.ts";
import * as ClaudeCloudSessionsApi from "./ClaudeCloudSessionsApi.ts";

const POLL_INTERVAL = Duration.seconds(60);
// Older runs are left alone; their chat has long moved on.
const WATCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
// The API can report a just-launched session idle before its first turn starts.
const STARTUP_GRACE_MS = 3 * 60 * 1000;

const SETTLED: ReadonlySet<ClaudeCloudSessionState | null | undefined> = new Set([
  "idle",
  "failed",
  "archived",
]);

/** Sessions an agent or user started from a chat, not brought back, whose end isn't reported yet. */
const watchedSessions = (
  sessions: ReadonlyArray<TrackedClaudeCloudSession>,
  now: number,
): ReadonlyArray<TrackedClaudeCloudSession> =>
  sessions.filter(
    (session) =>
      session.sourceThreadId !== null &&
      session.teleportedThreadId === null &&
      !SETTLED.has(session.reportedState) &&
      now - Date.parse(session.lastMessageAt ?? session.createdAt) < WATCH_WINDOW_MS,
  );

export type ClaudeCloudReport =
  | { readonly kind: "none" }
  | { readonly kind: "record"; readonly state: ClaudeCloudSessionState | null }
  | { readonly kind: "send"; readonly state: ClaudeCloudSessionState; readonly text: string };

const quote = (title: string) => `"${title.replaceAll('"', "'")}"`;

const finishedText = (remote: ClaudeCloudRemoteSession) => {
  const lines = [`[Claude Cloud] ${quote(remote.title)} finished.`];
  if (remote.summary !== null) lines.push(remote.summary);
  lines.push(
    "",
    remote.branch === null
      ? `Its work is in the cloud session; check where it pushed: ${remote.url}`
      : `Its work is on branch \`${remote.branch}\`. Bring it in: \`git fetch origin ${remote.branch}\`, review the diff, then merge it into this checkout (or review its pull request if it opened one). Session: ${remote.url}`,
    "Don't redo this work locally.",
  );
  return lines.join("\n");
};

const needsInputText = (remote: ClaudeCloudRemoteSession) =>
  [
    `[Claude Cloud] ${quote(remote.title)} is waiting for input: ${remote.needsAction ?? remote.summary ?? "it asked a question"}.`,
    `If you know the answer, send it with claude_cloud_send (sessionId ${remote.id}); otherwise ask the user. Permission prompts can only be answered on claude.ai: ${remote.url}`,
  ].join("\n");

const failedText = (remote: ClaudeCloudRemoteSession) =>
  [
    `[Claude Cloud] ${quote(remote.title)} stopped with an error${remote.summary === null ? "." : `: ${remote.summary}`}`,
    `Decide whether to retry it here or in a new cloud session. Session: ${remote.url}`,
  ].join("\n");

/** What to tell the source thread about a session's latest state, if anything. */
const claudeCloudReport = (input: {
  readonly session: TrackedClaudeCloudSession;
  readonly remote: ClaudeCloudRemoteSession;
  readonly seenRunning: boolean;
  readonly now: number;
}): ClaudeCloudReport => {
  const { session, remote } = input;
  const reported = session.reportedState ?? null;
  switch (remote.state) {
    case "running":
      // Answered input runs again; its next stop is news.
      return reported === null ? { kind: "none" } : { kind: "record", state: null };
    case "archived":
      return { kind: "record", state: "archived" };
    case "idle":
    case "needs_input":
    case "failed": {
      if (remote.state === reported) return { kind: "none" };
      const age = input.now - Date.parse(session.lastMessageAt ?? session.createdAt);
      if (remote.state === "idle" && !input.seenRunning && age < STARTUP_GRACE_MS) {
        return { kind: "none" };
      }
      const text =
        remote.state === "idle"
          ? finishedText(remote)
          : remote.state === "needs_input"
            ? needsInputText(remote)
            : failedText(remote);
      return { kind: "send", state: remote.state, text };
    }
  }
};

/**
 * Tells the chat that started a cloud session when it finishes, needs input or fails, through the
 * same thread send scheduled tasks use, so the agent never polls. Reads stay GET-only.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const addons = yield* AddonConfigService.AddonConfigService;
    const cloud = yield* ClaudeCloudService.ClaudeCloudService;
    const sessionsApi = yield* ClaudeCloudSessionsApi.ClaudeCloudSessionsApi;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const seenRunning = new Set<string>();

    const report = Effect.fn("ClaudeCloudWatcher.report")(function* (
      session: TrackedClaudeCloudSession,
    ) {
      const remote = yield* sessionsApi.getSession({
        sessionId: session.id,
        instanceId: session.instanceId,
      });
      if (remote.state === "running") seenRunning.add(session.id);
      const decision = claudeCloudReport({
        session,
        remote,
        seenRunning: seenRunning.has(session.id),
        now: yield* Clock.currentTimeMillis,
      });
      if (decision.kind === "none") return;
      if (decision.kind === "send" && session.sourceThreadId !== null) {
        const shell = yield* threads
          .getThreadShell(session.sourceThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell !== null) {
          const key = `${session.id}:${decision.state}:${remote.updatedAt}`;
          yield* threads.sendToThread({
            projectId: shell.projectId,
            commandId: CommandId.make(`claude-cloud-report:${key}`),
            threadId: shell.id,
            messageId: MessageId.make(`claude-cloud-report:${key}`),
            text: decision.text,
            attachments: [],
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          });
        }
      }
      yield* cloud.recordReportedState(session.id, decision.state);
      seenRunning.delete(session.id);
    });

    const tick = Effect.gen(function* () {
      if (!(yield* addons.isEnabled(CLAUDE_CLOUD_ADDON_ID))) return;
      const watched = watchedSessions(yield* cloud.listSessions(), yield* Clock.currentTimeMillis);
      yield* Effect.forEach(
        watched,
        (session) =>
          report(session).pipe(
            Effect.catch((error) =>
              Effect.logDebug("Claude Cloud watcher skipped a session.", {
                sessionId: session.id,
                error: String(error),
              }),
            ),
          ),
        { discard: true },
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Claude Cloud watcher tick failed.", { error: String(error) }),
      ),
    );

    yield* tick.pipe(
      Effect.delay(POLL_INTERVAL),
      Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
