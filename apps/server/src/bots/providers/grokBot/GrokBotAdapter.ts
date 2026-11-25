import {
  NO_BOT_PROVIDER_CAPABILITIES,
  grokBotCdpPortFromConfig,
  type BotActivityState,
  type BotAvatar,
  type BotConversation,
  type BotIdentity,
  type BotMessage,
  type BotProviderCapabilities,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  BotProviderError,
  type BotProviderAdapter,
  type BotProviderPollIntervals,
} from "../../BotProviderAdapter.ts";
import * as GrokBotCdpTransport from "./GrokBotCdpTransport.ts";
import {
  buildGrokBotPromptDeepLink,
  GROK_BOT_APP_PATH,
  type GrokBotCapabilities,
} from "./grokBotDeepLinks.ts";
import * as GrokBotProvider from "./GrokBotProvider.ts";
import type {
  GrokBotActivityStatus,
  GrokBotAvailability,
  GrokBotMessage,
  GrokBotSummary,
  GrokBotTransportError,
} from "./GrokBotTransport.ts";

const PROVIDER_ID = GrokBotProvider.GROK_BOT_PROVIDER_ID;
/** Grok Bot runs on this Mac with one signed-in account, so there is a single scope. */
const ACCOUNT_SCOPE_ID = "local";
const DEFAULT_POLL_INTERVALS: BotProviderPollIntervals = { idleMs: 10_000, activeMs: 3_000 };
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,/;

export interface GrokBotAdapterOptions {
  readonly appPath?: string;
  readonly pollIntervals?: BotProviderPollIntervals;
}

const fail = (reason: BotProviderError["reason"], detail?: string) =>
  new BotProviderError({ providerId: PROVIDER_ID, reason, ...(detail ? { detail } : {}) });

function toBotProviderError(error: GrokBotTransportError): BotProviderError {
  switch (error._tag) {
    case "GrokBotAppUnavailableError":
      return fail(
        error.state === "app_unavailable"
          ? "unavailable"
          : error.state === "enabled_unconfigured"
            ? "unconfigured"
            : "incompatible_version",
        error.message,
      );
    case "GrokBotCdpConnectionError":
      return fail("disconnected", "Lost the connection to Grok Bot's debug port.");
    case "GrokBotStoreBridgeError":
      if (error.reason === "bot_not_found") return fail("not_found", error.message);
      if (error.reason === "action_rejected") return fail("failed", error.message);
      return fail("incompatible_version", "This version of Grok Bot isn't supported yet.");
    case "GrokBotCdpProtocolError":
    case "GrokBotLoopbackViolationError":
      return fail("failed", error.message);
  }
}

function availabilityError(availability: GrokBotAvailability, port: number): BotProviderError {
  switch (availability.state) {
    case "app_unavailable":
      return fail("unavailable", "Grok Bot isn't installed on this Mac.");
    case "enabled_unconfigured":
      return fail("unconfigured", `Grok Bot isn't reachable on debug port ${port}.`);
    case "incompatible_version":
      return fail("incompatible_version", availability.detail);
    default:
      return fail("disconnected", availability.detail);
  }
}

function toBotProviderCapabilities(capabilities: GrokBotCapabilities): BotProviderCapabilities {
  return {
    ...NO_BOT_PROVIDER_CAPABILITIES,
    agentDiscovery: capabilities.discoverBots,
    avatarMetadata: capabilities.customAvatarImage || capabilities.parametricCharacterAvatar,
    conversationDiscovery: capabilities.multiConversation,
    history: capabilities.historyPagination ? "paged" : "recent",
    sendMessage: capabilities.discoverBots,
    sync: capabilities.syncMode,
    activityEvents: capabilities.syncMode !== "none",
    attachmentsIn: capabilities.attachmentsUpload,
    cancel: capabilities.interrupt,
    approvals: capabilities.approvals,
    manageAgents: capabilities.botCrud,
    routines: capabilities.routines,
    officialAppDeepLink: capabilities.deepLinkUrl,
  };
}

function toBotActivityState(status: GrokBotActivityStatus): BotActivityState {
  switch (status) {
    case "working":
    case "thinking":
    case "searching":
      return "working";
    case "attention":
      return "waiting_for_user";
    case "error":
      return "error";
    case "offline":
      return "offline";
    case "idle":
    case "waiting":
      return "idle";
  }
}

