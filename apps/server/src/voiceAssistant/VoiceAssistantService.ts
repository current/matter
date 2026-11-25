import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderRequestKind,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type RuntimeMode,
  type ServerSettings as ServerSettingsContract,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type {
  VoiceAssistantClientAction,
  VoiceAssistantToolResult,
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceBriefingRequest,
  VoiceBriefingResponse,
  VoiceWorkspaceApprovalSummary,
  VoiceWorkspaceProjectSummary,
  VoiceWorkspaceQuestionSummary,
  VoiceWorkspaceThreadSummary,
} from "../../../../antimatter/voice-assistant/types.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { createJsonStringFieldReader } from "./voiceSentenceChunker.ts";
import { sanitizeSpeechText } from "./VoiceTtsService.ts";
import { hydrateVoiceWorkspaceContext } from "./voiceWorkspaceHydrator.ts";
import {
  readSafeProjectFile,
  searchWorkspace,
  type SafeProjectFileResult,
  type WorkspaceSearchResult,
} from "./voiceWorkspaceSearch.ts";

const DIRECT_TURN_TIMEOUT_MS = 15_000;
const FALLBACK_TURN_TIMEOUT_MS = 25_000;
const BRIEFING_LLM_TIMEOUT_MS = 4_000;
const ANTHROPIC_API_VERSION = "2023-06-01";
const OPENROUTER_PRIMARY_MODEL = "google/gemini-2.5-flash";
const OPENROUTER_FALLBACK_MODEL = "openai/gpt-4.1-mini";
const isApprovalRequestKind = Schema.is(ProviderRequestKind);

export type VoicePlannedAction =
  | {
      readonly type: "create_project";
      readonly title: string;
      readonly workspaceRoot?: string | undefined;
    }
  | {
      readonly type: "launch_thread";
      readonly projectId?: string | undefined;
      readonly projectName?: string | undefined;
      readonly prompt?: string | undefined;
      readonly title?: string | undefined;
      readonly useWorktree?: boolean | undefined;
    }
  | {
      readonly type: "send_to_thread";
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
      readonly text: string;
      readonly dispatchMode?: "auto" | "steer" | "queue" | undefined;
    }
  | {
      readonly type: "read_thread";
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
    }
  | {
      readonly type: "interrupt_thread";
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
    }
  | {
      readonly type: "organize_thread";
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
      readonly operation:
        | "settle"
        | "unsettle"
        | "archive"
        | "unarchive"
        | "pin"
        | "unpin"
        | "snooze";
      readonly snoozeMinutes?: number | undefined;
    }
  | {
      readonly type: "respond_approval";
      readonly environmentId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
      readonly requestId?: string | undefined;
      readonly decision: "accept" | "acceptAlways" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      readonly type: "respond_question";
      readonly environmentId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
      readonly requestId?: string | undefined;
      readonly answers: Record<string, string | ReadonlyArray<string>>;
    }
  | {
      readonly type: "dismiss_question";
      readonly environmentId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
      readonly requestId?: string | undefined;
    }
  | {
      readonly type: "search_workspace";
      readonly query: string;
      readonly projectName?: string | undefined;
      readonly depth?: "quick" | "deep" | undefined;
    }
  | {
      readonly type: "read_project_file";
      readonly projectName?: string | undefined;
      readonly relativePath: string;
      readonly maxChars?: number | undefined;
    }
  | {
      readonly type: "navigate_thread";
      readonly environmentId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly threadTitle?: string | undefined;
    }
  | {
      readonly type: "navigate_route";
      readonly to: string;
    }
  | {
      readonly type: "insert_dictation";
      readonly text: string;
      readonly autoSend?: boolean | undefined;
    }
  | {
      readonly type: "focus_window";
    };

export interface VoiceAssistantPlan {
  readonly route: VoiceAssistantTurnResponse["route"];
  readonly actions: ReadonlyArray<VoicePlannedAction>;
  readonly spokenReply: string;
  readonly displayReply: string;
  readonly expectFollowUp: boolean;
}

