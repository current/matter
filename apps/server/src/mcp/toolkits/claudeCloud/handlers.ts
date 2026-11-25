import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ClaudeCloudService from "../../../cloud/ClaudeCloudService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { ClaudeCloudToolkit } from "./tools.ts";

const toFailure = (error: ClaudeCloudService.ClaudeCloudError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "addon_disabled" ||
      error.code === "delegation_off" ||
      error.code === "approval_required"
        ? "capability_denied"
        : error.code === "cli_failed" ||
            error.code === "launch_timeout" ||
            error.code === "teleport_failed"
          ? "provider_unavailable"
          : "invalid_request",
    message: error.message,
  });

const DELEGATION_OFF =
  "The user turned off agent delegation to Claude Cloud in Settings → Add-ons. Run the work locally.";

/** Refuses every tool but status while the add-on is off or agents may not delegate. */
const requireDelegation = Effect.gen(function* () {
  const cloud = yield* ClaudeCloudService.ClaudeCloudService;
  const status = yield* cloud.getStatus().pipe(Effect.mapError(toFailure));
  if (!status.enabled) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "The claude-cloud add-on is disabled. The user can turn it on in Settings → Add-ons.",
    });
  }
  if (status.settings.agentDelegationMode === "off") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: DELEGATION_OFF,
    });
  }
  return cloud;
});

/** The caller's project and checkout: a worktree thread launches from its own branch. */
const callerWorkspace = Effect.gen(function* () {
  const context = yield* loadCaller().pipe(Effect.mapError(() => unavailable()));
  const caller = context.caller;
  return caller === undefined
    ? { projectId: undefined, cwd: undefined, threadId: undefined }
    : {
        projectId: caller.projectId,
        cwd: caller.worktreePath ?? undefined,
        threadId: caller.id,
      };
});

const requireProject = (projectId: ProjectId | undefined) =>
  projectId === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass projectId: this MCP client is not running inside a mattr thread.",
        }),
      )
    : Effect.succeed(projectId);

export const layer = McpToolAccess.toLayer(ClaudeCloudToolkit, {
  claude_cloud_status: McpToolAccess.reads(({ projectId, refresh }) =>
    Effect.gen(function* () {
      const cloud = yield* ClaudeCloudService.ClaudeCloudService;
      const status = yield* cloud
        .getStatus({
          ...(refresh === undefined ? {} : { refresh }),
          ...(projectId === undefined ? {} : { projectId }),
        })
        .pipe(Effect.mapError(toFailure));
      if (!status.enabled) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "The claude-cloud add-on is disabled. The user can turn it on in Settings → Add-ons.",
        });
      }
      return {
        agentDelegationMode: status.settings.agentDelegationMode,
        delegationRules: status.settings.delegationRules,
        accounts: status.accounts,
        sessions: status.sessions.map((session) => ({
          sessionId: session.id,
          url: session.url,
          title: session.title,
          createdBy: session.createdBy,
          createdAt: session.createdAt,
          teleportedThreadId: session.teleportedThreadId,
        })),
      };
    }),
  ),
  claude_cloud_launch: McpToolAccess.writes((params) =>
    Effect.gen(function* () {
      const cloud = yield* requireDelegation;
      const caller = yield* callerWorkspace;
      const projectId = yield* requireProject(params.projectId ?? caller.projectId);
      const sameProject = params.projectId === undefined || params.projectId === caller.projectId;
      const result = yield* cloud
        .launchSession({
          prompt: params.prompt,
          projectId,
          createdBy: "agent",
          ...(params.title === undefined ? {} : { title: params.title }),
          ...(params.instanceId === undefined ? {} : { instanceId: params.instanceId }),
          ...(params.pushFirst === undefined ? {} : { pushFirst: params.pushFirst }),
          ...(params.userApproved === undefined ? {} : { userApproved: params.userApproved }),
          ...(params.reason === undefined ? {} : { reason: params.reason }),
          ...(sameProject && caller.cwd !== undefined ? { cwd: caller.cwd } : {}),
          ...(caller.threadId === undefined ? {} : { sourceThreadId: caller.threadId }),
        })
        .pipe(Effect.mapError(toFailure));
      return {
        sessionId: result.session.id,
        url: result.session.url,
        title: result.session.title,
        branch: result.session.branch,
        pushed: result.pushed,
        warnings: result.warnings,
      };
    }),
  ),
  claude_cloud_send: McpToolAccess.writes(({ sessionId, prompt }) =>
    Effect.gen(function* () {
      const cloud = yield* requireDelegation;
      return yield* cloud.sendFollowUp({ sessionId, prompt }).pipe(Effect.mapError(toFailure));
    }),
  ),
  claude_cloud_teleport: McpToolAccess.writes(({ sessionId, projectId, prompt }) =>
    Effect.gen(function* () {
      const cloud = yield* requireDelegation;
      const caller = yield* callerWorkspace;
      const project = yield* requireProject(projectId ?? caller.projectId);
      const result = yield* cloud
        .teleportToWorktree({
          sessionId,
          projectId: project,
          ...(prompt === undefined ? {} : { prompt }),
        })
        .pipe(Effect.mapError(toFailure));
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return {
        ...result,
        threadLink:
          result.threadId === null
            ? null
            : McpInvocationContext.threadLinkFor(scope, result.threadId),
      };
    }),
  ),
});

/**
 * Lists the tools only while the add-on is on and agents may delegate, so an unused add-on costs
 * agents no context. Calls still reach the handlers, which explain why they refuse.
 */
export const toolListCheck =
  (cloud: Pick<ClaudeCloudService.ClaudeCloudService["Service"], "agentToolsListed">) =>
  ({ method }: { readonly method: string }) =>
    method === "tools/list" ? cloud.agentToolsListed : Effect.succeed(true);
