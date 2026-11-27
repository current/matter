import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { AddonConfig } from "./matterAddons.ts";
import { OrchestrationV2TurnItem } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Matter's Claude Cloud add-on: start Anthropic-managed cloud sessions with the user's own
 * claude.ai subscription, message them, and teleport them into local worktree threads.
 * Settings live in the add-on's non-secret config; tracked sessions in `claude-cloud-sessions.json`.
 */

export const CLAUDE_CLOUD_ADDON_ID = "claude-cloud";

/** How agents may use the add-on: never, after asking the user, or on their own. */
export const ClaudeCloudDelegationMode = Schema.Literals(["off", "ask", "auto"]);
export type ClaudeCloudDelegationMode = typeof ClaudeCloudDelegationMode.Type;

const CLAUDE_CLOUD_DEFAULT_DELEGATION_MODE: ClaudeCloudDelegationMode = "auto";
export const CLAUDE_CLOUD_DELEGATION_RULES_MAX_LENGTH = 2_000;
export const CLAUDE_CLOUD_PROMPT_MAX_LENGTH = 20_000;

/** Keys stay clear of `ADDON_SECRET_CONFIG_KEY_PATTERN`; nothing here is a credential. */
export const ClaudeCloudAddonSettings = Schema.Struct({
  /** Claude instance whose claude.ai login runs cloud sessions; null picks the first ready one. */
  defaultInstanceId: Schema.NullOr(ProviderInstanceId),
  agentDelegationMode: ClaudeCloudDelegationMode,
  /** Free-form rules from the user that agents follow before offloading. */
  delegationRules: Schema.String.check(
    Schema.isMaxLength(CLAUDE_CLOUD_DELEGATION_RULES_MAX_LENGTH),
  ),
  /** Push unpushed commits before launching, since the cloud VM clones from GitHub. */
  autoPushBeforeLaunch: Schema.Boolean,
});
export type ClaudeCloudAddonSettings = typeof ClaudeCloudAddonSettings.Type;

export const CLAUDE_CLOUD_DEFAULT_SETTINGS: ClaudeCloudAddonSettings = {
  defaultInstanceId: null,
  agentDelegationMode: CLAUDE_CLOUD_DEFAULT_DELEGATION_MODE,
  delegationRules: "",
  autoPushBeforeLaunch: false,
};

export const ClaudeCloudSettingsPatch = Schema.Struct({
  defaultInstanceId: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  agentDelegationMode: Schema.optionalKey(ClaudeCloudDelegationMode),
  delegationRules: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(CLAUDE_CLOUD_DELEGATION_RULES_MAX_LENGTH)),
  ),
  autoPushBeforeLaunch: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeCloudSettingsPatch = typeof ClaudeCloudSettingsPatch.Type;

const DELEGATION_MODES: ReadonlyArray<string> = ClaudeCloudDelegationMode.literals;
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Reads settings from stored add-on config, keeping defaults for anything missing or invalid. */
export function claudeCloudSettingsFromConfig(config: AddonConfig): ClaudeCloudAddonSettings {
  const instance = config.defaultInstanceId;
  const mode = config.agentDelegationMode;
  const rules = config.delegationRules;
  return {
    defaultInstanceId:
      typeof instance === "string" && INSTANCE_ID_PATTERN.test(instance)
        ? ProviderInstanceId.make(instance)
        : null,
    agentDelegationMode:
      typeof mode === "string" && DELEGATION_MODES.includes(mode)
        ? (mode as ClaudeCloudDelegationMode)
        : CLAUDE_CLOUD_DEFAULT_DELEGATION_MODE,
    delegationRules:
      typeof rules === "string" ? rules.slice(0, CLAUDE_CLOUD_DELEGATION_RULES_MAX_LENGTH) : "",
    autoPushBeforeLaunch: config.autoPushBeforeLaunch === true,
  };
}

/** `cse_…` (CCR v2) and `session_…` (CCR v1) ids, as the CLI and claude.ai print them. */
export const ClaudeCloudSessionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:cse|session)_[A-Za-z0-9_-]{4,200}$/),
);
export type ClaudeCloudSessionId = typeof ClaudeCloudSessionId.Type;