class VoiceAssistantLlmError extends Schema.TaggedError<VoiceAssistantLlmError>()(
  "VoiceAssistantLlmError",
  {
    stage: Schema.Literals(["direct-http", "text-generation"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isVoiceAssistantLlmError = Schema.is(VoiceAssistantLlmError);

/** Streaming callbacks for `streamTurn`; each runs in order on the turn's fiber. */
export interface VoiceTurnStreamHooks {
  /** Spoken reply text as the model writes it, only when no tool round can change it. */
  readonly onSpokenDelta: (text: string) => Effect.Effect<void>;
  /**
   * Tool results and client actions, once every planned action has run and before the final
   * answer streams, so a client that cuts the reply short still applies them.
   */
  readonly onToolResults: (
    results: ReadonlyArray<VoiceAssistantToolResult>,
    actions: ReadonlyArray<VoiceAssistantClientAction>,
  ) => Effect.Effect<void>;
}

const PLAN_ACTIONS_EMPTY = /"actions"\s*:\s*\[\s*\]/;
const PLAN_ROUTE_DICTATION = /"route"\s*:\s*"dictation"/;

const readEnvOpenAiKey = Config.String("OPENAI_API_KEY").pipe(
  Config.withDefault(""),
  Effect.map((value) => value.trim()),
  Effect.orElseSucceed(() => ""),
);

export class VoiceAssistantService extends Context.Service<
  VoiceAssistantService,
  {
    readonly handleTurn: (
      req: VoiceAssistantTurnRequest,
    ) => Effect.Effect<VoiceAssistantTurnResponse>;
    /**
     * `handleTurn` with the spoken reply streamed through `hooks` as the model writes it. The
     * resolved response is the same one `handleTurn` returns.
     */
    readonly streamTurn: (
      req: VoiceAssistantTurnRequest,
      hooks: VoiceTurnStreamHooks,
    ) => Effect.Effect<VoiceAssistantTurnResponse>;
    readonly generateBriefing: (req: VoiceBriefingRequest) => Effect.Effect<VoiceBriefingResponse>;
  }
>()("t3/voiceAssistant/VoiceAssistantService") {}

const VOICE_ASSISTANT_SYSTEM_PROMPT = `You are mattr, a warm, sharp conversational voice engineering co-pilot built directly into the user's coding agent workspace.

Your replies are SPOKEN ALOUD through natural neural TTS (often while the user is driving, walking, or talking hands-free on desktop or phone).

CRITICAL VOICE RULES:
- spokenReply MUST sound like a real human engineer riding shotgun: warm, natural, crisp spoken English with contractions ("I'm", "it's", "you've") and smooth transitions.
- Keep spokenReply to 1 to 3 short sentences by default, or up to 4 to 6 natural spoken sentences when the user explicitly asks you to dig deeper, explain more thoroughly, or walk through how something works. Zero markdown, zero backticks, zero bullet lists, zero URLs, zero raw file paths or UUIDs read out loud.
- NEVER say "User is asking...", "The user wants...", or narrate your internal reasoning or thoughts. Always talk directly to the user in natural second person ("you", "your").
- Never sound robotic: never say "As an AI", "I have executed the tool", "Action completed successfully", or narrate JSON/tool names. Speak naturally about what you did or found.
- Voice transcripts frequently mishear workspace terms: threat/threats = thread/threads, matter/madre = mattr, devon = Devin, grock = Grok, sub-agents = delegated child threads. Always interpret naturally in workspace context.
- When summarizing running threads, group delegated subagents under their parent/main thread (e.g., "Your main thread Antimatter setup check has two subagents running right now: Claude Cloud and Devin Bot."). Never claim you cannot access the main chat: you have authoritative server-side workspace state in context.
- When the user asks if any threads are waiting on input or approvals, check pendingQuestions and pendingApprovals, name the thread, briefly explain what it's asking, and read the concrete numbered options clearly so they can choose by number or name (set expectFollowUp: true). When they answer with a choice (like "option 1", "the second one", "approve it", or a custom answer), immediately emit respond_question / respond_approval / dismiss_question with the exact threadId, requestId, and answers!
- When the user asks how something works in their codebase, docs, or past threads (even with no thread open), or asks to "dig deeper" / "explain more thoroughly", emit search_workspace (with depth: "quick" for normal questions or depth: "deep" for thorough explanations) and/or read_project_file or read_thread so you answer from real source files and thread history instead of guessing.
- In mode="voice-mode", be genuinely conversational and proactive like a trusted co-pilot.
- Conversational greetings, casual banter, brainstorming, open-ended engineering questions, and quick status check-ins that are already answered by the hydrated workspace context work in ONE single fast turn with actions: [] and route: "assistant".
- displayReply is a concise 1 to 2 line plain-text summary for the UI card (also zero markdown).
- Set expectFollowUp to true when you ask a question, read options waiting for a choice, offer a next step, need clarification, or expect a natural back-and-forth; false when the user is clearly wrapping up or a one-shot action is complete.

ROUTING MODES:
- mode="voice-mode" or mode="assistant": treat every utterance as a live conversation or workspace command for mattr.
- mode="smart": if context.composerFocused is true AND the utterance sounds like prompt text to type into the active thread (not a command to mattr, not asking about workspace status, not answering an approval/question, not navigating), choose route="dictation" with action { "type": "insert_dictation", "text": "<cleaned text>", "autoSend": false } and empty spokenReply "". Otherwise handle as assistant/approval/question/direct-reply.
- If there are pending approvals and the user says approve / yes / allow / always allow / deny / reject / cancel, use route="approval" with respond_approval.
- If there are pending questions and the user answers one, use route="question" with respond_question (or dismiss_question if they say dismiss/skip/cancel the question).
- If the user asks to tell or reply to a specific thread (or the active thread), use route="direct-reply" with send_to_thread.

AVAILABLE ACTIONS (return an array in "actions"):
1. { "type": "create_project", "title": "Project Name", "workspaceRoot": "/optional/path" }
   - Omit workspaceRoot to create a brand-new managed git project from title.
2. { "type": "launch_thread", "projectId": "optional-id", "projectName": "optional-name", "prompt": "task prompt", "title": "optional short title", "useWorktree": true }
   - If you emit create_project followed by one or more launch_thread actions in the same turn, set projectName to the new project's title (or omit projectId) and mattr automatically links the newly created projectId!
3. { "type": "send_to_thread", "threadId": "optional-id", "threadTitle": "optional-title", "text": "message to send", "dispatchMode": "auto" | "steer" | "queue" }
4. { "type": "read_thread", "threadId": "optional-id", "threadTitle": "optional-title" }
   - Fetches recent messages, pending questions/approvals, and child subagent summaries of that thread, then asks you to synthesize a reply.
5. { "type": "search_workspace", "query": "search terms", "projectName": "optional-project", "depth": "quick" | "deep" }
   - Searches across workspace threads (titles + messages) AND registered project files/docs/code. Use depth="deep" when asked to dig deeper or give a thorough explanation.
6. { "type": "read_project_file", "projectName": "optional-project", "relativePath": "path/from/project/root", "maxChars": 4000 }
   - Reads a bounded excerpt of a specific file inside a registered project root.
7. { "type": "interrupt_thread", "threadId": "optional-id", "threadTitle": "optional-title" }
8. { "type": "organize_thread", "threadId": "optional-id", "threadTitle": "optional-title", "operation": "settle" | "unsettle" | "archive" | "unarchive" | "pin" | "unpin" | "snooze", "snoozeMinutes": 60 }
9. { "type": "respond_approval", "environmentId": "optional", "threadId": "...", "threadTitle": "optional", "requestId": "...", "decision": "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel" }
10. { "type": "respond_question", "environmentId": "optional", "threadId": "...", "threadTitle": "optional", "requestId": "...", "answers": { "<questionId>": "<exact option label or answer>" } }
11. { "type": "dismiss_question", "environmentId": "optional", "threadId": "...", "threadTitle": "optional", "requestId": "..." }
12. { "type": "navigate_thread", "environmentId": "optional", "threadId": "...", "threadTitle": "optional" }
13. { "type": "navigate_route", "to": "/settings" }
14. { "type": "insert_dictation", "text": "...", "autoSend": false }
15. { "type": "focus_window" }

OUTPUT FORMAT:
Return ONLY valid JSON with keys in this EXACT order ("route" first, "actions" second, "spokenReply" third) so streaming TTS starts speaking immediately:
{
  "route": "dictation" | "direct-reply" | "approval" | "question" | "assistant",
  "actions": [],
  "spokenReply": "...",
  "displayReply": "...",
  "expectFollowUp": false
}`;

const BRIEFING_SYSTEM_PROMPT = `You are mattr, a warm, crisp voice engineering co-pilot speaking to a developer who is hands-free (driving or walking).
Turn the thread update into 1 to 2 natural spoken sentences using contractions and everyday phrasing.
Rules:
- Plain spoken English ONLY. Zero markdown, zero code snippets, zero backticks, zero bullet points, zero raw file paths, zero robotic preamble.
- State the concrete outcome clearly and, when useful, end with a short natural next-step question.
- Keep it under 35 words.`;

function truncate(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function buildCompactContextJson(req: VoiceAssistantTurnRequest): string {
  const compact = {
    mode: req.mode,
    activeEnvironmentId: req.context.activeEnvironmentId,
    activeThreadId: req.context.activeThreadId,
    activeRoute: req.context.activeRoute,
    mainWindowFocused: req.context.mainWindowFocused,
    composerFocused: req.context.composerFocused,
    projects: req.context.projects
      .filter((project) => !project.archived)
      .slice(0, 40)
      .map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
    threads: req.context.threads.slice(0, 40).map((thread) => ({
      environmentId: thread.environmentId,
      threadId: thread.threadId,
      title: thread.title,
      projectId: thread.projectId,
      projectTitle: thread.projectTitle,
      status: thread.status,
      isActive: thread.isActive ?? false,
      ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
      ...(thread.parentThreadTitle ? { parentThreadTitle: thread.parentThreadTitle } : {}),
      ...(thread.relationshipToParent ? { relationshipToParent: thread.relationshipToParent } : {}),
      ...(thread.activeChildCount ? { activeChildCount: thread.activeChildCount } : {}),
      ...(thread.childTitles && thread.childTitles.length > 0
        ? { childTitles: thread.childTitles }
        : {}),
      ...(thread.providerInstanceId ? { providerInstanceId: thread.providerInstanceId } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.branch ? { branch: thread.branch } : {}),
      latestUserMessage: truncate(thread.latestUserMessage, 140) || null,
      latestAssistantMessage: truncate(thread.latestAssistantMessage, 220) || null,
    })),
    pendingApprovals: req.context.pendingApprovals.slice(0, 15).map((approval) => ({
      environmentId: approval.environmentId,
      threadId: approval.threadId,
      threadTitle: approval.threadTitle,
      requestId: approval.requestId,
      requestKind: approval.requestKind,
      title: approval.title,
      detail: truncate(approval.detail, 140) || null,
      reason: truncate(approval.reason, 140) || null,
    })),
    pendingQuestions: req.context.pendingQuestions.slice(0, 15).map((question) => ({
      environmentId: question.environmentId,
      threadId: question.threadId,
      threadTitle: question.threadTitle,
      requestId: question.requestId,
      questions: question.questions.map((entry) => ({
        id: entry.id,
        header: entry.header,
        question: entry.question,
        ...(entry.isMultiSelect ? { isMultiSelect: true } : {}),
        options:
          entry.optionDetails && entry.optionDetails.length > 0
            ? entry.optionDetails
            : entry.options,
      })),
    })),
    recentHistory: req.history.slice(-8).map((entry) => ({
      role: entry.role,
      text: truncate(entry.text, 200),
      ...(entry.toolSummary ? { toolSummary: truncate(entry.toolSummary, 140) } : {}),
    })),
  };
  return JSON.stringify(compact, null, 2);
}

function buildTurnUserPrompt(req: VoiceAssistantTurnRequest): string {
  return `Workspace context:\n${buildCompactContextJson(req)}\n\nUser utterance:\n${req.utterance.trim()}`;
}

interface ReadThreadExcerpt {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly parentThreadId?: string | null;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly pendingQuestions?: ReadonlyArray<VoiceWorkspaceQuestionSummary>;
  readonly pendingApprovals?: ReadonlyArray<VoiceWorkspaceApprovalSummary>;
  readonly childSubagents?: ReadonlyArray<{
    readonly threadId: string | null;
    readonly title: string;
    readonly status: string;
    readonly progress?: string | undefined;
  }>;
}

function buildFollowUpSynthesisPrompt(input: {
  readonly utterance: string;
  readonly threadExcerpts: ReadonlyArray<ReadThreadExcerpt>;
  readonly workspaceSearches: ReadonlyArray<WorkspaceSearchResult>;
  readonly projectFiles: ReadonlyArray<SafeProjectFileResult>;
  readonly otherToolResults: ReadonlyArray<VoiceAssistantToolResult>;
}): string {
  const deepRequested =
    input.workspaceSearches.some((search) => search.depth === "deep") ||
    input.projectFiles.length > 0 ||
    /\b(dig deeper|deeper|thorough|more detail|in detail|walk me through|explain more)\b/i.test(
      input.utterance,
    );
  const lengthRule = deepRequested
    ? "3 to 6 crisp, natural spoken sentences"
    : "1 to 3 short spoken sentences";

  return [
    `The user asked: "${input.utterance}"`,
    ...(input.threadExcerpts.length > 0
      ? [
          "",
          "Recent thread details (messages, pending questions/approvals, and child subagents):",
          JSON.stringify(input.threadExcerpts, null, 2),
        ]
      : []),
    ...(input.workspaceSearches.length > 0
      ? [
          "",
          "Workspace search matches (threads and project files):",
          JSON.stringify(input.workspaceSearches, null, 2),
        ]
      : []),
    ...(input.projectFiles.length > 0
      ? ["", "Project file excerpts:", JSON.stringify(input.projectFiles, null, 2)]
      : []),
    ...(input.otherToolResults.length > 0
      ? [
          "",
          "Other actions already executed this turn:",
          JSON.stringify(
            input.otherToolResults.map((result) => ({
              tool: result.tool,
              ok: result.ok,
              summary: result.summary,
            })),
          ),
        ]
      : []),
    "",
    `Now return ONLY valid JSON with keys in exact order { "route": "assistant", "actions": [], "spokenReply": "...", "displayReply": "...", "expectFollowUp": true|false } answering the user directly in natural second-person spoken English (${lengthRule}, zero markdown, zero raw file paths, zero third-person narration).`,
  ].join("\n");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRoute(value: unknown): VoiceAssistantTurnResponse["route"] {
  switch (value) {
    case "dictation":
    case "direct-reply":
    case "approval":
    case "question":
    case "assistant":
      return value;
    default:
      return "assistant";
  }
}

function normalizeDecision(
  value: unknown,
): "accept" | "acceptAlways" | "acceptForSession" | "decline" | "cancel" {
  switch (value) {
    case "accept":
    case "acceptAlways":
    case "acceptForSession":
    case "decline":
    case "cancel":
      return value;
    case "approve":
    case "allow":
      return "accept";
    case "always":
    case "allow_always":
      return "acceptAlways";
    case "session":
      return "acceptForSession";
    case "deny":
    case "reject":
      return "decline";
    default:
      return "accept";
  }
}

function normalizeAnswers(value: unknown): Record<string, string | ReadonlyArray<string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | ReadonlyArray<string>> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry;
    } else if (Array.isArray(entry)) {
      const strings = entry.filter((item): item is string => typeof item === "string");
      if (strings.length > 0) result[key] = strings;
    }
  }
  return result;
}

function parsePlannedAction(raw: unknown): VoicePlannedAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rawType = typeof record.type === "string" ? record.type.trim().replaceAll("-", "_") : "";

  switch (rawType) {
    case "create_project": {
      const title = normalizeString(record.title) ?? normalizeString(record.name);
      if (!title) return null;
      return {
        type: "create_project",
        title,
        workspaceRoot: normalizeString(record.workspaceRoot),
      };
    }
    case "launch_thread": {
      return {
        type: "launch_thread",
        projectId: normalizeString(record.projectId),
        projectName: normalizeString(record.projectName) ?? normalizeString(record.projectTitle),
        prompt: normalizeString(record.prompt) ?? normalizeString(record.message),
        title: normalizeString(record.title),
        useWorktree: typeof record.useWorktree === "boolean" ? record.useWorktree : undefined,
      };
    }
    case "send_to_thread": {
      const text = normalizeString(record.text) ?? normalizeString(record.message);
      if (!text) return null;
      const mode = record.dispatchMode ?? record.mode;
      const dispatchMode = mode === "steer" || mode === "queue" || mode === "auto" ? mode : "auto";
      return {
        type: "send_to_thread",
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
        text,
        dispatchMode,
      };
    }
    case "read_thread": {
      return {
        type: "read_thread",
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
      };
    }
    case "interrupt_thread": {
      return {
        type: "interrupt_thread",
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
      };
    }
    case "organize_thread": {
      const op = record.operation ?? record.action;
      if (
        op !== "settle" &&
        op !== "unsettle" &&
        op !== "archive" &&
        op !== "unarchive" &&
        op !== "pin" &&
        op !== "unpin" &&
        op !== "snooze"
      ) {
        return null;
      }
      return {
        type: "organize_thread",
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
        operation: op,
        snoozeMinutes:
          typeof record.snoozeMinutes === "number" && Number.isFinite(record.snoozeMinutes)
            ? record.snoozeMinutes
            : undefined,
      };
    }
    case "respond_approval": {
      return {
        type: "respond_approval",
        environmentId: normalizeString(record.environmentId),
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
        requestId: normalizeString(record.requestId),
        decision: normalizeDecision(record.decision),
      };
    }
    case "respond_question": {
      return {
        type: "respond_question",
        environmentId: normalizeString(record.environmentId),
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
        requestId: normalizeString(record.requestId),
        answers: normalizeAnswers(record.answers),
      };
    }
    case "dismiss_question": {
      return {
        type: "dismiss_question",
        environmentId: normalizeString(record.environmentId),
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
        requestId: normalizeString(record.requestId),
      };
    }
    case "search_workspace": {
      const query = normalizeString(record.query) ?? normalizeString(record.search);
      if (!query) return null;
      const depth = record.depth === "deep" ? "deep" : "quick";
      return {
        type: "search_workspace",
        query,
        projectName: normalizeString(record.projectName) ?? normalizeString(record.projectTitle),
        depth,
      };
    }
    case "read_project_file": {
      const relativePath =
        normalizeString(record.relativePath) ??
        normalizeString(record.path) ??
        normalizeString(record.file);
      if (!relativePath) return null;
      return {
        type: "read_project_file",
        projectName: normalizeString(record.projectName) ?? normalizeString(record.projectTitle),
        relativePath,
        maxChars:
          typeof record.maxChars === "number" && Number.isFinite(record.maxChars)
            ? record.maxChars
            : undefined,
      };
    }
    case "navigate_thread": {
      return {
        type: "navigate_thread",
        environmentId: normalizeString(record.environmentId),
        threadId: normalizeString(record.threadId),
        threadTitle: normalizeString(record.threadTitle),
      };
    }
    case "navigate_route": {
      const to = normalizeString(record.to);
      if (!to) return null;
      return { type: "navigate_route", to };
    }
    case "insert_dictation": {
      const text = normalizeString(record.text);
      if (!text) return null;
      return {
        type: "insert_dictation",
        text,
        autoSend: typeof record.autoSend === "boolean" ? record.autoSend : false,
      };
    }
    case "focus_window": {
      return { type: "focus_window" };
    }
    default:
      return null;
  }
}

const LEADING_REASONING_LABEL =
  /^(?:internal\s+thought|thinking|reasoning|thought|analysis|note\s+to\s+self)\s*:\s*/i;

const LEADING_META_SENTENCE =
  /^(?:the\s+)?user\s+(?:is\s+(?:asking|saying|requesting|referring|trying|looking)|wants|asked|said|mentioned|meant)[^.!?]*(?:[.!?]+\s*|$)/i;

/** Strips `<think>` blocks and leaked third-person reasoning prefixes so raw thought is never spoken. */
export function scrubVoiceReasoning(raw: string): string {
  let cleaned = raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, " ")
    .replace(/<\/think>/gi, " ")
    .trim();

  // Strip repeated leading reasoning labels or "User is asking..." narration sentences.
  for (let pass = 0; pass < 4; pass++) {
    const before = cleaned;
    cleaned = cleaned.replace(LEADING_REASONING_LABEL, "").trim();
    cleaned = cleaned.replace(LEADING_META_SENTENCE, "").trim();
    if (cleaned === before) break;
  }
  return cleaned;
}

export function parseVoiceAssistantPlan(rawText: string): VoiceAssistantPlan {
  const scrubbedRaw = rawText
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .trim();
  try {
    const extracted = extractJsonObject(scrubbedRaw);
    const parsed: unknown = JSON.parse(extracted);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const route = normalizeRoute(record.route);
      const rawActions = Array.isArray(record.actions) ? record.actions : [];
      const actions = rawActions
        .map(parsePlannedAction)
        .filter((action): action is VoicePlannedAction => action !== null);
      const rawSpoken = typeof record.spokenReply === "string" ? record.spokenReply : "";
      const spokenReply =
        route === "dictation" ? "" : sanitizeSpeechText(scrubVoiceReasoning(rawSpoken), 850);
      const rawDisplay = normalizeString(record.displayReply);
      const scrubbedDisplay = rawDisplay ? scrubVoiceReasoning(rawDisplay) : undefined;
      const displayReply =
        (scrubbedDisplay && scrubbedDisplay.length > 0 ? scrubbedDisplay : undefined) ??
        (spokenReply || (route === "dictation" ? "" : "Done."));
      const expectFollowUp = Boolean(record.expectFollowUp);
      return { route, actions, spokenReply, displayReply, expectFollowUp };
    }
  } catch {
    // Plain-text reply from a fallback model is still usable as a spoken reply.
  }
  const fallbackSpoken = sanitizeSpeechText(scrubVoiceReasoning(scrubbedRaw), 850) || "Done.";
  return {
    route: "assistant",
    actions: [],
    spokenReply: fallbackSpoken,
    displayReply: fallbackSpoken,
    expectFollowUp: false,
  };
}

