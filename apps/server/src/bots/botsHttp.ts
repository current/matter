import {
  AddonReconnectRequest,
  AddonSetEnabledRequest,
  AddonUpdateConfigRequest,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  BotCancelRequest,
  BotEvent,
  BotRespondRequest,
  BotSendMessageRequest,
  MAX_BOT_MESSAGES_PAGE,
  CLAUDE_CLOUD_ADDON_ID,
  type AddonEntry,
  type AddonListResponse,
  type AddonRuntimeStatus,
  type BotsErrorCode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import * as ClaudeCloudRunner from "../cloud/ClaudeCloudRunner.ts";
import * as ClaudeCloudService from "../cloud/ClaudeCloudService.ts";
import * as ClaudeCloudSessionsApi from "../cloud/ClaudeCloudSessionsApi.ts";
import { layerClaudeCloudRoutes } from "../cloud/claudeCloudHttp.ts";
import { eventStreamResponse } from "../eventStreamResponse.ts";
import * as AddonConfigService from "./AddonConfigService.ts";
import * as BotsPlatformService from "./BotsPlatformService.ts";
import {
  authenticate,
  catchAuthErrors,
  INVALID_REQUEST,
  json,
  readJson,
  readQuery,
} from "./matterHttp.ts";
import { layerRegisteredBotProviders } from "./registeredProviders.ts";

const decodeSetEnabled = Schema.decodeUnknownEffect(AddonSetEnabledRequest);
const decodeUpdateConfig = Schema.decodeUnknownEffect(AddonUpdateConfigRequest);
const decodeReconnect = Schema.decodeUnknownEffect(AddonReconnectRequest);
const decodeSend = Schema.decodeUnknownEffect(BotSendMessageRequest);
const decodeRespond = Schema.decodeUnknownEffect(BotRespondRequest);
const decodeCancel = Schema.decodeUnknownEffect(BotCancelRequest);
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(BotEvent));

const BOTS_ERROR_STATUS: Record<BotsErrorCode, number> = {
  invalid_request: 400,
  provider_not_found: 404,
  provider_disabled: 409,
  provider_unavailable: 503,
  unsupported: 501,
  usage_confirmation_required: 428,
  not_found: 404,
  provider_error: 502,
};

const botsErrorResponse = (error: BotsPlatformService.BotsPlatformError) =>
  Effect.succeed(
    json(
      { error: error.code, ...(error.detail === undefined ? {} : { detail: error.detail }) },
      BOTS_ERROR_STATUS[error.code],
    ),
  );

const addonErrorResponse = (error: AddonConfigService.AddonConfigError) =>
  Effect.succeed(
    json(
      { error: error.reason, ...(error.detail === undefined ? {} : { detail: error.detail }) },
      error.reason === "unknown_addon" ? 404 : error.reason === "secret_config_key" ? 400 : 500,
    ),
  );

const layerBotsRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const addonConfig = yield* AddonConfigService.AddonConfigService;
    const platform = yield* BotsPlatformService.BotsPlatformService;
    const claudeCloud = yield* ClaudeCloudService.ClaudeCloudService;

    const statusFor = Effect.fn("botsHttp.statusFor")(function* (id: string, enabled: boolean) {
      if (!enabled) return { kind: "disabled" } satisfies AddonRuntimeStatus;
      if (id === CLAUDE_CLOUD_ADDON_ID) return yield* claudeCloud.addonStatus;
      const providerStatus = yield* platform.addonStatus(id);
      if (providerStatus) return providerStatus;
      const manifest = addonConfig.manifests.find((entry) => entry.id === id);
      // A Bots add-on whose provider is not in this build yet can't connect to anything.
      return manifest?.contributions.includes("bots-provider")
        ? ({ kind: "enabled_unconfigured" } satisfies AddonRuntimeStatus)
        : ({ kind: "connected" } satisfies AddonRuntimeStatus);
    });

    const listAddons = Effect.gen(function* () {
      const enablement = yield* addonConfig.listEnablement;
      const addons = yield* Effect.forEach(addonConfig.manifests, (manifest) =>
        Effect.gen(function* () {
          const state = enablement.find((entry) => entry.id === manifest.id);
          const enabled = state?.enabled ?? manifest.defaultEnabled;
          return {
            manifest,
            state: {
              id: manifest.id,
              enabled,
              enablementSource: state?.enablementSource ?? "default",
              updatedAt: state?.updatedAt ?? null,
              status: yield* statusFor(manifest.id, enabled),
            },
          } satisfies AddonEntry;
        }),
      );
      return { addons } satisfies AddonListResponse;
    });

    const addonsRoute = HttpRouter.add(
      "GET",
      "/api/mattr/addons",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return json(yield* listAddons);
      }).pipe(catchAuthErrors),
    );

    const setEnabledRoute = HttpRouter.add(
      "POST",
      "/api/mattr/addons/enabled",
      Effect.gen(function* () {
        yield* authenticate(AuthSettingsWriteScope);
        const body = yield* readJson(decodeSetEnabled);
        if (!body) return INVALID_REQUEST;
        return yield* addonConfig
          .setEnabled({ id: body.id, enabled: body.enabled, source: body.source ?? "user" })
          .pipe(
            Effect.andThen(listAddons),
            Effect.map((response) => json(response)),
            Effect.catchTags({ AddonConfigError: addonErrorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    const getConfigRoute = HttpRouter.add(
      "GET",
      "/api/mattr/addons/config",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        const id = (yield* readQuery).get("id");
        if (!id) return INVALID_REQUEST;
        return yield* addonConfig.getConfig(id).pipe(
          Effect.map((config) => json({ id, config })),
          Effect.catchTags({ AddonConfigError: addonErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const updateConfigRoute = HttpRouter.add(
      "POST",
      "/api/mattr/addons/config",
      Effect.gen(function* () {
        yield* authenticate(AuthSettingsWriteScope);
        const body = yield* readJson(decodeUpdateConfig);
        if (!body) return INVALID_REQUEST;
        return yield* addonConfig.updateConfig(body.id, body.config).pipe(
          Effect.map((config) => json({ id: body.id, config })),
          Effect.catchTags({ AddonConfigError: addonErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const reconnectRoute = HttpRouter.add(
      "POST",
      "/api/mattr/addons/reconnect",
      Effect.gen(function* () {
        yield* authenticate(AuthSettingsWriteScope);
        const body = yield* readJson(decodeReconnect);
        if (!body) return INVALID_REQUEST;
        yield* platform.reconnect(body.id);
        return json(yield* listAddons);
      }).pipe(catchAuthErrors),
    );

    const providersRoute = HttpRouter.add(
      "GET",
      "/api/mattr/bots/providers",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return json({ providers: yield* platform.listProviders });
      }).pipe(catchAuthErrors),
    );

    const botsRoute = HttpRouter.add(
      "GET",
      "/api/mattr/bots/bots",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        const providerId = (yield* readQuery).get("providerId");
        if (!providerId) return INVALID_REQUEST;
        return yield* platform.listBots(providerId).pipe(
          Effect.map((bots) => json({ bots })),
          Effect.catchTags({ BotsPlatformError: botsErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const conversationsRoute = HttpRouter.add(
      "GET",
      "/api/mattr/bots/conversations",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        const query = yield* readQuery;
        const providerId = query.get("providerId");
        if (!providerId) return INVALID_REQUEST;
        return yield* platform
          .listConversations({ providerId, botId: query.get("botId") || null })
          .pipe(
            Effect.map((conversations) => json({ conversations })),
            Effect.catchTags({ BotsPlatformError: botsErrorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    const messagesRoute = HttpRouter.add(
      "GET",
      "/api/mattr/bots/messages",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        const query = yield* readQuery;
        const providerId = query.get("providerId");
        const conversationId = query.get("conversationId");
        if (!providerId || !conversationId) return INVALID_REQUEST;
        const limit = Number(query.get("limit") ?? 50);
        return yield* platform
          .getMessages({
            providerId,
            conversationId,
            olderCursor: query.get("cursor") || null,
            limit: Number.isFinite(limit) ? limit : MAX_BOT_MESSAGES_PAGE,
          })
          .pipe(
            Effect.map((page) => json(page)),
            Effect.catchTags({ BotsPlatformError: botsErrorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    const sendRoute = HttpRouter.add(
      "POST",
      "/api/mattr/bots/messages",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeSend);
        if (!body) return INVALID_REQUEST;
        return yield* platform.sendMessage(body).pipe(
          Effect.map((message) => json({ message })),
          Effect.catchTags({ BotsPlatformError: botsErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const respondRoute = HttpRouter.add(
      "POST",
      "/api/mattr/bots/respond",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeRespond);
        if (!body) return INVALID_REQUEST;
        return yield* platform
          .respondToRequest(body)
          .pipe(
            Effect.as(json({ ok: true })),
            Effect.catchTags({ BotsPlatformError: botsErrorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    const cancelRoute = HttpRouter.add(
      "POST",
      "/api/mattr/bots/cancel",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeCancel);
        if (!body) return INVALID_REQUEST;
        return yield* platform
          .cancel(body)
          .pipe(
            Effect.as(json({ ok: true })),
            Effect.catchTags({ BotsPlatformError: botsErrorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    const pendingRoute = HttpRouter.add(
      "GET",
      "/api/mattr/bots/pending",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return json({ requests: yield* platform.listPendingRequests });
      }).pipe(catchAuthErrors),
    );

    const eventsRoute = HttpRouter.add(
      "GET",
      "/api/mattr/bots/events",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return eventStreamResponse(platform.events, encodeEvent);
      }).pipe(catchAuthErrors),
    );

    return Layer.mergeAll(
      addonsRoute,
      setEnabledRoute,
      getConfigRoute,
      updateConfigRoute,
      reconnectRoute,
      providersRoute,
      botsRoute,
      conversationsRoute,
      messagesRoute,
      sendRoute,
      respondRoute,
      cancelRoute,
      pendingRoute,
      eventsRoute,
    );
  }),
);

/** Add-on, Bots and Claude Cloud routes with the platform and every registered provider. */
export const layerMatterAddonsAndBots = Layer.mergeAll(
  layerBotsRoutes,
  layerRegisteredBotProviders,
  layerClaudeCloudRoutes,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      BotsPlatformService.layer.pipe(Layer.provideMerge(AddonConfigService.layer)),
      ClaudeCloudSessionsApi.layer.pipe(
        Layer.provideMerge(ClaudeCloudService.layerWithRunner),
        Layer.provide(ClaudeCloudRunner.layer),
      ),
    ),
  ),
);
