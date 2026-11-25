import {
  CommandId,
  MessageId,
  ProjectId,
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
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type {
  VoiceAssistantClientAction,
  VoiceAssistantToolResult,
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceBriefingRequest,
  VoiceBriefingResponse,
  VoiceWorkspaceProjectSummary,
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
import { sanitizeSpeechText } from "./VoiceTtsService.ts";

const DIRECT_TURN_TIMEOUT_MS = 15_000;
const FALLBACK_TURN_TIMEOUT_MS = 25_000;
const BRIEFING_LLM_TIMEOUT_MS = 4_000;
const ANTHROPIC_API_VERSION = "2023-06-01";

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
      readonly requestId?: string | undefined;
      readonly decision: "accept" | "acceptAlways" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      readonly type: "respond_question";
      readonly environmentId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly answers: Record<string, string | ReadonlyArray<string>>;
    }
  | {
      readonly type: "dismiss_question";
      readonly environmentId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly requestId?: string | undefined;
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
    readonly generateBriefing: (req: VoiceBriefingRequest) => Effect.Effect<VoiceBriefingResponse>;
  }
>()("t3/voiceAssistant/VoiceAssistantService") {}

const VOICE_ASSISTANT_SYSTEM_PROMPT = `You are mattr, a warm, sharp conversational voice engineering co-pilot built directly into the user's coding agent workspace.

Your replies are SPOKEN ALOUD through natural neural TTS (often while the user is driving, walking, or talking hands-free on desktop or phone).

CRITICAL VOICE RULES:
- spokenReply MUST sound like a real human engineer riding shotgun: warm, natural, crisp spoken English with contractions ("I'm", "it's", "you've") and smooth transitions.
- Keep spokenReply to 1 to 3 short sentences. Zero markdown, zero backticks, zero bullet lists, zero URLs, zero raw file paths or UUIDs read out loud.
- Never sound robotic: never say "As an AI", "I have executed the tool", "Action completed successfully", or narrate JSON/tool names. Speak naturally about what you did or found.
- In mode="voice-mode", be genuinely conversational and proactive like a trusted co-pilot (for example: "Hey! Two threads are humming along right now. The auth refactor is almost done, and the iOS build is waiting on a quick command approval. Want me to approve it?").
- Conversational greetings, casual banter, brainstorming, open-ended engineering questions, and quick status check-ins work naturally with actions: [] and route: "assistant". Answer warmly and keep the conversation flowing.
- displayReply is a concise 1 to 2 line plain-text summary for the UI card (also zero markdown).
- Set expectFollowUp to true when you ask a question, offer a next step, need clarification, or expect a natural back-and-forth; false when the user is clearly wrapping up or a one-shot action is complete.

ROUTING MODES:
- mode="voice-mode" or mode="assistant": treat every utterance as a live conversation or workspace command for mattr.
- mode="smart": if context.composerFocused is true AND the utterance sounds like prompt text to type into the active thread (not a command to mattr, not asking about workspace status, not answering an approval/question, not navigating), choose route="dictation" with action { "type": "insert_dictation", "text": "<cleaned text>", "autoSend": false } and empty spokenReply "". Otherwise handle as assistant/approval/question/direct-reply.
- If there are pending approvals and the user says approve / yes / allow / always allow / deny / reject / cancel, use route="approval" with respond_approval.
- If there are pending questions and the user answers one, use route="question" with respond_question.
- If the user asks to tell or reply to a specific thread (or the active thread), use route="direct-reply" with send_to_thread.

AVAILABLE ACTIONS (return an array in "actions"):
1. { "type": "create_project", "title": "Project Name", "workspaceRoot": "/optional/path" }
   - Omit workspaceRoot to create a brand-new managed git project from title.
2. { "type": "launch_thread", "projectId": "optional-id", "projectName": "optional-name", "prompt": "task prompt", "title": "optional short title", "useWorktree": true }
   - If you emit create_project followed by one or more launch_thread actions in the same turn, set projectName to the new project's title (or omit projectId) and mattr automatically links the newly created projectId!
3. { "type": "send_to_thread", "threadId": "optional-id", "threadTitle": "optional-title", "text": "message to send", "dispatchMode": "auto" | "steer" | "queue" }
4. { "type": "read_thread", "threadId": "optional-id", "threadTitle": "optional-title" }
   - Use when the user asks what a thread is doing or found and the context summary is insufficient. mattr will fetch the recent messages and ask you to summarize them in a follow-up pass.
5. { "type": "interrupt_thread", "threadId": "optional-id", "threadTitle": "optional-title" }
6. { "type": "organize_thread", "threadId": "optional-id", "threadTitle": "optional-title", "operation": "settle" | "unsettle" | "archive" | "unarchive" | "pin" | "unpin" | "snooze", "snoozeMinutes": 60 }
7. { "type": "respond_approval", "environmentId": "...", "threadId": "...", "requestId": "...", "decision": "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel" }
8. { "type": "respond_question", "environmentId": "...", "threadId": "...", "requestId": "...", "answers": { "<questionId>": "<answer>" } }
9. { "type": "dismiss_question", "environmentId": "...", "threadId": "...", "requestId": "..." }
10. { "type": "navigate_thread", "environmentId": "...", "threadId": "...", "threadTitle": "optional" }
11. { "type": "navigate_route", "to": "/settings" }
12. { "type": "insert_dictation", "text": "...", "autoSend": false }
13. { "type": "focus_window" }

OUTPUT FORMAT:
Return ONLY valid JSON matching:
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
      .slice(0, 25)
      .map((project) => ({
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
    threads: req.context.threads.slice(0, 25).map((thread) => ({
      environmentId: thread.environmentId,
      threadId: thread.threadId,
      title: thread.title,
      projectId: thread.projectId,
      projectTitle: thread.projectTitle,
      status: thread.status,
      isActive: thread.isActive ?? false,
      latestUserMessage: truncate(thread.latestUserMessage, 140) || null,
      latestAssistantMessage: truncate(thread.latestAssistantMessage, 220) || null,
    })),
    pendingApprovals: req.context.pendingApprovals.slice(0, 10).map((approval) => ({
      environmentId: approval.environmentId,
      threadId: approval.threadId,
      threadTitle: approval.threadTitle,
      requestId: approval.requestId,
      requestKind: approval.requestKind,
      title: approval.title,
      detail: truncate(approval.detail, 140) || null,
      reason: truncate(approval.reason, 140) || null,
    })),
    pendingQuestions: req.context.pendingQuestions.slice(0, 10).map((question) => ({
      environmentId: question.environmentId,
      threadId: question.threadId,
      threadTitle: question.threadTitle,
      requestId: question.requestId,
      questions: question.questions.map((entry) => ({
        id: entry.id,
        header: entry.header,
        question: entry.question,
        options: entry.options,
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

function buildReadThreadSynthesisPrompt(input: {
  readonly utterance: string;
  readonly excerpts: ReadonlyArray<{
    readonly threadId: string;
    readonly title: string;
    readonly status: string;
    readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  }>;
  readonly otherToolResults: ReadonlyArray<VoiceAssistantToolResult>;
}): string {
  return [
    `The user asked: "${input.utterance}"`,
    "",
    "Here are the recent messages read from the requested thread(s):",
    JSON.stringify(input.excerpts, null, 2),
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
    'Now return ONLY JSON with { "route": "assistant", "actions": [], "spokenReply": "...", "displayReply": "...", "expectFollowUp": true|false } summarizing what is happening in natural spoken English (1-3 short sentences, zero markdown or raw paths).',
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
        requestId: normalizeString(record.requestId),
        decision: normalizeDecision(record.decision),
      };
    }
    case "respond_question": {
      return {
        type: "respond_question",
        environmentId: normalizeString(record.environmentId),
        threadId: normalizeString(record.threadId),
        requestId: normalizeString(record.requestId),
        answers: normalizeAnswers(record.answers),
      };
    }
    case "dismiss_question": {
      return {
        type: "dismiss_question",
        environmentId: normalizeString(record.environmentId),
        threadId: normalizeString(record.threadId),
        requestId: normalizeString(record.requestId),
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

function parseVoiceAssistantPlan(rawText: string): VoiceAssistantPlan {
  const trimmed = rawText.trim();
  try {
    const extracted = extractJsonObject(trimmed);
    const parsed: unknown = JSON.parse(extracted);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const route = normalizeRoute(record.route);
      const rawActions = Array.isArray(record.actions) ? record.actions : [];
      const actions = rawActions
        .map(parsePlannedAction)
        .filter((action): action is VoicePlannedAction => action !== null);
      const rawSpoken = typeof record.spokenReply === "string" ? record.spokenReply : "";
      const spokenReply = route === "dictation" ? "" : sanitizeSpeechText(rawSpoken, 600);
      const displayReply =
        normalizeString(record.displayReply) ??
        (spokenReply || (route === "dictation" ? "" : "Done."));
      const expectFollowUp = Boolean(record.expectFollowUp);
      return { route, actions, spokenReply, displayReply, expectFollowUp };
    }
  } catch {
    // Plain-text reply from a fallback model is still usable as a spoken reply.
  }
  const fallbackSpoken = sanitizeSpeechText(trimmed, 600) || "Done.";
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

interface DirectLlmTarget {
  readonly kind: "openaiCompatible" | "anthropic";
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
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
            model: "openai/gpt-4o-mini",
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
      request = HttpClientRequest.post(`${target.baseUrl}/chat/completions`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          model: target.model,
          temperature: 0.2,
          max_tokens: 1024,
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
  }) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new VoiceAssistantLlmError({ stage: "text-generation", cause })),
    );
    const directTarget = yield* resolveDirectLlmTarget(settings);
    if (directTarget !== null) {
      const directResult = yield* callDirectLlm(directTarget, {
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        expectJson: input.expectJson,
        timeoutMs: input.directTimeoutMs,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Direct voice assistant LLM failed; falling back to TextGeneration.", {
            cause,
          }),
        ),
        Effect.option,
      );
      if (Option.isSome(directResult)) return directResult.value;
    }
    return yield* callFallbackTextGeneration(settings, {
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      expectJson: input.expectJson,
      timeoutMs: input.fallbackTimeoutMs,
    });
  });

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

  const handleTurn: VoiceAssistantService["Service"]["handleTurn"] = Effect.fn(
    "VoiceAssistantService.handleTurn",
  )(function* (req) {
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

    const rawPlanText = yield* runLlm({
      systemPrompt: VOICE_ASSISTANT_SYSTEM_PROMPT,
      userPrompt: buildTurnUserPrompt(req),
      expectJson: true,
      directTimeoutMs: DIRECT_TURN_TIMEOUT_MS,
      fallbackTimeoutMs: FALLBACK_TURN_TIMEOUT_MS,
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
    const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    const defaultEnvId = req.context.activeEnvironmentId ?? localEnvironmentId;

    const toolResults: Array<VoiceAssistantToolResult> = [];
    const clientActions: Array<VoiceAssistantClientAction> = [];
    const createdProjects: Array<VoiceWorkspaceProjectSummary> = [];
    const launchedThreads: Array<VoiceWorkspaceThreadSummary> = [];
    const readThreadExcerpts: Array<{
      readonly threadId: string;
      readonly title: string;
      readonly status: string;
      readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
    }> = [];

    const allKnownProjects = () => [...createdProjects, ...req.context.projects];
    const allKnownThreads = () => [...launchedThreads, ...req.context.threads];

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
        req.context.activeThreadId,
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
            const activeThread = req.context.activeThreadId
              ? req.context.threads.find((thread) => thread.threadId === req.context.activeThreadId)
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
            const messages = loaded.projection.messages.slice(-6).map((message) => ({
              role: message.role,
              text: truncate(message.text, 600),
            }));
            readThreadExcerpts.push({
              threadId: target.threadId,
              title: loaded.projection.thread.title,
              status: latest?.status ?? "idle",
              messages,
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
          const matchedApproval =
            (action.requestId
              ? req.context.pendingApprovals.find((entry) => entry.requestId === action.requestId)
              : undefined) ??
            (action.threadId
              ? req.context.pendingApprovals.find((entry) => entry.threadId === action.threadId)
              : undefined) ??
            req.context.pendingApprovals[0];
          const environmentId = action.environmentId ?? matchedApproval?.environmentId;
          const threadId = action.threadId ?? matchedApproval?.threadId;
          const requestId = action.requestId ?? matchedApproval?.requestId;
          if (environmentId && threadId && requestId) {
            clientActions.push({
              type: "respond-approval",
              environmentId,
              threadId,
              requestId,
              decision: action.decision,
            });
          }
          break;
        }

        case "respond_question": {
          const matchedQuestion =
            (action.requestId
              ? req.context.pendingQuestions.find((entry) => entry.requestId === action.requestId)
              : undefined) ??
            (action.threadId
              ? req.context.pendingQuestions.find((entry) => entry.threadId === action.threadId)
              : undefined) ??
            req.context.pendingQuestions[0];
          const environmentId = action.environmentId ?? matchedQuestion?.environmentId;
          const threadId = action.threadId ?? matchedQuestion?.threadId;
          const requestId = action.requestId ?? matchedQuestion?.requestId;
          if (environmentId && threadId && requestId) {
            clientActions.push({
              type: "respond-question",
              environmentId,
              threadId,
              requestId,
              answers: action.answers,
            });
          }
          break;
        }

        case "dismiss_question": {
          const matchedQuestion =
            (action.requestId
              ? req.context.pendingQuestions.find((entry) => entry.requestId === action.requestId)
              : undefined) ??
            (action.threadId
              ? req.context.pendingQuestions.find((entry) => entry.threadId === action.threadId)
              : undefined) ??
            req.context.pendingQuestions[0];
          const environmentId = action.environmentId ?? matchedQuestion?.environmentId;
          const threadId = action.threadId ?? matchedQuestion?.threadId;
          const requestId = action.requestId ?? matchedQuestion?.requestId;
          if (environmentId && threadId && requestId) {
            clientActions.push({
              type: "dismiss-question",
              environmentId,
              threadId,
              requestId,
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

    // One follow-up pass when read_thread fetched detail the initial plan could not see.
    if (readThreadExcerpts.length > 0) {
      const followUpRaw = yield* runLlm({
        systemPrompt: VOICE_ASSISTANT_SYSTEM_PROMPT,
        userPrompt: buildReadThreadSynthesisPrompt({
          utterance,
          excerpts: readThreadExcerpts,
          otherToolResults: toolResults.filter((result) => result.tool !== "read_thread"),
        }),
        expectJson: true,
        directTimeoutMs: DIRECT_TURN_TIMEOUT_MS,
        fallbackTimeoutMs: FALLBACK_TURN_TIMEOUT_MS,
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

  return VoiceAssistantService.of({ handleTurn, generateBriefing });
});

export const layer = Layer.effect(VoiceAssistantService, make);