function normalizeLookup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function basenameOf(workspaceRoot: string): string {
  const parts = workspaceRoot.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? workspaceRoot;
}

function fuzzyScore(query: string, candidate: string): number {
  const q = normalizeLookup(query);
  const c = normalizeLookup(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.startsWith(q) || q.startsWith(c)) return 80;
  if (c.includes(q) || q.includes(c)) return 65;
  const qTokens = q.split(" ").filter(Boolean);
  const cTokens = new Set(c.split(" ").filter(Boolean));
  if (qTokens.length === 0 || cTokens.size === 0) return 0;
  let hits = 0;
  for (const token of qTokens) {
    if (cTokens.has(token)) {
      hits++;
      continue;
    }
    for (const candidateToken of cTokens) {
      if (candidateToken.includes(token) || token.includes(candidateToken)) {
        hits += 0.7;
        break;
      }
    }
  }
  return Math.round((hits / qTokens.length) * 60);
}

function matchProjectSummary(
  projects: ReadonlyArray<VoiceWorkspaceProjectSummary>,
  projectId?: string,
  projectName?: string,
): VoiceWorkspaceProjectSummary | undefined {
  if (projectId) {
    const exactId = projects.find((project) => project.id === projectId);
    if (exactId) return exactId;
  }
  const query = projectName ?? projectId;
  if (!query) return undefined;
  let best: VoiceWorkspaceProjectSummary | undefined;
  let bestScore = 0;
  for (const project of projects) {
    const score = Math.max(
      fuzzyScore(query, project.title),
      fuzzyScore(query, basenameOf(project.workspaceRoot)),
    );
    if (score > bestScore) {
      bestScore = score;
      best = project;
    }
  }
  return bestScore >= 40 ? best : undefined;
}

function matchThreadSummary(
  threads: ReadonlyArray<VoiceWorkspaceThreadSummary>,
  activeThreadId: string | null,
  threadId?: string,
  threadTitle?: string,
): VoiceWorkspaceThreadSummary | undefined {
  if (threadId && threadId !== "active") {
    const exactId = threads.find((thread) => thread.threadId === threadId);
    if (exactId) return exactId;
  }
  if ((threadId === "active" || (!threadId && !threadTitle)) && activeThreadId) {
    const active = threads.find((thread) => thread.threadId === activeThreadId);
    if (active) return active;
  }
  const query = threadTitle ?? (threadId && threadId !== "active" ? threadId : undefined);
  if (!query) return undefined;
  let best: VoiceWorkspaceThreadSummary | undefined;
  let bestScore = 0;
  for (const thread of threads) {
    const score = Math.max(
      fuzzyScore(query, thread.title),
      thread.projectTitle ? fuzzyScore(query, `${thread.projectTitle} ${thread.title}`) : 0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = thread;
    }
  }
  return bestScore >= 40 ? best : undefined;
}

const ORDINAL_INDEX: Readonly<Record<string, number>> = {
  first: 0,
  "1st": 0,
  one: 0,
  second: 1,
  "2nd": 1,
  two: 1,
  third: 2,
  "3rd": 2,
  three: 2,
  fourth: 3,
  "4th": 3,
  four: 3,
  fifth: 4,
  "5th": 4,
  five: 4,
  sixth: 5,
  "6th": 5,
  six: 5,
};

function resolveOptionIndex(raw: string, optionCount: number): number | null {
  if (optionCount <= 0) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/^(?:option|choice|number|item|#)\s*/i, "")
    .replace(/\s+one$/i, "")
    .trim();
  if (cleaned === "last") return optionCount - 1;
  const digitMatch = /^(\d+)$/.exec(cleaned);
  if (digitMatch) {
    const idx = Number.parseInt(digitMatch[1]!, 10) - 1;
    if (idx >= 0 && idx < optionCount) return idx;
  }
  const ordinal = ORDINAL_INDEX[cleaned];
  if (ordinal !== undefined && ordinal >= 0 && ordinal < optionCount) {
    return ordinal;
  }
  return null;
}

function resolveOptionLabel(rawValue: string, options: ReadonlyArray<string>): string {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || options.length === 0) return trimmed;

  const byIndex = resolveOptionIndex(trimmed, options.length);
  if (byIndex !== null) {
    return options[byIndex] ?? trimmed;
  }

  const lower = trimmed.toLowerCase();
  const exact = options.find((label) => label.toLowerCase() === lower);
  if (exact) return exact;

  const normalizedQuery = normalizeLookup(trimmed);
  if (normalizedQuery.length > 0) {
    const normalizedExact = options.find((label) => normalizeLookup(label) === normalizedQuery);
    if (normalizedExact) return normalizedExact;

    const startsWithMatches = options.filter((label) =>
      normalizeLookup(label).startsWith(normalizedQuery),
    );
    if (startsWithMatches.length === 1) return startsWithMatches[0]!;

    const includesMatches = options.filter((label) =>
      normalizeLookup(label).includes(normalizedQuery),
    );
    if (includesMatches.length === 1) return includesMatches[0]!;

    let bestLabel: string | undefined;
    let bestScore = 0;
    for (const label of options) {
      const score = fuzzyScore(trimmed, label);
      if (score > bestScore) {
        bestScore = score;
        bestLabel = label;
      }
    }
    if (bestLabel !== undefined && bestScore >= 55) {
      return bestLabel;
    }
  }

  return trimmed;
}

/**
 * Resolves natural-language answers (option numbers like "1"/"option 2"/"first", partial label
 * matches, single-question shorthand keys, and multi-select lists) to exact schema answers keyed
 * by each question's canonical `id`.
 */
export function resolveQuestionAnswers(
  rawAnswers: Readonly<Record<string, string | ReadonlyArray<string>>>,
  questionSummary: VoiceWorkspaceQuestionSummary | undefined,
): Record<string, string | ReadonlyArray<string>> {
  const entries = Object.entries(rawAnswers);
  if (entries.length === 0) return {};
  if (!questionSummary || questionSummary.questions.length === 0) {
    return { ...rawAnswers };
  }

  const resolved: Record<string, string | ReadonlyArray<string>> = {};
  const questions = questionSummary.questions;

  const formatForQuestion = (
    question: VoiceWorkspaceQuestionSummary["questions"][number],
    value: string | ReadonlyArray<string>,
  ): string | ReadonlyArray<string> => {
    const labels =
      question.optionDetails && question.optionDetails.length > 0
        ? question.optionDetails.map((detail) => detail.label)
        : question.options;

    if (question.isMultiSelect) {
      const parts: ReadonlyArray<string> =
        typeof value === "string"
          ? value
              .split(/\s*(?:,|and)\s*/i)
              .map((part) => part.trim())
              .filter(Boolean)
          : value;
      const mapped = parts.map((part) => resolveOptionLabel(part, labels)).filter(Boolean);
      return [...new Set(mapped)];
    }

    const single = typeof value === "string" ? value : (value[0] ?? "");
    return resolveOptionLabel(single, labels);
  };

  if (questions.length === 1) {
    const sole = questions[0]!;
    const exactEntry = rawAnswers[sole.id];
    const chosen = exactEntry ?? entries[0]?.[1];
    if (chosen !== undefined) {
      resolved[sole.id] = formatForQuestion(sole, chosen);
    }
    return resolved;
  }

  const remaining = new Map(entries);
  for (const [index, question] of questions.entries()) {
    let matchedKey: string | undefined;
    if (remaining.has(question.id)) {
      matchedKey = question.id;
    } else {
      for (const candidateKey of remaining.keys()) {
        if (
          candidateKey.toLowerCase() === question.header.toLowerCase() ||
          candidateKey === String(index) ||
          candidateKey === String(index + 1) ||
          candidateKey.toLowerCase() === `q${index + 1}` ||
          fuzzyScore(candidateKey, question.header) >= 60 ||
          fuzzyScore(candidateKey, question.question) >= 60
        ) {
          matchedKey = candidateKey;
          break;
        }
      }
    }
    if (matchedKey !== undefined) {
      const rawValue = remaining.get(matchedKey)!;
      remaining.delete(matchedKey);
      resolved[question.id] = formatForQuestion(question, rawValue);
    }
  }

  for (const [key, value] of remaining) {
    resolved[key] = value;
  }
  return resolved;
}