const SESSION_ID_PATTERN = /^(?:cse|session)_[A-Za-z0-9_-]{4,200}$/;
const SESSION_URL_PATTERN =
  /^https:\/\/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9_-]{4,200})(?:[/?#].*)?$/;

export function claudeCloudSessionUrl(id: string): string {
  return `https://claude.ai/code/${id}`;
}

/** A session id from an id or a `claude.ai/code/…` link, or null when it is neither. */
export function parseClaudeCloudSessionRef(input: string): string | null {
  const trimmed = input.trim();
  if (SESSION_ID_PATTERN.test(trimmed)) return trimmed;
  return SESSION_URL_PATTERN.exec(trimmed)?.[1] ?? null;
}

/**
 * The note agents see while the add-on is on and delegation is not off. Empty otherwise, so the
 * add-on costs no context when unused.
 */
export function claudeCloudAgentInstructions(settings: ClaudeCloudAddonSettings): string {
  if (settings.agentDelegationMode === "off") return "";
  const consent =
    settings.agentDelegationMode === "ask"
      ? "Ask the user first and pass `userApproved: true` only after they agree."
      : "You may offload without asking when it clearly helps.";
  const rules = settings.delegationRules.trim().replaceAll(/\s+/g, " ");
  return [
    "<claude_cloud>",
    `Heavy work (long test suites, big builds or refactors) can run on Claude Cloud: \`claude_cloud_launch\` starts a cloud session on the pushed branch, \`claude_cloud_send\` messages it, \`claude_cloud_teleport\` pulls it into a local worktree thread. ${consent}`,
    ...(rules === "" ? [] : [`The user's delegation rules: ${rules}`]),
    "</claude_cloud>",
  ].join("\n");
}

export const ClaudeCloudAccountProblem = Schema.Literals([
  "signed_out",
  "api_key_auth",
  "not_claude_ai",
  "cli_unavailable",
  "error",
]);
export type ClaudeCloudAccountProblem = typeof ClaudeCloudAccountProblem.Type;

/** One Claude instance's readiness for cloud sessions. Never carries credentials. */
export const ClaudeCloudAccountStatus = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.String,
  ready: Schema.Boolean,
  problem: Schema.optionalKey(ClaudeCloudAccountProblem),
  detail: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  planTier: Schema.optionalKey(Schema.String),
  checkedAt: Schema.String,
});
export type ClaudeCloudAccountStatus = typeof ClaudeCloudAccountStatus.Type;

export const ClaudeCloudCreatedBy = Schema.Literals(["user", "agent"]);
export type ClaudeCloudCreatedBy = typeof ClaudeCloudCreatedBy.Type;

/** What Matter remembers about a cloud session. Public ids, links and titles only. */
export const TrackedClaudeCloudSession = Schema.Struct({
  id: ClaudeCloudSessionId,
  url: Schema.String,
  title: Schema.String,
  promptPreview: Schema.String,
  instanceId: ProviderInstanceId,
  projectId: Schema.NullOr(ProjectId),
  cwd: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  createdBy: ClaudeCloudCreatedBy,
  sourceThreadId: Schema.NullOr(ThreadId),
  /** Why an agent offloaded it, checked against the user's delegation rules. */
  reason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastMessageAt: Schema.NullOr(Schema.String),
  lastReplyPreview: Schema.NullOr(Schema.String),
  teleportedThreadId: Schema.NullOr(ThreadId),
  teleportedWorktreePath: Schema.NullOr(Schema.String),
});
export type TrackedClaudeCloudSession = typeof TrackedClaudeCloudSession.Type;

export const ClaudeCloudInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.String,
});
export type ClaudeCloudInstance = typeof ClaudeCloudInstance.Type;

export const ClaudeCloudStatus = Schema.Struct({
  enabled: Schema.Boolean,
  settings: ClaudeCloudAddonSettings,
  /** Claude instances that could run cloud sessions, from settings alone. */
  instances: Schema.Array(ClaudeCloudInstance),
  /** Last readiness check per Claude instance; empty until one runs. */
  accounts: Schema.Array(ClaudeCloudAccountStatus),
  sessions: Schema.Array(TrackedClaudeCloudSession),
});
export type ClaudeCloudStatus = typeof ClaudeCloudStatus.Type;