function toBotAvatar(bot: GrokBotSummary): BotAvatar {
  if (bot.avatarDataUrl && AVATAR_DATA_URL.test(bot.avatarDataUrl)) {
    return { kind: "data-url", dataUrl: bot.avatarDataUrl };
  }
  // Grok Bot draws a character for every Bot; "auto" lets the renderer derive it from the seed.
  return {
    kind: "parametric",
    shape: bot.avatarShape ?? "auto",
    color: bot.avatarColor ?? "auto",
    seed: bot.id,
  };
}

const isoFromMs = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const isoOrNull = (ms: number | null) => (ms === null ? null : isoFromMs(ms));

function toBotIdentity(bot: GrokBotSummary): BotIdentity {
  return {
    providerId: PROVIDER_ID,
    remoteBotId: bot.id,
    accountScopeId: ACCOUNT_SCOPE_ID,
    name: bot.name,
    avatar: toBotAvatar(bot),
    status: toBotActivityState(bot.status),
    unreadCount: bot.unreadCount,
    defaultConversationId: bot.id,
    officialAppUrl: bot.deepLinkUrl,
    // Grok Bot's own state is finer than the shared one; its character renderer reads it.
    metadata: {
      grokActivity: bot.status,
      description: bot.description,
      lastMessagePreview: bot.lastMessagePreview,
    },
  };
}

function toBotConversation(bot: GrokBotSummary): BotConversation {
  return {
    conversationId: bot.id,
    providerId: PROVIDER_ID,
    accountScopeId: ACCOUNT_SCOPE_ID,
    botId: bot.id,
    participantBotIds: [],
    kind: "direct",
    title: null,
    parentConversationId: null,
    unreadCount: bot.unreadCount,
    lastActivityAt: isoOrNull(bot.lastActivityAtMs),
    activityState: toBotActivityState(bot.status),
    officialAppUrl: bot.deepLinkUrl,
  };
}

function toBotMessage(message: GrokBotMessage, sentByMattr: boolean): BotMessage {
  const fromUser = message.role === "user";
  return {
    remoteId: message.id,
    conversationId: message.botId,
    providerId: PROVIDER_ID,
    role: fromUser ? "user" : message.role === "system" ? "system" : "agent",
    attribution: fromUser
      ? sentByMattr
        ? "user-via-mattr"
        : "user-via-other-client"
      : message.role === "system"
        ? "system"
        : "agent",
    authorBotId: message.role === "assistant" ? message.botId : null,
    markdown: message.text,
    parts: [{ type: "markdown", text: message.text }],
    replyToId: message.replyToId,
    attachments: [],
    artifacts: [],
    createdAt: isoFromMs(message.timestampMs ?? 0),
    seq: message.seq !== null && Number.isInteger(message.seq) ? message.seq : null,
    clientNonce: message.clientNonce,
    deliveryState: "sent",
  };
}

/** What a sidebar row shows; a change means the Bot list is worth re-publishing. */
const botFingerprint = (bot: GrokBotSummary) =>
  [
    bot.name,
    bot.status,
    bot.unreadCount,
    bot.lastMessagePreview,
    bot.avatarShape,
    bot.avatarColor,
    bot.avatarDataUrl?.length ?? 0,
  ].join("\u0000");

const messageFingerprint = (message: GrokBotMessage) =>
  `${message.isStreaming ? 1 : 0}${message.text}`;

/**
 * Grok Bot through its loopback Chrome DevTools port. It only ever probes 127.0.0.1 on the
 * configured port: it never launches, quits or restarts the Grok Bot app.
 */