function matchPendingApproval(
  approvals: ReadonlyArray<VoiceWorkspaceApprovalSummary>,
  input: {
    readonly requestId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly threadTitle?: string | undefined;
  },
): VoiceWorkspaceApprovalSummary | undefined {
  if (input.requestId) {
    const byReq = approvals.find((entry) => entry.requestId === input.requestId);
    if (byReq) return byReq;
  }
  if (input.threadId) {
    const byThread = approvals.find((entry) => entry.threadId === input.threadId);
    if (byThread) return byThread;
  }
  if (input.threadTitle) {
    let best: VoiceWorkspaceApprovalSummary | undefined;
    let bestScore = 0;
    for (const entry of approvals) {
      const score = fuzzyScore(input.threadTitle, entry.threadTitle);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (best && bestScore >= 40) return best;
  }
  if (approvals.length === 1) return approvals[0];
  if (!input.requestId && !input.threadId && !input.threadTitle) return approvals[0];
  return undefined;
}

function matchPendingQuestion(
  questions: ReadonlyArray<VoiceWorkspaceQuestionSummary>,
  input: {
    readonly requestId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly threadTitle?: string | undefined;
  },
): VoiceWorkspaceQuestionSummary | undefined {
  if (input.requestId) {
    const byReq = questions.find((entry) => entry.requestId === input.requestId);
    if (byReq) return byReq;
  }
  if (input.threadId) {
    const byThread = questions.find((entry) => entry.threadId === input.threadId);
    if (byThread) return byThread;
  }
  if (input.threadTitle) {
    let best: VoiceWorkspaceQuestionSummary | undefined;
    let bestScore = 0;
    for (const entry of questions) {
      const score = fuzzyScore(input.threadTitle, entry.threadTitle);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (best && bestScore >= 40) return best;
  }
  if (questions.length === 1) return questions[0];
  if (!input.requestId && !input.threadId && !input.threadTitle) return questions[0];
  return undefined;
}

function firstTwoSentences(text: string, maxChars: number): string {
  const clean = sanitizeSpeechText(text, maxChars * 2);
  if (!clean) return "";
  const sentences =
    clean
      .match(/[^.!?]+[.!?]*/g)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? [];
  const joined = sentences.slice(0, 2).join(" ");
  return sanitizeSpeechText(joined || clean, maxChars);
}

function buildDeterministicBriefing(req: VoiceBriefingRequest): VoiceBriefingResponse {
  const threadName = sanitizeSpeechText(req.threadTitle, 80) || "A thread";
  const count = req.count ?? 1;

  if (req.kind === "approval") {
    const detail = sanitizeSpeechText(req.detail ?? "", 120) || "run a command";
    const spokenText =
      count > 1
        ? `Heads up: ${threadName} and ${count - 1} other ${count - 1 === 1 ? "thread" : "threads"} need approval. First up, ${threadName} wants permission to ${detail}. Say approve, always allow, or deny.`
        : `Heads up: ${threadName} wants permission to ${detail}. Say approve, always allow, or deny.`;
    return {
      spokenText,
      shortLabel: `Approval · ${threadName}`,
      expectFollowUp: true,
    };
  }

  if (req.kind === "question") {
    const firstQuestion =
      sanitizeSpeechText(req.questionPrompts?.[0] ?? req.detail ?? "", 180) ||
      "needs your input before continuing.";
    const needsFollowUpPrompt = !firstQuestion.endsWith("?");
    const spokenText = needsFollowUpPrompt
      ? `${threadName} has a question: ${firstQuestion} What should I tell it?`
      : `${threadName} has a question: ${firstQuestion}`;
    return {
      spokenText,
      shortLabel: `Question · ${threadName}`,
      expectFollowUp: true,
    };
  }

  if (req.kind === "limited") {
    return {
      spokenText: `${threadName} paused because it hit a provider usage limit.`,
      shortLabel: `Paused · ${threadName}`,
      expectFollowUp: false,
    };
  }

  if (req.kind === "failed") {
    const snippet = firstTwoSentences(req.detail ?? req.latestAssistantMessage ?? "", 180);
    return {
      spokenText: snippet
        ? `${threadName} ran into an error. ${snippet} Want me to retry or inspect it?`
        : `${threadName} ran into an error. Want me to look into what failed?`,
      shortLabel: `Error · ${threadName}`,
      expectFollowUp: true,
    };
  }

  const snippet = firstTwoSentences(req.latestAssistantMessage ?? req.detail ?? "", 200);
  const extraCount = count > 1 ? count - 1 : (req.extraTitles?.length ?? 0);
  if (extraCount > 0) {
    return {
      spokenText: snippet
        ? `${threadName} and ${extraCount} other ${extraCount === 1 ? "thread" : "threads"} finished. ${snippet}`
        : `${threadName} and ${extraCount} other ${extraCount === 1 ? "thread" : "threads"} just finished.`,
      shortLabel: `Done · ${threadName}`,
      expectFollowUp: false,
    };
  }
  return {
    spokenText: snippet ? `${threadName} finished. ${snippet}` : `${threadName} finished its run.`,
    shortLabel: `Done · ${threadName}`,
    expectFollowUp: false,
  };
}

const ChatCompletionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
    }),
  ),
});

const AnthropicMessageResponse = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});

const decodeChatCompletion = Schema.decodeUnknownEffect(ChatCompletionResponse);
const decodeAnthropicMessage = Schema.decodeUnknownEffect(AnthropicMessageResponse);

/** The text delta in one server-sent-event line from an OpenAI-compatible or Anthropic stream. */
export function parseSseTextDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice(5).trim();
  if (data.length === 0 || data === "[DONE]") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const event = parsed as {
    readonly type?: unknown;
    readonly delta?: { readonly text?: unknown };
    readonly choices?: ReadonlyArray<{ readonly delta?: { readonly content?: unknown } }>;
  };
  if (event.type === "content_block_delta") {
    return typeof event.delta?.text === "string" ? event.delta.text : "";
  }
  const content = event.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

interface DirectLlmTarget {
  readonly kind: "openaiCompatible" | "anthropic";
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fallbackModel?: string | undefined;
  readonly disableThinking?: boolean | undefined;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projectService = yield* ProjectService.ProjectService;
  const managedProjectFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const random = yield* SecureRandom.SecureRandom;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  const resolveDirectLlmTarget = Effect.fn("VoiceAssistantService.resolveDirectLlmTarget")(
    function* (settings: ServerSettingsContract): Effect.fn.Return<DirectLlmTarget | null> {
      const configuredGenerators = Object.entries(settings.textGenerators) as Array<
        [string, TextGeneratorConfig]
      >;
      const preferredId = settings.textGenerationModelSelection.instanceId;
      const preferredEntry = configuredGenerators.find(
        ([id, cfg]) => id === preferredId && cfg.enabled,
      );
      const anyEnabledEntry = preferredEntry ?? configuredGenerators.find(([, cfg]) => cfg.enabled);

      if (anyEnabledEntry) {
        const [id, config] = anyEnabledEntry;
        const apiKey = yield* requireSettingsSecret(secretResolver, config.apiKey).pipe(
          Effect.orElseSucceed(() => ""),
        );
        const model =
          id === preferredId
            ? settings.textGenerationModelSelection.model
            : config.kind === "anthropic"
              ? "claude-haiku-4-5"
              : "gpt-4o-mini";
        if (
          config.baseUrl.trim().length > 0 &&
          (apiKey.trim().length > 0 || config.kind === "openaiCompatible")
        ) {
          return {
            kind: config.kind,
            baseUrl: config.baseUrl.replace(/\/+$/, ""),
            apiKey: apiKey.trim(),
            model,
          };
        }
      }

      const openAiSource = settings.cloudSpeechCredentials.openai;
      if (openAiSource) {
        const apiKey = yield* requireSettingsSecret(secretResolver, openAiSource).pipe(
          Effect.orElseSucceed(() => ""),
        );
        if (apiKey.trim().length > 0) {
          return {
            kind: "openaiCompatible",
            baseUrl: "https://api.openai.com/v1",
            apiKey: apiKey.trim(),
            model: "gpt-4o-mini",
          };
        }
      }
      const envOpenAi = yield* readEnvOpenAiKey;
      if (envOpenAi) {
        return {
          kind: "openaiCompatible",
          baseUrl: "https://api.openai.com/v1",
          apiKey: envOpenAi,
          model: "gpt-4o-mini",
        };
      }
      const openRouterSource = settings.cloudSpeechCredentials.openrouter;
      if (openRouterSource) {
        const apiKey = yield* requireSettingsSecret(secretResolver, openRouterSource).pipe(
          Effect.orElseSucceed(() => ""),
        );
        if (apiKey.trim().length > 0) {
          return {
            kind: "openaiCompatible",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: apiKey.trim(),
            model: OPENROUTER_PRIMARY_MODEL,
            fallbackModel: OPENROUTER_FALLBACK_MODEL,
            disableThinking: true,
          };
        }
      }
      const xaiSource = settings.cloudSpeechCredentials.xai;
      if (xaiSource) {
        const apiKey = yield* requireSettingsSecret(secretResolver, xaiSource).pipe(
          Effect.orElseSucceed(() => ""),
        );
        if (apiKey.trim().length > 0) {
          return {
            kind: "openaiCompatible",
            baseUrl: "https://api.x.ai/v1",
            apiKey: apiKey.trim(),
            model: "grok-3-mini-fast",
          };
        }
      }
      return null;
    },
  );

