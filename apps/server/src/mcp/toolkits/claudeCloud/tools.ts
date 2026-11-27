import {
  CLAUDE_CLOUD_PROMPT_MAX_LENGTH,
  ClaudeCloudAccountStatus,
  ClaudeCloudDelegationMode,
  ClaudeCloudOffloadAdvice,
  ClaudeCloudOffloadPolicy,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ClaudeCloudService from "../../../cloud/ClaudeCloudService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Matter fork: listed only while the claude-cloud add-on is on and delegation is not off.

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ClaudeCloudService.ClaudeCloudService,
  ],
};

const Prompt = TrimmedNonEmptyString.check(Schema.isMaxLength(CLAUDE_CLOUD_PROMPT_MAX_LENGTH));
const SessionRef = TrimmedNonEmptyString.annotate({
  description: "A cse_… or session_… id, or its claude.ai/code link.",
});

const SessionSummary = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.String,
  teleportedThreadId: Schema.NullOr(ThreadId),
});

const StatusTool = Tool.make("claude_cloud_status", {
  ...shared,
  description:
    "Whether heavy work should run on Claude Cloud right now (`advice.level` with reasons such as battery, heat or usage left), the user's offload policy and rules, Claude accounts, and tracked cloud sessions. Defaults to this thread's checkout. `refresh` rechecks account logins.",
  parameters: Schema.Struct({
    projectId: Schema.optionalKey(ProjectId),
    refresh: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    advice: ClaudeCloudOffloadAdvice,
    offloadPolicy: ClaudeCloudOffloadPolicy,
    agentDelegationMode: ClaudeCloudDelegationMode,
    delegationRules: Schema.String,
    accounts: Schema.Array(ClaudeCloudAccountStatus),
    sessions: Schema.Array(SessionSummary),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const LaunchTool = Tool.make("claude_cloud_launch", {
  ...shared,
  description:
    "Start a Claude Cloud session on this thread's pushed branch with `prompt` as its task. Runs on the user's claude.ai plan while this machine is free. `pushFirst` pushes unpushed commits; uncommitted changes never reach it. Follow the user's delegation rules and say why in `reason`.",
  parameters: Schema.Struct({
    prompt: Prompt,
    title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    projectId: Schema.optionalKey(ProjectId),
    instanceId: Schema.optionalKey(ProviderInstanceId),
    pushFirst: Schema.optionalKey(Schema.Boolean),
    userApproved: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Ask-first mode: true only after the user agreed." }),
    ),
    reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  }),
  success: Schema.Struct({
    sessionId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    branch: Schema.NullOr(Schema.String),
    pushed: Schema.Boolean,
    warnings: Schema.Array(Schema.String),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const SendTool = Tool.make("claude_cloud_send", {
  ...shared,
  description: "Send a follow-up message to a Claude Cloud session and return its reply.",
  parameters: Schema.Struct({ sessionId: SessionRef, prompt: Prompt }),
  success: Schema.Struct({ sessionId: Schema.String, reply: Schema.NullOr(Schema.String) }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const TeleportTool = Tool.make("claude_cloud_teleport", {
  ...shared,
  description:
    "Pull a Claude Cloud session into a fresh local worktree on its branch and open it as a Matter thread. Returns the worktree path and thread link.",
  parameters: Schema.Struct({
    sessionId: SessionRef,
    projectId: Schema.optionalKey(ProjectId),
    prompt: Schema.optionalKey(Prompt),
  }),
  success: Schema.Struct({
    sessionId: Schema.String,
    worktreePath: Schema.String,
    branch: Schema.NullOr(Schema.String),
    threadId: Schema.NullOr(ThreadId),
    threadLink: Schema.NullOr(Schema.String),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const ClaudeCloudToolkit = Toolkit.make(StatusTool, LaunchTool, SendTool, TeleportTool);