const Prompt = TrimmedNonEmptyString.check(Schema.isMaxLength(CLAUDE_CLOUD_PROMPT_MAX_LENGTH));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const SessionRef = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const ClaudeCloudEligibilityRequest = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  projectId: Schema.optionalKey(ProjectId),
});
export type ClaudeCloudEligibilityRequest = typeof ClaudeCloudEligibilityRequest.Type;

export const ClaudeCloudRepositoryState = Schema.Struct({
  cwd: Schema.String,
  githubRemote: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  hasUpstream: Schema.Boolean,
  aheadCount: Schema.Number,
  dirty: Schema.Boolean,
});
export type ClaudeCloudRepositoryState = typeof ClaudeCloudRepositoryState.Type;

export const ClaudeCloudBlocker = Schema.Literals([
  "account_not_ready",
  "no_project",
  "no_github_remote",
  "detached_head",
  "unpushed_commits",
]);
export type ClaudeCloudBlocker = typeof ClaudeCloudBlocker.Type;

export const ClaudeCloudEligibility = Schema.Struct({
  account: ClaudeCloudAccountStatus,
  repository: Schema.NullOr(ClaudeCloudRepositoryState),
  /** Launch-blocking problems. `unpushed_commits` clears with `pushFirst` or auto-push. */
  blockers: Schema.Array(ClaudeCloudBlocker),
  /** Uncommitted changes stay local; the cloud VM never sees them. */
  warnings: Schema.Array(Schema.String),
});
export type ClaudeCloudEligibility = typeof ClaudeCloudEligibility.Type;