  const callDirectLlm = Effect.fn("VoiceAssistantService.callDirectLlm")(function* (
    target: DirectLlmTarget,
    input: {
      readonly systemPrompt: string;
      readonly userPrompt: string;
      readonly expectJson: boolean;
      readonly timeoutMs: number;
    },
  ) {
    let request: HttpClientRequest.HttpClientRequest;
    if (target.kind === "anthropic") {
      request = HttpClientRequest.post(`${target.baseUrl}/messages`).pipe(
        HttpClientRequest.setHeader("x-api-key", target.apiKey),
        HttpClientRequest.setHeader("anthropic-version", ANTHROPIC_API_VERSION),
        HttpClientRequest.bodyJsonUnsafe({
          model: target.model,
          max_tokens: 1024,
          temperature: 0.2,
          system: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt }],
        }),
      );
    } else {
      const suppressThinking =
        target.disableThinking === true ||
        (target.baseUrl.includes("openrouter.ai") && target.model.startsWith("google/gemini"));
      request = HttpClientRequest.post(`${target.baseUrl}/chat/completions`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          model: target.model,
          temperature: 0.2,
          max_tokens: 1024,
          ...(suppressThinking ? { reasoning: { effort: "none" } } : {}),
          ...(input.expectJson ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
        }),
      );
      if (target.apiKey) {
        request = HttpClientRequest.bearerToken(request, Redacted.make(target.apiKey));
      }
    }

    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({
        duration: Duration.millis(input.timeoutMs),
        orElse: () => Effect.fail(new VoiceAssistantLlmError({ stage: "direct-http" })),
      }),
      Effect.mapError((cause) =>
        isVoiceAssistantLlmError(cause)
          ? cause
          : new VoiceAssistantLlmError({ stage: "direct-http", cause }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceAssistantLlmError({
        stage: "direct-http",
        cause: `HTTP ${response.status}`,
      });
    }
    const rawJson = yield* response.json.pipe(
      Effect.mapError((cause) => new VoiceAssistantLlmError({ stage: "direct-http", cause })),
    );

    if (target.kind === "anthropic") {
      const message = yield* decodeAnthropicMessage(rawJson).pipe(
        Effect.mapError((cause) => new VoiceAssistantLlmError({ stage: "direct-http", cause })),
      );
      const text = message.content
        .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
        .join("")
        .trim();
      if (!text) return yield* new VoiceAssistantLlmError({ stage: "direct-http" });
      return text;
    }

    const completion = yield* decodeChatCompletion(rawJson).pipe(
      Effect.mapError((cause) => new VoiceAssistantLlmError({ stage: "direct-http", cause })),
    );
    const text = completion.choices[0]?.message.content?.trim();
    if (!text) return yield* new VoiceAssistantLlmError({ stage: "direct-http" });
    return text;
  });

  /** Server-sent-event streaming of the same request; `onText` sees each content delta. */
  const streamDirectLlm = Effect.fn("VoiceAssistantService.streamDirectLlm")(function* (
    target: DirectLlmTarget,
    input: {
      readonly systemPrompt: string;
      readonly userPrompt: string;
      readonly expectJson: boolean;
      readonly timeoutMs: number;
    },
    onText: (text: string) => Effect.Effect<void>,
  ) {
    let request: HttpClientRequest.HttpClientRequest;
    if (target.kind === "anthropic") {
      request = HttpClientRequest.post(`${target.baseUrl}/messages`).pipe(
        HttpClientRequest.setHeader("x-api-key", target.apiKey),
        HttpClientRequest.setHeader("anthropic-version", ANTHROPIC_API_VERSION),
        HttpClientRequest.bodyJsonUnsafe({
          model: target.model,
          max_tokens: 1024,
          temperature: 0.2,
          stream: true,
          system: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt }],
        }),
      );
    } else {
      const suppressThinking =
        target.disableThinking === true ||
        (target.baseUrl.includes("openrouter.ai") && target.model.startsWith("google/gemini"));
      request = HttpClientRequest.post(`${target.baseUrl}/chat/completions`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          model: target.model,
          temperature: 0.2,
          max_tokens: 1024,
          stream: true,
          ...(suppressThinking ? { reasoning: { effort: "none" } } : {}),
          ...(input.expectJson ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
        }),
      );
      if (target.apiKey) {
        request = HttpClientRequest.bearerToken(request, Redacted.make(target.apiKey));
      }
    }
    request = HttpClientRequest.setHeader(request, "accept", "text/event-stream");

    let text = "";
    const run = Effect.gen(function* () {
      const response = yield* httpClient
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* new VoiceAssistantLlmError({
          stage: "direct-http",
          cause: `HTTP ${response.status}`,
        });
      }
      yield* response.stream.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => {
          const delta = parseSseTextDelta(line);
          if (!delta) return Effect.void;
          text += delta;
          return onText(delta);
        }),
      );
    });
    yield* run.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(input.timeoutMs),
        orElse: () => Effect.fail(new VoiceAssistantLlmError({ stage: "direct-http" })),
      }),
      Effect.mapError((cause) =>
        isVoiceAssistantLlmError(cause)
          ? cause
          : new VoiceAssistantLlmError({ stage: "direct-http", cause }),
      ),
    );
    const trimmed = text.trim();
    if (!trimmed) return yield* new VoiceAssistantLlmError({ stage: "direct-http" });
    return trimmed;
  });

  const callFallbackTextGeneration = Effect.fn("VoiceAssistantService.callFallbackTextGeneration")(
    function* (
      settings: ServerSettingsContract,
      input: {
        readonly systemPrompt: string;
        readonly userPrompt: string;
        readonly expectJson: boolean;
        readonly timeoutMs: number;
      },
    ) {
      const providers = yield* providerRegistry.getProviders;
      const modelSelection = resolveSpeechPostProcessingModelSelection(settings, providers);
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "mattr-voice-assistant-" })
        .pipe(
          Effect.mapError(
            (cause) => new VoiceAssistantLlmError({ stage: "text-generation", cause }),
          ),
        );
      const wrapperInstruction = input.expectJson
        ? 'Put your complete JSON response object (serialized as a JSON string) inside the "transcription" string field of the output schema.'
        : 'Put your concise spoken reply directly inside the "transcription" string field of the output schema.';
      const combinedPrompt = `${input.systemPrompt}\n\n${wrapperInstruction}\n\n${input.userPrompt}`;
      const result = yield* textGeneration
        .generateTranscriptionPostProcessing({
          cwd,
          prompt: combinedPrompt,
          modelSelection,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(input.timeoutMs),
            orElse: () => Effect.fail(new VoiceAssistantLlmError({ stage: "text-generation" })),
          }),
          Effect.mapError((cause) =>
            isVoiceAssistantLlmError(cause)
              ? cause
              : new VoiceAssistantLlmError({ stage: "text-generation", cause }),
          ),
        );
      const text = result.transcription.trim();
      if (!text) {
        return yield* new VoiceAssistantLlmError({ stage: "text-generation" });
      }
      return text;
    },
    Effect.scoped,
  );

  const runLlm = Effect.fn("VoiceAssistantService.runLlm")(function* (input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly expectJson: boolean;
    readonly directTimeoutMs: number;
    readonly fallbackTimeoutMs: number;
    /** Streams the direct model's output; the fallback path delivers its whole text once. */
    readonly onText?: ((text: string) => Effect.Effect<void>) | undefined;
  }) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new VoiceAssistantLlmError({ stage: "text-generation", cause })),
    );
    const directTarget = yield* resolveDirectLlmTarget(settings);
    const directCandidates: ReadonlyArray<DirectLlmTarget> =
      directTarget === null
        ? []
        : directTarget.fallbackModel
          ? [
              directTarget,
              {
                ...directTarget,
                model: directTarget.fallbackModel,
                fallbackModel: undefined,
                disableThinking: false,
              },
            ]
          : [directTarget];
    const onText = input.onText;
    if (directCandidates.length > 0 && onText !== undefined) {
      for (const candidate of directCandidates) {
        let emitted = false;
        const streamed = yield* streamDirectLlm(
          candidate,
          {
            systemPrompt: input.systemPrompt,
            userPrompt: input.userPrompt,
            expectJson: input.expectJson,
            timeoutMs: input.directTimeoutMs,
          },
          (text) => {
            emitted = true;
            return onText(text);
          },
        ).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Streaming voice assistant LLM failed.", {
              model: candidate.model,
              cause,
            }),
          ),
          Effect.option,
        );
        if (Option.isSome(streamed)) return streamed.value;
        // Text already sent cannot be taken back, so a stream that broke midway ends the turn.
        if (emitted) return yield* new VoiceAssistantLlmError({ stage: "direct-http" });
      }
    }
    for (const candidate of directCandidates) {
      const directResult = yield* callDirectLlm(candidate, {
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        expectJson: input.expectJson,
        timeoutMs: input.directTimeoutMs,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Direct voice assistant LLM failed; trying next fallback.", {
            model: candidate.model,
            cause,
          }),
        ),
        Effect.option,
      );
      if (Option.isSome(directResult)) return directResult.value;
    }
    const fallback = yield* callFallbackTextGeneration(settings, {
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      expectJson: input.expectJson,
      timeoutMs: input.fallbackTimeoutMs,
    });
    if (onText !== undefined) yield* onText(fallback);
    return fallback;
  });

  /**
   * Feeds a streaming plan's `spokenReply` to `hooks` as it arrives. `speculate` decides from the
   * fields written before it whether the text can still change (a tool round would rewrite it).
   */
  const spokenStreamer = (
    hooks: VoiceTurnStreamHooks | undefined,
    speculate: (prefix: string) => boolean,
  ) => {
    if (hooks === undefined) return { onText: undefined, spoken: () => "" };
    const reader = createJsonStringFieldReader("spokenReply");
    let allowed: boolean | null = null;
    let spoken = "";
    return {
      onText: Effect.fn("VoiceAssistantService.streamSpokenReply")(function* (delta: string) {
        const text = reader.push(delta);
        if (!reader.started) return;
        allowed ??= speculate(reader.prefix);
        if (!allowed || text.length === 0) return;
        spoken += text;
        yield* hooks.onSpokenDelta(text);
      }),
      spoken: () => spoken,
    };
  };

  const resolveLaunchModelAndMode = Effect.fn("VoiceAssistantService.resolveLaunchModelAndMode")(
    function* (projectId: ProjectId) {
      const [settings, providers, projectOption] = yield* Effect.all(
        [
          settingsService.getSettings.pipe(Effect.orElseSucceed(() => null)),
          providerRegistry.getProviders,
          projectService.getById(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
        ],
        { concurrency: "unbounded" },
      );
      const project = Option.getOrUndefined(projectOption);
      const projectSettings =
        settings === null ? null : resolveProjectSettings(settings, projectId, project).settings;

      let modelSelection: ModelSelection | null = null;
      if (projectSettings !== null) {
        modelSelection = resolveNewThreadModelSelection({
          defaultSelection: projectSettings.defaultModelSelection,
          fallbackSelection: projectSettings.fallbackModelSelection,
          providers,
          settings: projectSettings,
          projectId,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        }).selection;
      }
      if (modelSelection === null) {
        const enabledProvider = providers.find(
          (provider) => provider.enabled && provider.models.length > 0,
        );
        if (enabledProvider && enabledProvider.models[0]) {
          modelSelection = {
            instanceId: enabledProvider.instanceId,
            model: enabledProvider.models[0].slug,
          };
        } else if (settings !== null) {
          modelSelection = settings.textGenerationModelSelection;
        }
      }

      const defaultRuntimeMode: RuntimeMode =
        projectSettings?.defaultRuntimeMode ?? settings?.defaultRuntimeMode ?? "approval-required";
      const provider = modelSelection
        ? providers.find((candidate) => candidate.instanceId === modelSelection.instanceId)
        : undefined;
      const supported = provider?.supportedRuntimeModes;
      const runtimeMode: RuntimeMode =
        supported && supported.length > 0 && !supported.includes(defaultRuntimeMode)
          ? (supported[0] ?? defaultRuntimeMode)
          : defaultRuntimeMode;

      return { modelSelection, runtimeMode, project, projectSettings };
    },
  );

  const resolveWorktreeStrategy = Effect.fn("VoiceAssistantService.resolveWorktreeStrategy")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly wantWorktree: boolean;
      readonly startFromOrigin: boolean;
    }): Effect.fn.Return<ThreadLaunchService.ThreadLaunchWorkspaceStrategy> {
      if (!input.wantWorktree) return { type: "root" };
      const head = yield* git
        .execute({
          operation: "VoiceAssistant.symbolicRefHead",
          cwd: input.workspaceRoot,
          args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.orElseSucceed(() => null));
      const branch = head?.exitCode === 0 ? head.stdout.trim() : "";
      if (!branch) return { type: "root" };
      const candidate: ThreadLaunchService.ThreadLaunchWorkspaceStrategy = {
        type: "worktree",
        baseRef: branch,
        startFromOrigin: input.startFromOrigin,
      };
      const valid = yield* threadLaunch
        .checkWorktreeBase({ projectId: input.projectId, workspaceStrategy: candidate })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      return valid ? candidate : { type: "root" };
    },
  );

  const runTurn = Effect.fn("VoiceAssistantService.runTurn")(function* (
    req: VoiceAssistantTurnRequest,
    hooks: VoiceTurnStreamHooks | undefined,
  ) {
    const utterance = req.utterance.trim();
    if (utterance.length === 0) {
      return {
        route: "assistant",
        spokenReply: "I didn't catch that. What would you like me to do?",
        displayReply: "Didn't catch that.",
        expectFollowUp: true,
        toolResults: [],
        clientActions: [],
      } satisfies VoiceAssistantTurnResponse;
    }

    if (req.mode === "dictation") {
      return {
        route: "dictation",
        spokenReply: "",
        displayReply: utterance,
        expectFollowUp: false,
        toolResults: [],
        clientActions: [{ type: "insert-dictation", text: utterance, autoSend: false }],
      } satisfies VoiceAssistantTurnResponse;
    }

    const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    const hydratedContext = yield* hydrateVoiceWorkspaceContext({
      reqContext: req.context,
      localEnvironmentId,
      projectService,
      threadManagement,
    });
    const hydratedReq: VoiceAssistantTurnRequest = {
      ...req,
      context: hydratedContext,
    };

    // Only a plan with no actions can be spoken while it streams: tools may rewrite the reply.
    const planSpoken = spokenStreamer(
      hooks,
      (prefix) => PLAN_ACTIONS_EMPTY.test(prefix) && !PLAN_ROUTE_DICTATION.test(prefix),
    );
    const rawPlanText = yield* runLlm({
      systemPrompt: VOICE_ASSISTANT_SYSTEM_PROMPT,
      userPrompt: buildTurnUserPrompt(hydratedReq),
      expectJson: true,
      directTimeoutMs: DIRECT_TURN_TIMEOUT_MS,
      fallbackTimeoutMs: FALLBACK_TURN_TIMEOUT_MS,
      onText: planSpoken.onText,
    }).pipe(Effect.option);

    if (Option.isNone(rawPlanText)) {
      return {
        route: "assistant",
        spokenReply: "I couldn't reach a model to process that right now. Try again in a moment.",
        displayReply: "Voice assistant model unavailable.",
        expectFollowUp: false,
        toolResults: [],
        clientActions: [],
      } satisfies VoiceAssistantTurnResponse;
    }

    const plan = parseVoiceAssistantPlan(rawPlanText.value);
    const defaultEnvId = hydratedContext.activeEnvironmentId ?? localEnvironmentId;

    const toolResults: Array<VoiceAssistantToolResult> = [];
    const clientActions: Array<VoiceAssistantClientAction> = [];
    const createdProjects: Array<VoiceWorkspaceProjectSummary> = [];
    const launchedThreads: Array<VoiceWorkspaceThreadSummary> = [];
    const readThreadExcerpts: Array<ReadThreadExcerpt> = [];
    const workspaceSearches: Array<WorkspaceSearchResult> = [];
    const projectFileExcerpts: Array<SafeProjectFileResult> = [];

    const allKnownProjects = () => [...createdProjects, ...hydratedContext.projects];
    const allKnownThreads = () => [...launchedThreads, ...hydratedContext.threads];

    const resolveProject = Effect.fnUntraced(function* (
      projectId?: string,
      projectName?: string,
    ): Effect.fn.Return<VoiceWorkspaceProjectSummary | undefined> {
      const fromCreated = matchProjectSummary(createdProjects, projectId, projectName);
      if (fromCreated) return fromCreated;

      if (!projectId && !projectName && createdProjects.length > 0) {
        return createdProjects[createdProjects.length - 1];
      }

      const fromContext = matchProjectSummary(allKnownProjects(), projectId, projectName);
      if (fromContext) return fromContext;

      const page = yield* projectService
        .listPage({ cursor: 0, limit: 100 })
        .pipe(Effect.orElseSucceed(() => ({ projects: [], nextCursor: null })));
      const serverProjects: ReadonlyArray<VoiceWorkspaceProjectSummary> = page.projects.map(
        (project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          archived: project.archivedAt !== null,
        }),
      );
      return matchProjectSummary(serverProjects, projectId, projectName);
    });

    const resolveThread = Effect.fnUntraced(function* (
      threadId?: string,
      threadTitle?: string,
    ): Effect.fn.Return<
      | {
          readonly environmentId: string;
          readonly threadId: ThreadId;
          readonly projectId: ProjectId;
          readonly title: string;
        }
      | undefined
    > {
      const matched = matchThreadSummary(
        allKnownThreads(),
        hydratedContext.activeThreadId,
        threadId,
        threadTitle,
      );
      if (matched) {
        const projectId =
          matched.projectId !== null
            ? ProjectId.make(matched.projectId)
            : (yield* threadManagement
                .getThreadShell(ThreadId.make(matched.threadId))
                .pipe(Effect.orElseSucceed(() => null)))?.projectId;
        if (projectId !== undefined) {
          return {
            environmentId: matched.environmentId,
            threadId: ThreadId.make(matched.threadId),
            projectId,
            title: matched.title,
          };
        }
      }
      if (threadId && threadId !== "active") {
        const shell = yield* threadManagement
          .getThreadShell(ThreadId.make(threadId))
          .pipe(Effect.orElseSucceed(() => null));
        if (shell && shell.deletedAt === null) {
          return {
            environmentId: defaultEnvId,
            threadId: shell.id,
            projectId: shell.projectId,
            title: shell.title,
          };
        }
      }
      return undefined;
    });

    const newId = (prefix: string) =>
      random.uuidV4().pipe(Effect.map((uuid) => `${prefix}:${uuid}`));

    for (const action of plan.actions) {
      switch (action.type) {
        case "create_project": {
          if (action.workspaceRoot) {
            const commandId = CommandId.make(yield* newId("voice-project-create"));
            const projectId = ProjectId.make(yield* newId("project"));
            const created = yield* projectService
              .create({
                commandId,
                projectId,
                title: action.title,
                workspaceRoot: action.workspaceRoot,
                createWorkspaceRootIfMissing: true,
              })
              .pipe(
                Effect.map((project) => ({ ok: true as const, project, existed: false })),
                Effect.catchTags({
                  ProjectConflictError: (conflict) =>
                    projectService.getById(conflict.conflictingProjectId).pipe(
                      Effect.map((existing) =>
                        Option.isSome(existing)
                          ? { ok: true as const, project: existing.value, existed: true }
                          : { ok: false as const, error: conflict.message },
                      ),
                      Effect.orElseSucceed(() => ({
                        ok: false as const,
                        error: conflict.message,
                      })),
                    ),
                  ProjectNotFoundError: (error) =>
                    Effect.succeed({ ok: false as const, error: error.message }),
                  ProjectNotEmptyError: (error) =>
                    Effect.succeed({ ok: false as const, error: error.message }),
                  ProjectInvalidError: (error) =>
                    Effect.succeed({ ok: false as const, error: error.message }),
                  ProjectOperationError: (error) =>
                    Effect.succeed({ ok: false as const, error: error.message }),
                }),
              );
            if (created.ok) {
              const summary: VoiceWorkspaceProjectSummary = {
                id: created.project.id,
                title: created.project.title,
                workspaceRoot: created.project.workspaceRoot,
              };
              createdProjects.push(summary);
              toolResults.push({
                tool: "create_project",
                ok: true,
                summary: created.existed
                  ? `Using existing project "${created.project.title}".`
                  : `Created project "${created.project.title}".`,
                environmentId: localEnvironmentId,
                projectId: created.project.id,
              });
            } else {
              toolResults.push({
                tool: "create_project",
                ok: false,
                summary: created.error,
              });
            }
          } else {
            const created = yield* managedProjectFolders
              .createNamedProject({ name: action.title })
              .pipe(
                Effect.map((result) => ({ ok: true as const, result })),
                Effect.catch((error) =>
                  Effect.succeed({ ok: false as const, error: error.message }),
                ),
              );
            if (created.ok) {
              const summary: VoiceWorkspaceProjectSummary = {
                id: created.result.projectId,
                title: action.title,
                workspaceRoot: created.result.workspaceRoot,
              };
              createdProjects.push(summary);
              toolResults.push({
                tool: "create_project",
                ok: true,
                summary: `Created project "${action.title}".`,
                environmentId: localEnvironmentId,
                projectId: created.result.projectId,
              });
            } else {
              toolResults.push({
                tool: "create_project",
                ok: false,
                summary: created.error,
              });
            }
          }
          break;
        }

        case "launch_thread": {
          let matchedProject = yield* resolveProject(action.projectId, action.projectName);
          if (!matchedProject && !action.projectId && !action.projectName) {
            const activeThread = hydratedContext.activeThreadId
              ? hydratedContext.threads.find(
                  (thread) => thread.threadId === hydratedContext.activeThreadId,
                )
              : undefined;
            if (activeThread?.projectId) {
              matchedProject = yield* resolveProject(activeThread.projectId, undefined);
            }
          }
          let projectId: ProjectId | undefined = matchedProject
            ? ProjectId.make(matchedProject.id)
            : undefined;
          let projectTitle = matchedProject?.title ?? null;

          if (projectId === undefined && !action.projectName && !action.projectId) {
            const scratch = yield* managedProjectFolders.ensureScratchProject.pipe(
              Effect.orElseSucceed(() => null),
            );
            if (scratch) {
              projectId = scratch.projectId;
              projectTitle = "No project";
            }
          }

          if (projectId === undefined) {
            toolResults.push({
              tool: "launch_thread",
              ok: false,
              summary: `Could not find project "${action.projectName ?? action.projectId ?? ""}".`,
            });
            break;
          }

          const { modelSelection, runtimeMode, project, projectSettings } =
            yield* resolveLaunchModelAndMode(projectId);
          if (modelSelection === null) {
            toolResults.push({
              tool: "launch_thread",
              ok: false,
              summary: "No model provider is configured to launch a thread.",
              projectId,
            });
            break;
          }

          const wantWorktree =
            action.useWorktree ?? projectSettings?.defaultThreadEnvMode === "worktree";
          const workspaceStrategy =
            project !== undefined
              ? yield* resolveWorktreeStrategy({
                  projectId,
                  workspaceRoot: project.workspaceRoot,
                  wantWorktree,
                  startFromOrigin: projectSettings?.newWorktreesStartFromOrigin ?? true,
                })
              : ({ type: "root" } as const);

          const commandId = CommandId.make(yield* newId("voice-thread-launch"));
          const threadId = ThreadId.make(yield* newId("thread"));
          const messageId = MessageId.make(yield* newId("message"));
          const title = action.title?.trim() || "New thread";
          const prompt = action.prompt?.trim();

          const launched = yield* threadLaunch
            .launch({
              commandId,
              threadId,
              projectId,
              title,
              generateTitle: !action.title?.trim() && Boolean(prompt),
              ...(action.title?.trim() ? { titleRenamed: true } : {}),
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              workspaceStrategy,
              ...(prompt
                ? {
                    initialMessage: {
                      messageId,
                      text: prompt,
                      attachments: [],
                    },
                  }
                : {}),
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.message })),
            );

          if (launched.ok) {
            const createdThread = launched.result.projection.thread;
            launchedThreads.push({
              environmentId: localEnvironmentId,
              threadId: createdThread.id,
              title: createdThread.title,
              projectId: createdThread.projectId,
              projectTitle,
              status: prompt ? "running" : "idle",
              updatedAt: DateTime.formatIso(createdThread.updatedAt),
              latestUserMessage: prompt ?? null,
              latestAssistantMessage: null,
            });
            toolResults.push({
              tool: "launch_thread",
              ok: true,
              summary: `Started thread "${createdThread.title}"${projectTitle ? ` in ${projectTitle}` : ""}.`,
              environmentId: localEnvironmentId,
              threadId: createdThread.id,
              projectId: createdThread.projectId,
            });
          } else {
            toolResults.push({
              tool: "launch_thread",
              ok: false,
              summary: launched.error,
              projectId,
            });
          }
          break;
        }

        case "send_to_thread": {
          const target = yield* resolveThread(action.threadId, action.threadTitle);
          if (!target) {
            toolResults.push({
              tool: "send_to_thread",
              ok: false,
              summary: `Could not find thread "${action.threadTitle ?? action.threadId ?? ""}".`,
            });
            break;
          }
          const commandId = CommandId.make(yield* newId("voice-thread-send"));
          const messageId = MessageId.make(yield* newId("message"));
          const sent = yield* threadManagement
            .sendToThread({
              projectId: target.projectId,
              commandId,
              threadId: target.threadId,
              messageId,
              text: action.text,
              attachments: [],
              mode: action.dispatchMode ?? "auto",
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.message })),
            );
          toolResults.push(
            sent.ok
              ? {
                  tool: "send_to_thread",
                  ok: true,
                  summary: `Sent message to "${target.title}" (${sent.result.delivery}).`,
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                  projectId: target.projectId,
                }
              : {
                  tool: "send_to_thread",
                  ok: false,
                  summary: sent.error,
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                },
          );
          break;
        }

        case "read_thread": {
          const target = yield* resolveThread(action.threadId, action.threadTitle);
          if (!target) {
            toolResults.push({
              tool: "read_thread",
              ok: false,
              summary: `Could not find thread "${action.threadTitle ?? action.threadId ?? ""}".`,
            });
            break;
          }
          const loaded = yield* threadManagement.getThreadProjection(target.threadId).pipe(
            Effect.map((projection) => ({ ok: true as const, projection })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.message })),
          );
          if (loaded.ok) {
            const latest = ThreadManagementService.latestRun(loaded.projection);
            const messages = loaded.projection.messages.slice(-8).map((message) => ({
              role: message.role,
              text: truncate(message.text, 600),
            }));
            const runtimeRequests = loaded.projection.runtimeRequests ?? [];
            const turnItems = loaded.projection.turnItems ?? [];
            const pendingQuestions: Array<VoiceWorkspaceQuestionSummary> = [];
            const pendingApprovals: Array<VoiceWorkspaceApprovalSummary> = [];
            for (const request of runtimeRequests) {
              if (request.status !== "pending") continue;
              if (request.kind === "user_input") {
                const item = turnItems.find(
                  (candidate) =>
                    candidate.type === "user_input_request" && candidate.requestId === request.id,
                );
                if (item?.type === "user_input_request") {
                  pendingQuestions.push({
                    environmentId: target.environmentId,
                    threadId: target.threadId,
                    threadTitle: loaded.projection.thread.title,
                    requestId: request.id,
                    questions: item.questions.map((question) => ({
                      id: question.id,
                      header: question.header,
                      question: question.question,
                      isMultiSelect: question.multiSelect === true,
                      options: question.options.map((option) => option.label),
                      optionDetails: question.options.map((option) => ({
                        label: option.label,
                        ...(option.description ? { description: option.description } : {}),
                      })),
                    })),
                  });
                }
              } else if (isApprovalRequestKind(request.kind)) {
                const item = turnItems.find(
                  (candidate) =>
                    candidate.type === "approval_request" && candidate.requestId === request.id,
                );
                const prompt = item?.type === "approval_request" ? item.prompt : undefined;
                const reason = item?.type === "approval_request" ? item.reason : undefined;
                const appName = item?.type === "approval_request" ? item.appName : undefined;
                pendingApprovals.push({
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                  threadTitle: loaded.projection.thread.title,
                  requestId: request.id,
                  requestKind: request.kind,
                  title: truncate(prompt ?? appName, 120) || `${request.kind} approval`,
                  detail: truncate(prompt, 200) || null,
                  reason: truncate(reason, 200) || null,
                });
              }
            }

            const childMap = new Map<
              string,
              {
                readonly threadId: string | null;
                readonly title: string;
                readonly status: string;
                readonly progress?: string | undefined;
              }
            >();
            for (const subagent of loaded.projection.subagents ?? []) {
              const key = subagent.childThreadId ?? subagent.id;
              childMap.set(key, {
                threadId: subagent.childThreadId,
                title: subagent.title ?? truncate(subagent.prompt, 60) ?? "Subagent",
                status: subagent.status,
                ...(subagent.progress ? { progress: truncate(subagent.progress, 160) } : {}),
              });
            }
            for (const thread of allKnownThreads()) {
              if (thread.parentThreadId === target.threadId && !childMap.has(thread.threadId)) {
                childMap.set(thread.threadId, {
                  threadId: thread.threadId,
                  title: thread.title,
                  status: thread.status,
                  ...(thread.latestAssistantMessage
                    ? { progress: truncate(thread.latestAssistantMessage, 160) }
                    : {}),
                });
              }
            }
            const childSubagents = [...childMap.values()].slice(0, 8);

            readThreadExcerpts.push({
              threadId: target.threadId,
              title: loaded.projection.thread.title,
              status: latest?.status ?? "idle",
              ...(loaded.projection.thread.lineage?.parentThreadId
                ? { parentThreadId: loaded.projection.thread.lineage.parentThreadId }
                : {}),
              messages,
              ...(pendingQuestions.length > 0 ? { pendingQuestions } : {}),
              ...(pendingApprovals.length > 0 ? { pendingApprovals } : {}),
              ...(childSubagents.length > 0 ? { childSubagents } : {}),
            });
            toolResults.push({
              tool: "read_thread",
              ok: true,
              summary: `Read recent updates from "${loaded.projection.thread.title}".`,
              environmentId: target.environmentId,
              threadId: target.threadId,
              projectId: target.projectId,
            });
          } else {
            toolResults.push({
              tool: "read_thread",
              ok: false,
              summary: loaded.error,
              environmentId: target.environmentId,
              threadId: target.threadId,
            });
          }
          break;
        }

        case "search_workspace": {
          const allProjects = allKnownProjects().filter((project) => !project.archived);
          const scopedProject = action.projectName
            ? yield* resolveProject(undefined, action.projectName)
            : undefined;
          const projectsToSearch = scopedProject ? [scopedProject] : allProjects;
          const projectTitleById = new Map(
            allProjects.map((project) => [project.id, project.title]),
          );
          const depth = action.depth ?? "quick";
          const found = yield* searchWorkspace({
            query: action.query,
            depth,
            projects: projectsToSearch,
            projectTitleById,
            threadManagement,
            fileSystem,
            path,
          });
          workspaceSearches.push(found);
          toolResults.push({
            tool: "search_workspace",
            ok: true,
            summary: `Searched workspace for "${action.query}" (${found.threadHits.length} thread hits, ${found.fileHits.length} file hits).`,
            environmentId: localEnvironmentId,
            ...(scopedProject ? { projectId: scopedProject.id } : {}),
          });
          break;
        }

        case "read_project_file": {
          const allProjects = allKnownProjects().filter((project) => !project.archived);
          let targetProject = action.projectName
            ? yield* resolveProject(undefined, action.projectName)
            : undefined;
          if (!targetProject && hydratedContext.activeThreadId) {
            const activeThread = hydratedContext.threads.find(
              (thread) => thread.threadId === hydratedContext.activeThreadId,
            );
            if (activeThread?.projectId) {
              targetProject = yield* resolveProject(activeThread.projectId, undefined);
            }
          }
          if (!targetProject && allProjects.length === 1) {
            targetProject = allProjects[0];
          }
          const candidateProjects = targetProject ? [targetProject] : allProjects;
          if (candidateProjects.length === 0) {
            toolResults.push({
              tool: "read_project_file",
              ok: false,
              summary: "No registered project is available to read files from.",
            });
            break;
          }

          let readOutcome:
            | { readonly ok: true; readonly result: SafeProjectFileResult }
            | { readonly ok: false; readonly error: string } = {
            ok: false,
            error: `File "${action.relativePath}" was not found.`,
          };
          for (const candidate of candidateProjects) {
            readOutcome = yield* readSafeProjectFile({
              project: candidate,
              relativePath: action.relativePath,
              maxChars: action.maxChars,
              fileSystem,
              path,
            });
            if (readOutcome.ok) break;
            // Stop immediately on security/traversal rejections rather than probing other projects.
            if (!readOutcome.error.includes("was not found")) break;
          }

          if (readOutcome.ok) {
            projectFileExcerpts.push(readOutcome.result);
            toolResults.push({
              tool: "read_project_file",
              ok: true,
              summary: `Read "${readOutcome.result.relativePath}" from ${readOutcome.result.projectTitle}.`,
              environmentId: localEnvironmentId,
              projectId: readOutcome.result.projectId,
            });
          } else {
            toolResults.push({
              tool: "read_project_file",
              ok: false,
              summary: readOutcome.error,
              environmentId: localEnvironmentId,
              ...(targetProject ? { projectId: targetProject.id } : {}),
            });
          }
          break;
        }

        case "interrupt_thread": {
          const target = yield* resolveThread(action.threadId, action.threadTitle);
          if (!target) {
            toolResults.push({
              tool: "interrupt_thread",
              ok: false,
              summary: `Could not find thread "${action.threadTitle ?? action.threadId ?? ""}".`,
            });
            break;
          }
          const commandId = CommandId.make(yield* newId("voice-thread-interrupt"));
          const stopped = yield* threadManagement
            .interruptThread({
              projectId: target.projectId,
              commandId,
              threadId: target.threadId,
              reason: "Interrupted by voice assistant",
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.message })),
            );
          toolResults.push(
            stopped.ok
              ? {
                  tool: "interrupt_thread",
                  ok: true,
                  summary:
                    stopped.result.type === "interrupt_requested"
                      ? `Stopped "${target.title}".`
                      : `"${target.title}" is not currently running.`,
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                }
              : {
                  tool: "interrupt_thread",
                  ok: false,
                  summary: stopped.error,
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                },
          );
          break;
        }

        case "organize_thread": {
          const target = yield* resolveThread(action.threadId, action.threadTitle);
          if (!target) {
            toolResults.push({
              tool: "organize_thread",
              ok: false,
              summary: `Could not find thread "${action.threadTitle ?? action.threadId ?? ""}".`,
            });
            break;
          }
          const commandId = CommandId.make(yield* newId("voice-thread-organize"));
          const runOrganize = (): Effect.Effect<void, { readonly message: string }> => {
            switch (action.operation) {
              case "settle":
                return threadManagement
                  .settleThread({ threadId: target.threadId, commandId, byOwnAgent: false })
                  .pipe(Effect.asVoid);
              case "unsettle":
                return threadManagement
                  .dispatch({
                    type: "thread.unsettle",
                    commandId,
                    threadId: target.threadId,
                    reason: "user",
                  })
                  .pipe(Effect.asVoid);
              case "archive":
                return threadManagement
                  .dispatch({ type: "thread.archive", commandId, threadId: target.threadId })
                  .pipe(Effect.asVoid);
              case "unarchive":
                return threadManagement
                  .dispatch({ type: "thread.unarchive", commandId, threadId: target.threadId })
                  .pipe(Effect.asVoid);
              case "pin":
                return threadManagement
                  .dispatch({ type: "thread.pin", commandId, threadId: target.threadId })
                  .pipe(Effect.asVoid);
              case "unpin":
                return threadManagement
                  .dispatch({ type: "thread.unpin", commandId, threadId: target.threadId })
                  .pipe(Effect.asVoid);
              case "snooze":
                return DateTime.now.pipe(
                  Effect.flatMap((now) =>
                    threadManagement.dispatch({
                      type: "thread.snooze",
                      commandId,
                      threadId: target.threadId,
                      snoozedUntil: DateTime.formatIso(
                        DateTime.add(now, {
                          minutes: Math.max(5, Math.round(action.snoozeMinutes ?? 60)),
                        }),
                      ),
                    }),
                  ),
                  Effect.asVoid,
                );
            }
          };
          const organized = yield* runOrganize().pipe(
            Effect.as({ ok: true as const }),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.message })),
          );
          toolResults.push(
            organized.ok
              ? {
                  tool: "organize_thread",
                  ok: true,
                  summary: `Applied ${action.operation} to "${target.title}".`,
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                }
              : {
                  tool: "organize_thread",
                  ok: false,
                  summary: organized.error,
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                },
          );
          break;
        }

        case "respond_approval": {
          const matchedApproval = matchPendingApproval(hydratedContext.pendingApprovals, {
            requestId: action.requestId,
            threadId: action.threadId,
            threadTitle: action.threadTitle,
          });
          const environmentId =
            action.environmentId ?? matchedApproval?.environmentId ?? localEnvironmentId;
          const threadId = action.threadId ?? matchedApproval?.threadId;
          const requestId = action.requestId ?? matchedApproval?.requestId;
          const threadLabel = matchedApproval?.threadTitle ?? action.threadTitle ?? "the thread";
          if (!threadId || !requestId) {
            toolResults.push({
              tool: "respond_approval",
              ok: false,
              summary: "Could not find a matching pending approval.",
            });
            break;
          }
          const isLocal = !environmentId || environmentId === localEnvironmentId;
          if (isLocal && typeof threadManagement.dispatch === "function") {
            const commandId = CommandId.make(yield* newId("voice-approval-respond"));
            const responded = yield* threadManagement
              .dispatch({
                type: "runtime-request.respond",
                commandId,
                threadId: ThreadId.make(threadId),
                requestId: RuntimeRequestId.make(requestId),
                decision: action.decision,
              })
              .pipe(
                Effect.as({ ok: true as const }),
                Effect.catch((error) =>
                  Effect.succeed({ ok: false as const, error: error.message }),
                ),
              );
            toolResults.push(
              responded.ok
                ? {
                    tool: "respond_approval",
                    ok: true,
                    summary: `Sent approval decision (${action.decision}) to "${threadLabel}".`,
                    environmentId: localEnvironmentId,
                    threadId,
                  }
                : {
                    tool: "respond_approval",
                    ok: false,
                    summary: responded.error,
                    environmentId: localEnvironmentId,
                    threadId,
                  },
            );
          } else {
            clientActions.push({
              type: "respond-approval",
              environmentId,
              threadId,
              requestId,
              decision: action.decision,
            });
            toolResults.push({
              tool: "respond_approval",
              ok: true,
              summary: `Forwarded approval decision (${action.decision}) for "${threadLabel}".`,
              environmentId,
              threadId,
            });
          }
          break;
        }

        case "respond_question": {
          const matchedQuestion = matchPendingQuestion(hydratedContext.pendingQuestions, {
            requestId: action.requestId,
            threadId: action.threadId,
            threadTitle: action.threadTitle,
          });
          const environmentId =
            action.environmentId ?? matchedQuestion?.environmentId ?? localEnvironmentId;
          const threadId = action.threadId ?? matchedQuestion?.threadId;
          const requestId = action.requestId ?? matchedQuestion?.requestId;
          const threadLabel = matchedQuestion?.threadTitle ?? action.threadTitle ?? "the thread";
          if (!threadId || !requestId) {
            toolResults.push({
              tool: "respond_question",
              ok: false,
              summary: "Could not find a matching pending question.",
            });
            break;
          }
          const resolvedAnswers = resolveQuestionAnswers(action.answers, matchedQuestion);
          if (Object.keys(resolvedAnswers).length === 0) {
            toolResults.push({
              tool: "respond_question",
              ok: false,
              summary: `No answer was provided for the pending question on "${threadLabel}".`,
              environmentId,
              threadId,
            });
            break;
          }
          const isLocal = !environmentId || environmentId === localEnvironmentId;
          if (isLocal && typeof threadManagement.dispatch === "function") {
            const commandId = CommandId.make(yield* newId("voice-question-respond"));
            const responded = yield* threadManagement
              .dispatch({
                type: "runtime-request.respond",
                commandId,
                threadId: ThreadId.make(threadId),
                requestId: RuntimeRequestId.make(requestId),
                answers: resolvedAnswers,
              })
              .pipe(
                Effect.as({ ok: true as const }),
                Effect.catch((error) =>
                  Effect.succeed({ ok: false as const, error: error.message }),
                ),
              );
            const answerSummary = Object.values(resolvedAnswers)
              .map((value) => (Array.isArray(value) ? value.join(", ") : value))
              .join("; ");
            toolResults.push(
              responded.ok
                ? {
                    tool: "respond_question",
                    ok: true,
                    summary: `Answered pending question on "${threadLabel}" with "${truncate(answerSummary, 100)}".`,
                    environmentId: localEnvironmentId,
                    threadId,
                  }
                : {
                    tool: "respond_question",
                    ok: false,
                    summary: responded.error,
                    environmentId: localEnvironmentId,
                    threadId,
                  },
            );
          } else {
            clientActions.push({
              type: "respond-question",
              environmentId,
              threadId,
              requestId,
              answers: resolvedAnswers,
            });
            toolResults.push({
              tool: "respond_question",
              ok: true,
              summary: `Forwarded answer for "${threadLabel}".`,
              environmentId,
              threadId,
            });
          }
          break;
        }

        case "dismiss_question": {
          const matchedQuestion = matchPendingQuestion(hydratedContext.pendingQuestions, {
            requestId: action.requestId,
            threadId: action.threadId,
            threadTitle: action.threadTitle,
          });
          const environmentId =
            action.environmentId ?? matchedQuestion?.environmentId ?? localEnvironmentId;
          const threadId = action.threadId ?? matchedQuestion?.threadId;
          const requestId = action.requestId ?? matchedQuestion?.requestId;
          const threadLabel = matchedQuestion?.threadTitle ?? action.threadTitle ?? "the thread";
          if (!threadId || !requestId) {
            toolResults.push({
              tool: "dismiss_question",
              ok: false,
              summary: "Could not find a matching pending question to dismiss.",
            });
            break;
          }
          const isLocal = !environmentId || environmentId === localEnvironmentId;
          if (isLocal && typeof threadManagement.dispatch === "function") {
            const commandId = CommandId.make(yield* newId("voice-question-dismiss"));
            const dismissed = yield* threadManagement
              .dispatch({
                type: "thread.user-input.dismiss",
                commandId,
                threadId: ThreadId.make(threadId),
                requestId: RuntimeRequestId.make(requestId),
              })
              .pipe(
                Effect.as({ ok: true as const }),
                Effect.catch((error) =>
                  // Live blocking questions reject `thread.user-input.dismiss` and cancel via `runtime-request.respond`.
                  error.message.includes("needs an answer")
                    ? newId("voice-question-cancel").pipe(
                        Effect.flatMap((cancelId) =>
                          threadManagement.dispatch({
                            type: "runtime-request.respond",
                            commandId: CommandId.make(cancelId),
                            threadId: ThreadId.make(threadId),
                            requestId: RuntimeRequestId.make(requestId),
                            decision: "cancel",
                          }),
                        ),
                        Effect.as({ ok: true as const }),
                        Effect.catch((cancelError) =>
                          Effect.succeed({ ok: false as const, error: cancelError.message }),
                        ),
                      )
                    : Effect.succeed({ ok: false as const, error: error.message }),
                ),
              );
            toolResults.push(
              dismissed.ok
                ? {
                    tool: "dismiss_question",
                    ok: true,
                    summary: `Dismissed pending question on "${threadLabel}".`,
                    environmentId: localEnvironmentId,
                    threadId,
                  }
                : {
                    tool: "dismiss_question",
                    ok: false,
                    summary: dismissed.error,
                    environmentId: localEnvironmentId,
                    threadId,
                  },
            );
          } else {
            clientActions.push({
              type: "dismiss-question",
              environmentId,
              threadId,
              requestId,
            });
            toolResults.push({
              tool: "dismiss_question",
              ok: true,
              summary: `Forwarded dismiss for "${threadLabel}".`,
              environmentId,
              threadId,
            });
          }
          break;
        }

        case "navigate_thread": {
          const target = yield* resolveThread(action.threadId, action.threadTitle);
          const environmentId = action.environmentId ?? target?.environmentId ?? defaultEnvId;
          const threadId = target?.threadId ?? action.threadId;
          if (environmentId && threadId) {
            clientActions.push({ type: "navigate-thread", environmentId, threadId });
          }
          break;
        }

        case "navigate_route": {
          clientActions.push({ type: "navigate-route", to: action.to });
          break;
        }

        case "insert_dictation": {
          clientActions.push({
            type: "insert-dictation",
            text: action.text,
            ...(action.autoSend !== undefined ? { autoSend: action.autoSend } : {}),
          });
          break;
        }

        case "focus_window": {
          clientActions.push({ type: "focus-window" });
          break;
        }
      }
    }

    let spokenReply = plan.spokenReply;
    let displayReply = plan.displayReply;
    let expectFollowUp = plan.expectFollowUp;

    if (hooks !== undefined && (toolResults.length > 0 || clientActions.length > 0)) {
      yield* hooks.onToolResults(toolResults, clientActions);
    }

    // One follow-up pass when read_thread, search_workspace, or read_project_file fetched detail
    // the initial plan could not see.
    if (
      readThreadExcerpts.length > 0 ||
      workspaceSearches.length > 0 ||
      projectFileExcerpts.length > 0
    ) {
      const followUpSpoken = spokenStreamer(
        planSpoken.spoken().length > 0 ? undefined : hooks,
        () => true,
      );
      const followUpRaw = yield* runLlm({
        systemPrompt: VOICE_ASSISTANT_SYSTEM_PROMPT,
        userPrompt: buildFollowUpSynthesisPrompt({
          utterance,
          threadExcerpts: readThreadExcerpts,
          workspaceSearches,
          projectFiles: projectFileExcerpts,
          otherToolResults: toolResults.filter(
            (result) =>
              result.tool !== "read_thread" &&
              result.tool !== "search_workspace" &&
              result.tool !== "read_project_file",
          ),
        }),
        expectJson: true,
        directTimeoutMs: DIRECT_TURN_TIMEOUT_MS,
        fallbackTimeoutMs: FALLBACK_TURN_TIMEOUT_MS,
        onText: followUpSpoken.onText,
      }).pipe(Effect.option);

      if (Option.isSome(followUpRaw)) {
        const followUpPlan = parseVoiceAssistantPlan(followUpRaw.value);
        if (followUpPlan.spokenReply) {
          spokenReply = followUpPlan.spokenReply;
          displayReply = followUpPlan.displayReply || followUpPlan.spokenReply;
          expectFollowUp = followUpPlan.expectFollowUp;
        }
      } else {
        const first = readThreadExcerpts[0];
        const latestMsg = first?.messages[first.messages.length - 1]?.text;
        if (first) {
          spokenReply = latestMsg
            ? sanitizeSpeechText(`${first.title} is ${first.status}. ${latestMsg}`, 280)
            : `${first.title} is currently ${first.status}.`;
          displayReply = spokenReply;
        } else if (workspaceSearches[0]) {
          const search = workspaceSearches[0];
          const topFile = search.fileHits[0];
          const topThread = search.threadHits[0];
          spokenReply = topFile
            ? sanitizeSpeechText(
                `I found matching details in ${topFile.projectTitle}. ${topFile.snippet}`,
                280,
              )
            : topThread
              ? sanitizeSpeechText(`I found a matching thread called ${topThread.title}.`, 240)
              : `I searched your workspace for ${search.query} but didn't find a strong match.`;
          displayReply = spokenReply;
        } else if (projectFileExcerpts[0]) {
          const file = projectFileExcerpts[0];
          spokenReply = sanitizeSpeechText(file.content, 280);
          displayReply = spokenReply;
        }
      }
    }

    const failedTools = toolResults.filter((result) => !result.ok);
    const succeededTools = toolResults.filter((result) => result.ok);
    if (failedTools.length > 0 && succeededTools.length === 0 && clientActions.length === 0) {
      const errorNote = sanitizeSpeechText(failedTools[0]?.summary ?? "That action failed.", 220);
      spokenReply = `I ran into a problem: ${errorNote}`;
      displayReply = failedTools.map((result) => result.summary).join(" ");
    }

    if (plan.route !== "dictation" && !spokenReply) {
      spokenReply =
        succeededTools.length > 0
          ? sanitizeSpeechText(succeededTools.map((result) => result.summary).join(" "), 260)
          : "Done.";
    }
    if (!displayReply) {
      displayReply = spokenReply || utterance;
    }

    return {
      route: plan.route,
      spokenReply,
      displayReply,
      expectFollowUp,
      toolResults,
      clientActions,
    } satisfies VoiceAssistantTurnResponse;
  });

  const handleTurn: VoiceAssistantService["Service"]["handleTurn"] = (req) =>
    runTurn(req, undefined);
  const streamTurn: VoiceAssistantService["Service"]["streamTurn"] = (req, hooks) =>
    runTurn(req, hooks);

  const generateBriefing: VoiceAssistantService["Service"]["generateBriefing"] = Effect.fn(
    "VoiceAssistantService.generateBriefing",
  )(function* (req) {
    const fallback = buildDeterministicBriefing(req);
    if (req.kind === "approval" || req.kind === "question") {
      return fallback;
    }

    const richSource = req.latestAssistantMessage?.trim() || req.detail?.trim() || "";
    if (richSource.length < 40) {
      return fallback;
    }

    const userPrompt = [
      `Event kind: ${req.kind}`,
      `Thread: ${req.threadTitle}`,
      ...(req.projectTitle ? [`Project: ${req.projectTitle}`] : []),
      ...(req.count && req.count > 1 ? [`Total threads in batch: ${req.count}`] : []),
      ...(req.extraTitles && req.extraTitles.length > 0
        ? [`Other threads: ${req.extraTitles.join(", ")}`]
        : []),
      ...(req.detail ? [`Detail: ${truncate(req.detail, 400)}`] : []),
      ...(req.latestAssistantMessage
        ? [`Latest assistant output:\n${truncate(req.latestAssistantMessage, 1400)}`]
        : []),
    ].join("\n");

    const condensed = yield* runLlm({
      systemPrompt: BRIEFING_SYSTEM_PROMPT,
      userPrompt,
      expectJson: false,
      directTimeoutMs: BRIEFING_LLM_TIMEOUT_MS,
      fallbackTimeoutMs: BRIEFING_LLM_TIMEOUT_MS,
    }).pipe(Effect.option);

    if (Option.isNone(condensed)) {
      return fallback;
    }
    const spokenText = sanitizeSpeechText(condensed.value, 320);
    if (!spokenText) {
      return fallback;
    }
    return {
      spokenText,
      shortLabel: fallback.shortLabel,
      expectFollowUp: req.kind === "failed" || spokenText.endsWith("?"),
    } satisfies VoiceBriefingResponse;
  });

  return VoiceAssistantService.of({ handleTurn, streamTurn, generateBriefing });
});

export const layer = Layer.effect(VoiceAssistantService, make);