export const make = Effect.fn("GrokBotAdapter.make")(function* (
  options: GrokBotAdapterOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const appPath = options.appPath ?? GROK_BOT_APP_PATH;

  const adapter: BotProviderAdapter = {
    providerId: PROVIDER_ID,
    addonId: "grok-bot",
    displayName: GrokBotProvider.GROK_BOT_PROVIDER_NAME,
    transport: "local-app-bridge",
    experimental: true,
    officialAppUrl: buildGrokBotPromptDeepLink(),
    pollIntervals: options.pollIntervals ?? DEFAULT_POLL_INTERVALS,
    start: Effect.fn("GrokBotAdapter.start")(function* (context) {
      const port = grokBotCdpPortFromConfig(context.config);
      const providerLayer = GrokBotProvider.layer.pipe(
        Layer.provide(GrokBotCdpTransport.layerLive({ port, appPath })),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      );
      const provider = yield* Effect.service(GrokBotProvider.GrokBotProvider).pipe(
        Effect.provide(yield* Layer.buildWithScope(providerLayer, yield* Effect.scope)),
      );

      const availability = yield* provider
        .detectAvailability()
        .pipe(Effect.mapError(toBotProviderError));
      if (availability.state !== "connected") {
        return yield* availabilityError(availability, port);
      }

      const sentNonces = new Set<string>();
      const seenMessages = new Map<string, Map<string, string>>();
      let previousBots: Map<string, GrokBotSummary> | null = null;

      const discoverBots = provider.discoverBots().pipe(Effect.mapError(toBotProviderError));
      const listPage = (botId: string, cursor: string | null) =>
        provider.listMessages(botId, cursor ?? undefined).pipe(Effect.mapError(toBotProviderError));
      const toMessage = (message: GrokBotMessage) =>
        toBotMessage(message, message.clientNonce !== null && sentNonces.has(message.clientNonce));

      const syncMessages = Effect.fn("GrokBotAdapter.syncMessages")(function* (botId: string) {
        const page = yield* listPage(botId, null);
        const known = seenMessages.get(botId);
        const next = new Map<string, string>();
        for (const message of page.messages) {
          const fingerprint = messageFingerprint(message);
          next.set(message.id, fingerprint);
          if (known?.get(message.id) !== fingerprint) {
            yield* context.emit({ type: "message-upserted", message: toMessage(message) });
          }
        }
        seenMessages.set(botId, next);
      });

      const poll = Effect.gen(function* () {
        const bots = yield* discoverBots;
        const previous = previousBots;
        const listChanged =
          previous === null ||
          previous.size !== bots.length ||
          bots.some((bot) => {
            const before = previous.get(bot.id);
            return !before || botFingerprint(before) !== botFingerprint(bot);
          });
        if (listChanged) {
          yield* context.emit({
            type: "bots-changed",
            providerId: PROVIDER_ID,
            bots: bots.map(toBotIdentity),
          });
        }
        for (const bot of bots) {
          const before = previous?.get(bot.id);
          if (before && before.status !== bot.status) {
            yield* context.emit({
              type: "activity",
              providerId: PROVIDER_ID,
              botId: bot.id,
              conversationId: bot.id,
              state: toBotActivityState(bot.status),
            });
          }
          const hasNews =
            before !== undefined &&
            (before.lastMessagePreview !== bot.lastMessagePreview ||
              before.lastActivityAtMs !== bot.lastActivityAtMs);
          if (bot.isRunning || hasNews) yield* syncMessages(bot.id);
        }
        previousBots = new Map(bots.map((bot) => [bot.id, bot]));
        return {
          active: bots.some((bot) => toBotActivityState(bot.status) === "working"),
        };
      });

      return {
        capabilities: toBotProviderCapabilities(provider.capabilities),
        status: Effect.succeed({ kind: "connected" as const }),
        listBots: discoverBots.pipe(Effect.map((bots) => bots.map(toBotIdentity))),
        listConversations: ({ botId }) =>
          discoverBots.pipe(
            Effect.map((bots) =>
              bots.filter((bot) => botId === null || bot.id === botId).map(toBotConversation),
            ),
          ),
        // Grok Bot pages by its own cursor, so the platform's limit only caps what it asks for.
        getMessages: ({ conversationId, olderCursor }) =>
          listPage(conversationId, olderCursor).pipe(
            Effect.map((page) => ({
              messages: page.messages.map(toMessage),
              olderCursor: page.hasMore ? page.nextCursor : null,
            })),
          ),
        sendMessage: Effect.fn("GrokBotAdapter.sendMessage")(function* ({
          conversationId,
          text,
          clientNonce,
        }) {
          sentNonces.add(clientNonce);
          const result = yield* provider
            .sendMessage(conversationId, text, { clientNonce })
            .pipe(Effect.mapError(toBotProviderError));
          if (!result.accepted) {
            return yield* fail("failed", "Grok Bot didn't accept the message.");
          }
          return {
            remoteId: result.messageId ?? `pending:${clientNonce}`,
            conversationId,
            providerId: PROVIDER_ID,
            role: "user",
            attribution: "user-via-mattr",
            authorBotId: null,
            markdown: text,
            parts: [{ type: "markdown", text }],
            replyToId: null,
            attachments: [],
            artifacts: [],
            createdAt: DateTime.formatIso(yield* DateTime.now),
            seq: null,
            clientNonce,
            deliveryState: "sent",
          } satisfies BotMessage;
        }),
        // Best effort: Grok Bot may ignore it, in which case the user stops the run there.
        cancel: ({ conversationId }) =>
          provider.cancelRun(conversationId).pipe(
            Effect.mapError(toBotProviderError),
            Effect.flatMap((result) =>
              result.cancelled
                ? Effect.void
                : Effect.fail(fail("unsupported", "Stop this run in Grok Bot.")),
            ),
          ),
        poll,
      };
    }),
  };
  return adapter;
});