export const ClaudeCloudLaunchRequest = Schema.Struct({
  prompt: Prompt,
  title: Schema.optionalKey(Title),
  instanceId: Schema.optionalKey(ProviderInstanceId),
  projectId: Schema.optionalKey(ProjectId),
  /** Push the current branch first when it has unpushed commits. */
  pushFirst: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeCloudLaunchRequest = typeof ClaudeCloudLaunchRequest.Type;

export const ClaudeCloudLaunchResult = Schema.Struct({
  session: TrackedClaudeCloudSession,
  pushed: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
});
export type ClaudeCloudLaunchResult = typeof ClaudeCloudLaunchResult.Type;

export const ClaudeCloudFollowUpRequest = Schema.Struct({
  /** A session id or its claude.ai link. */
  sessionId: SessionRef,
  prompt: Prompt,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ClaudeCloudFollowUpRequest = typeof ClaudeCloudFollowUpRequest.Type;

export const ClaudeCloudFollowUpResult = Schema.Struct({
  sessionId: ClaudeCloudSessionId,
  reply: Schema.NullOr(Schema.String),
});
export type ClaudeCloudFollowUpResult = typeof ClaudeCloudFollowUpResult.Type;

export const ClaudeCloudTeleportRequest = Schema.Struct({
  sessionId: SessionRef,
  projectId: ProjectId,
  instanceId: Schema.optionalKey(ProviderInstanceId),
  /** The first message in the local session; a short status request by default. */
  prompt: Schema.optionalKey(Prompt),
});
export type ClaudeCloudTeleportRequest = typeof ClaudeCloudTeleportRequest.Type;

export const ClaudeCloudTeleportResult = Schema.Struct({
  sessionId: ClaudeCloudSessionId,
  worktreePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** The Matter thread holding the teleported session, once imported. */
  threadId: Schema.NullOr(ThreadId),
});
export type ClaudeCloudTeleportResult = typeof ClaudeCloudTeleportResult.Type;

/**
 * Where a cloud session stands. Read from Claude's sessions API (`session_status`, the post-turn
 * summary and the newest transcript events), never guessed from what Matter sent.
 */
export const ClaudeCloudSessionState = Schema.Literals([
  "running",
  "idle",
  "needs_input",
  "failed",
  "archived",
]);
export type ClaudeCloudSessionState = typeof ClaudeCloudSessionState.Type;

/**
 * A cloud session as the claude.ai account sees it, including ones started in the Claude app or
 * on claude.ai. `tracked` is Matter's own record when Matter launched or messaged it.
 */
export const ClaudeCloudRemoteSession = Schema.Struct({
  id: ClaudeCloudSessionId,
  url: Schema.String,
  title: Schema.String,
  /** The Claude instance whose sign-in reads and messages this session. */
  instanceId: ProviderInstanceId,
  state: ClaudeCloudSessionState,
  unread: Schema.Boolean,
  /** Where it was started, as the API reports it (`cli`, `desktop_app`, `web`, …). */
  origin: Schema.NullOr(Schema.String),
  /** `owner/repo` of the session's GitHub source. */
  repository: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** One line on where the last turn left off. */
  summary: Schema.NullOr(Schema.String),
  /** What the session needs from the user, when it waits on them. */
  needsAction: Schema.NullOr(Schema.String),
  contextUsage: Schema.NullOr(
    Schema.Struct({ usedTokens: NonNegativeInt, maxTokens: NonNegativeInt }),
  ),
  tracked: Schema.NullOr(TrackedClaudeCloudSession),
});
export type ClaudeCloudRemoteSession = typeof ClaudeCloudRemoteSession.Type;

export const ClaudeCloudAccountProblemNote = Schema.Struct({
  instanceId: ProviderInstanceId,
  detail: Schema.String,
});
export type ClaudeCloudAccountProblemNote = typeof ClaudeCloudAccountProblemNote.Type;

export const ClaudeCloudRemoteSessionsResponse = Schema.Struct({
  /** Newest activity first; archived sessions only when asked for. */
  sessions: Schema.Array(ClaudeCloudRemoteSession),
  /** Accounts whose list could not be read. Their tracked sessions still appear. */
  problems: Schema.Array(ClaudeCloudAccountProblemNote),
});
export type ClaudeCloudRemoteSessionsResponse = typeof ClaudeCloudRemoteSessionsResponse.Type;

/** Something the session waits on. Answering it happens on claude.ai or in the Claude app. */
export const ClaudeCloudPendingRequest = Schema.Struct({
  kind: Schema.Literals(["permission", "question", "plan"]),
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
});
export type ClaudeCloudPendingRequest = typeof ClaudeCloudPendingRequest.Type;

/**
 * A session's transcript as Matter turn items, so it renders through the same timeline as a
 * local thread. Items carry `threadId` `claude-cloud:<sessionId>` and no run, node or provider ids.
 */
export const ClaudeCloudTranscriptResponse = Schema.Struct({
  session: ClaudeCloudRemoteSession,
  /** Pass back as `sinceRev` to receive only items added or changed after it. */
  rev: NonNegativeInt,
  /** `turnItems` is the whole transcript (first load, or the server lost the client's rev). */
  full: Schema.Boolean,
  turnItems: Schema.Array(OrchestrationV2TurnItem),
  pendingRequest: Schema.NullOr(ClaudeCloudPendingRequest),
  canInterrupt: Schema.Boolean,
});
export type ClaudeCloudTranscriptResponse = typeof ClaudeCloudTranscriptResponse.Type;

export const ClaudeCloudInterruptRequest = Schema.Struct({
  sessionId: SessionRef,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ClaudeCloudInterruptRequest = typeof ClaudeCloudInterruptRequest.Type;

export const CLAUDE_CLOUD_THREAD_ID_PREFIX = "claude-cloud:";

export const ClaudeCloudErrorCode = Schema.Literals([
  "addon_disabled",
  "delegation_off",
  "approval_required",
  "reason_required",
  "invalid_request",
  "account_not_ready",
  "project_not_found",
  "not_eligible",
  "not_found",
  "cli_failed",
  "launch_timeout",
  "teleport_failed",
  /** The sessions API refused or could not be reached; sends through the CLI may still work. */
  "api_unavailable",
  "interrupt_unsupported",
]);
export type ClaudeCloudErrorCode = typeof ClaudeCloudErrorCode.Type;
