import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  ClaudeCloudEligibilityRequest,
  ClaudeCloudFollowUpRequest,
  ClaudeCloudLaunchRequest,
  type ClaudeCloudErrorCode,
  ClaudeCloudSettingsPatch,
  ClaudeCloudTeleportRequest,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";

import {
  authenticate,
  catchAuthErrors,
  INVALID_REQUEST,
  json,
  readJson,
  readQuery,
} from "../bots/mattrHttp.ts";
import * as ClaudeCloudService from "./ClaudeCloudService.ts";

const decodeEligibility = Schema.decodeUnknownEffect(ClaudeCloudEligibilityRequest);
const decodeLaunch = Schema.decodeUnknownEffect(ClaudeCloudLaunchRequest);
const decodeFollowUp = Schema.decodeUnknownEffect(ClaudeCloudFollowUpRequest);
const decodeTeleport = Schema.decodeUnknownEffect(ClaudeCloudTeleportRequest);
const decodeSettings = Schema.decodeUnknownEffect(ClaudeCloudSettingsPatch);
const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

const ERROR_STATUS: Record<ClaudeCloudErrorCode, number> = {
  addon_disabled: 409,
  delegation_off: 403,
  approval_required: 428,
  reason_required: 400,
  invalid_request: 400,
  account_not_ready: 412,
  project_not_found: 404,
  not_eligible: 412,
  not_found: 404,
  cli_failed: 502,
  launch_timeout: 504,
  teleport_failed: 502,
};

const errorResponse = (error: ClaudeCloudService.ClaudeCloudError) =>
  Effect.succeed(
    json(
      { error: error.code, detail: error.message },
      ERROR_STATUS[error.code as ClaudeCloudErrorCode] ?? 500,
    ),
  );

const SESSIONS_PATH = "/api/mattr/claude-cloud/sessions";

/** `/api/mattr/claude-cloud/*`. Everything but status answers 409 while the add-on is off. */
export const layerClaudeCloudRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const cloud = yield* ClaudeCloudService.ClaudeCloudService;

    const statusRoute = HttpRouter.add(
      "GET",
      "/api/mattr/claude-cloud/status",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        const query = yield* readQuery;
        const projectId = decodeProjectId(query.get("projectId") ?? undefined);
        return yield* cloud
          .getStatus({
            refresh: query.get("refresh") === "1",
            ...(projectId._tag === "Some" ? { projectId: projectId.value } : {}),
          })
          .pipe(
            Effect.map((status) => json(status)),
            Effect.catchTags({ ClaudeCloudError: errorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    const settingsRoute = HttpRouter.add(
      "POST",
      "/api/mattr/claude-cloud/settings",
      Effect.gen(function* () {
        yield* authenticate(AuthSettingsWriteScope);
        const body = yield* readJson(decodeSettings);
        if (!body) return INVALID_REQUEST;
        return yield* cloud.updateSettings(body).pipe(
          Effect.map((settings) => json({ settings })),
          Effect.catchTags({ ClaudeCloudError: errorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const eligibilityRoute = HttpRouter.add(
      "POST",
      "/api/mattr/claude-cloud/eligibility",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        const body = yield* readJson(decodeEligibility);
        if (!body) return INVALID_REQUEST;
        return yield* cloud.checkEligibility(body).pipe(
          Effect.map((eligibility) => json(eligibility)),
          Effect.catchTags({ ClaudeCloudError: errorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const launchRoute = HttpRouter.add(
      "POST",
      "/api/mattr/claude-cloud/launch",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeLaunch);
        if (!body) return INVALID_REQUEST;
        return yield* cloud.launchSession({ ...body, createdBy: "user" }).pipe(
          Effect.map((result) => json(result)),
          Effect.catchTags({ ClaudeCloudError: errorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const followUpRoute = HttpRouter.add(
      "POST",
      "/api/mattr/claude-cloud/followup",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeFollowUp);
        if (!body) return INVALID_REQUEST;
        return yield* cloud.sendFollowUp(body).pipe(
          Effect.map((result) => json(result)),
          Effect.catchTags({ ClaudeCloudError: errorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const teleportRoute = HttpRouter.add(
      "POST",
      "/api/mattr/claude-cloud/teleport",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeTeleport);
        if (!body) return INVALID_REQUEST;
        return yield* cloud.teleportToWorktree(body).pipe(
          Effect.map((result) => json(result)),
          Effect.catchTags({ ClaudeCloudError: errorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const sessionsRoute = HttpRouter.add(
      "GET",
      SESSIONS_PATH,
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        const projectId = decodeProjectId((yield* readQuery).get("projectId") ?? undefined);
        return yield* cloud
          .getStatus(projectId._tag === "Some" ? { projectId: projectId.value } : {})
          .pipe(
            Effect.map((status) =>
              status.enabled
                ? json({ sessions: status.sessions })
                : json(
                    { error: "addon_disabled", detail: "The claude-cloud add-on is disabled." },
                    409,
                  ),
            ),
            Effect.catchTags({ ClaudeCloudError: errorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    const forgetRoute = HttpRouter.add(
      "DELETE",
      `${SESSIONS_PATH}/:id`,
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = request.url.split("?", 1)[0] ?? "";
        const id = decodeURIComponent(pathname.slice(SESSIONS_PATH.length + 1));
        if (id === "") return INVALID_REQUEST;
        const status = yield* cloud.getStatus().pipe(Effect.orElseSucceed(() => null));
        if (status?.enabled !== true) {
          return json(
            { error: "addon_disabled", detail: "The claude-cloud add-on is disabled." },
            409,
          );
        }
        return yield* cloud.forgetSession(id).pipe(
          Effect.map((removed) =>
            removed ? json({ ok: true }) : json({ error: "not_found" }, 404),
          ),
          Effect.catchTags({ ClaudeCloudError: errorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    return Layer.mergeAll(
      statusRoute,
      settingsRoute,
      eligibilityRoute,
      launchRoute,
      followUpRoute,
      teleportRoute,
      sessionsRoute,
      forgetRoute,
    );
  }),
);
