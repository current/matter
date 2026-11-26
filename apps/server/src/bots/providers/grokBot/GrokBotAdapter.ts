import {
  NO_BOT_PROVIDER_CAPABILITIES,
  grokBotCdpPortFromConfig,
  type BotActivityState,
  type BotAvatar,
  type BotConversation,
  type BotIdentity,
  type BotMessage,
  type BotMessagePart,
  type BotPendingRequest,
  type BotProviderCapabilities,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

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
  GrokBotOpenWidget,
  GrokBotStoreBridgeError,
  GrokBotSummary,
  GrokBotTransportError,
} from "./GrokBotTransport.ts";

const PROVIDER_ID = GrokBotProvider.GROK_BOT_PROVIDER_ID;
/** Grok Bot runs on this Mac with one signed-in account, so there is a single scope. */
const ACCOUNT_SCOPE_ID = "local";
/** Clamped to the platform's 2 s floor; idle polls only refresh the Bot list. */
const DEFAULT_POLL_INTERVALS: BotProviderPollIntervals = { idleMs: 10_000, activeMs: 1_500 };
/** Grok Bot can take a moment to flag a run after a send; keep polling fast meanwhile. */
const SEND_ACTIVE_WINDOW_MS = 30_000;
/** Enough to map every send a session can still see back to mattr's nonce. */
const MAX_TRACKED_SENDS = 500;
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,/;

export interface GrokBotAdapterOptions {
  readonly appPath?: string;
  readonly pollIntervals?: BotProviderPollIntervals;
}

const fail = (reason: BotProviderError["reason"], detail?: string) =>
  new BotProviderError({ providerId: PROVIDER_ID, reason, ...(detail ? { detail } : {}) });

const SEND_FAILURES: Readonly<Record<string, string>> = {
  "send/agent-read-only": "This Bot is read-only for you in Grok Bot.",
  "send/agent-no-access": "You no longer have access to this Bot in Grok Bot.",
  "send/agent-unavailable": "This Bot isn't available in Grok Bot right now.",
  "send/sand-access-blocked": "Grok Bot is blocking sends right now. Open Grok Bot to see why.",
  "send/message-too-long": "That message is too long for Grok Bot.",
  "send/empty-input": "Grok Bot ignored an empty message.",
  "send/superseded": "Grok Bot replaced this send with a newer one.",
  "send/timeout":
    "Grok Bot didn't confirm the message in time. Check Grok Bot before sending it again.",
};

function bridgeFailureDetail(error: GrokBotStoreBridgeError): string {
  const code = error.code ?? null;
  if (error.operation === "send_message") {
    if (code !== null && SEND_FAILURES[code]) return SEND_FAILURES[code];
    if (code?.startsWith("send/journal-")) return "Grok Bot couldn't save the message on this Mac.";
    return code
      ? `Grok Bot didn't accept the message (${code}).`
      : "Grok Bot didn't accept the message.";
  }
  if (error.operation === "respond_widget") return "Grok Bot didn't accept that answer.";
  if (error.operation === "cancel_run") return "Grok Bot couldn't stop this run.";
  return code ? `Grok Bot refused the request (${code}).` : "Grok Bot refused the request.";
}

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
      if (error.reason === "bot_not_found")
        return fail("not_found", "Grok Bot no longer has this Bot.");
      if (error.reason === "action_rejected") return fail("failed", bridgeFailureDetail(error));
      if (error.reason === "store_unavailable") {
        return fail(
          "disconnected",
          "Grok Bot is open but not ready. Finish signing in to Grok Bot.",
        );
      }
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
    questions: capabilities.interactiveWidgets,
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

function toBotIdentity(bot: GrokBotSummary, openWidgetBotIds: ReadonlySet<string>): BotIdentity {
  const status = toBotActivityState(bot.status);
  return {
    providerId: PROVIDER_ID,
    remoteBotId: bot.id,
    accountScopeId: ACCOUNT_SCOPE_ID,
    name: bot.name,
    avatar: toBotAvatar(bot),
    status: status === "idle" && openWidgetBotIds.has(bot.id) ? "waiting_for_user" : status,
    unreadCount: bot.unreadCount,
    defaultConversationId: bot.id,
    officialAppUrl: bot.deepLinkUrl,
    // Grok Bot's own state is finer than the shared one; its character renderer reads it.
    metadata: {
      grokActivity: bot.status,
      description: bot.description,
      lastMessagePreview: bot.lastMessagePreview,
      activityDetail: bot.activityDetail,
      lastActivityAt: isoOrNull(bot.lastActivityAtMs),
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

/** Markdown for a message, including what mattr can't draw natively. */
function messageContent(message: GrokBotMessage): {
  readonly markdown: string;
  readonly parts: ReadonlyArray<BotMessagePart>;
} {
  const parts: BotMessagePart[] = [];
  const text = message.fromAgentName
    ? `**${message.fromAgentName}:** ${message.text}`
    : message.text;
  if (text.trim().length > 0) parts.push({ type: "markdown", text });
  if (message.widget) {
    const options = message.widget.options.map((option) => `- ${option.label}`).join("\n");
    const answer = message.widget.respondedValue;
    const widgetText = answer ? `Answered: ${answer}` : options;
    if (widgetText.length > 0) parts.push({ type: "markdown", text: widgetText });
  }
  if (message.cardType) {
    parts.push({
      type: "unsupported",
      fallbackText: `Grok Bot sent a ${message.cardType.replace(/[-_]/g, " ")} card. Open Grok Bot to see it.`,
    });
  }
  for (const attachment of message.attachments) {
    parts.push({ type: "attachment", attachmentId: attachment.id });
  }
  const markdown = parts
    .map((part) =>
      part.type === "markdown" ? part.text : part.type === "unsupported" ? part.fallbackText : "",
    )
    .filter((part) => part.length > 0)
    .join("\n\n");
  return { markdown, parts };
}

/** What a sidebar row shows; a change means the Bot list is worth re-publishing. */
const botFingerprint = (bot: GrokBotSummary) =>
  [
    bot.name,
    bot.status,
    bot.unreadCount,
    bot.lastMessagePreview,
    bot.activityDetail,
    bot.avatarShape,
    bot.avatarColor,
    bot.avatarDataUrl?.length ?? 0,
  ].join("\u0000");

const messageFingerprint = (message: GrokBotMessage) =>
  [
    message.isStreaming ? 1 : 0,
    message.seq ?? "",
    message.attachments.length,
    message.widget?.respondedValue ?? "",
    message.text,
  ].join("\u0000");

const widgetRequestId = (widget: { readonly botId: string; readonly entryId: string }) =>
  `${widget.botId}:${widget.entryId}`;

/**
 * Grok Bot through its loopback Chrome DevTools port. It only ever probes 127.0.0.1 on the
 * configured port: it never launches, quits or restarts the Grok Bot app. Every read and write
 * goes through Grok Bot's own renderer stores, so mattr never changes which chat Grok Bot shows.
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

      /** Grok Bot's nonce for each send mattr made, mapped to the nonce mattr's client sent. */
      const mattrNonceByGrokNonce = new Map<string, string>();
      const seenMessages = new Map<string, Map<string, string>>();
      const openRequests = new Map<
        string,
        { readonly widget: GrokBotOpenWidget; readonly request: BotPendingRequest }
      >();
      const activeUntilMs = new Map<string, number>();
      let previousBots: Map<string, GrokBotSummary> | null = null;
      let botCount = 0;
      // A send and a transcript sync never overlap, so a synced send always maps to mattr's nonce.
      const transcriptLock = yield* Semaphore.make(1);

      const discover = provider.discoverBots().pipe(Effect.mapError(toBotProviderError));
      const listPage = (botId: string, cursor: string | null) =>
        provider.listMessages(botId, cursor ?? undefined).pipe(Effect.mapError(toBotProviderError));

      const toMessage = (message: GrokBotMessage): BotMessage => {
        const mattrNonce =
          message.clientNonce === null ? undefined : mattrNonceByGrokNonce.get(message.clientNonce);
        const fromUser = message.role === "user";
        const { markdown, parts } = messageContent(message);
        return {
          remoteId: message.id,
          conversationId: message.botId,
          providerId: PROVIDER_ID,
          role: fromUser ? "user" : message.role === "system" ? "system" : "agent",
          attribution: fromUser
            ? message.fromAgentName
              ? "other-agent"
              : mattrNonce !== undefined
                ? "user-via-mattr"
                : "user-via-other-client"
            : message.role === "system"
              ? "system"
              : "agent",
          authorBotId: message.role === "assistant" ? message.botId : (message.fromAgentId ?? null),
          markdown,
          parts,
          replyToId: message.replyToId,
          attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: null,
            sizeBytes: attachment.sizeBytes,
            url: null,
          })),
          artifacts: [],
          createdAt: isoFromMs(message.timestampMs ?? 0),
          seq: message.seq !== null && Number.isInteger(message.seq) ? message.seq : null,
          clientNonce: mattrNonce ?? message.clientNonce,
          deliveryState: "sent",
        };
      };

      const toPendingRequest = (widget: GrokBotOpenWidget): BotPendingRequest => ({
        requestId: widgetRequestId(widget),
        providerId: PROVIDER_ID,
        accountScopeId: ACCOUNT_SCOPE_ID,
        botId: widget.botId,
        conversationId: widget.botId,
        kind: "question",
        title: widget.prompt.trim().length > 0 ? widget.prompt : "Grok Bot has a question",
        detail: null,
        options: widget.options.map((option, index) => ({
          id: String(index),
          label: option.label,
        })),
        allowFreeText: false,
        createdAt: isoFromMs(widget.timestampMs ?? 0),
        expiresAt: null,
      });

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

      const syncRequests = Effect.fn("GrokBotAdapter.syncRequests")(function* (
        widgets: ReadonlyArray<GrokBotOpenWidget>,
      ) {
        const current = new Set(widgets.map(widgetRequestId));
        for (const [requestId] of openRequests) {
          if (current.has(requestId)) continue;
          openRequests.delete(requestId);
          yield* context.emit({
            type: "pending-request-resolved",
            providerId: PROVIDER_ID,
            requestId,
          });
        }
        for (const widget of widgets) {
          const requestId = widgetRequestId(widget);
          if (openRequests.has(requestId)) continue;
          const request = toPendingRequest(widget);
          openRequests.set(requestId, { widget, request });
          yield* context.emit({ type: "pending-request", request });
        }
      });

      const initial = yield* discover;
      botCount = initial.bots.length;
      for (const widget of initial.openWidgets) {
        openRequests.set(widgetRequestId(widget), { widget, request: toPendingRequest(widget) });
      }

      const poll = Effect.gen(function* () {
        const roster = yield* discover;
        const { bots } = roster;
        botCount = bots.length;
        const widgetBotIds = new Set(roster.openWidgets.map((widget) => widget.botId));
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
            bots: bots.map((bot) => toBotIdentity(bot, widgetBotIds)),
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
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
              before.lastActivityAtMs !== bot.lastActivityAtMs ||
              before.isRunning !== bot.isRunning);
          const recentlySent = (activeUntilMs.get(bot.id) ?? 0) > nowMs;
          if (bot.isRunning || hasNews || recentlySent) {
            yield* transcriptLock.withPermit(syncMessages(bot.id));
          }
        }
        yield* syncRequests(roster.openWidgets);
        previousBots = new Map(bots.map((bot) => [bot.id, bot]));
        for (const [botId, until] of activeUntilMs) if (until <= nowMs) activeUntilMs.delete(botId);
        return {
          active:
            activeUntilMs.size > 0 ||
            bots.some((bot) => toBotActivityState(bot.status) === "working"),
        };
      });

      const rememberSend = (grokNonce: string, mattrNonce: string) => {
        mattrNonceByGrokNonce.set(grokNonce, mattrNonce);
        if (mattrNonceByGrokNonce.size <= MAX_TRACKED_SENDS) return;
        const oldest = mattrNonceByGrokNonce.keys().next().value;
        if (oldest !== undefined) mattrNonceByGrokNonce.delete(oldest);
      };

      return {
        capabilities: toBotProviderCapabilities(provider.capabilities),
        status: Effect.sync(() => ({
          kind: "connected" as const,
          detail: `Grok Bot${availability.app.version ? ` ${availability.app.version}` : ""} · ${botCount} ${botCount === 1 ? "Bot" : "Bots"}`,
        })),
        listBots: discover.pipe(
          Effect.map((roster) => {
            const widgetBotIds = new Set(roster.openWidgets.map((widget) => widget.botId));
            return roster.bots.map((bot) => toBotIdentity(bot, widgetBotIds));
          }),
        ),
        listConversations: ({ botId }) =>
          discover.pipe(
            Effect.map((roster) =>
              roster.bots
                .filter((bot) => botId === null || bot.id === botId)
                .map(toBotConversation),
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
          const result = yield* transcriptLock
            .withPermit(
              provider.sendMessage(conversationId, text).pipe(
                Effect.tap((sent) =>
                  Effect.sync(() => {
                    if (sent.grokNonce !== null) rememberSend(sent.grokNonce, clientNonce);
                  }),
                ),
              ),
            )
            .pipe(Effect.mapError(toBotProviderError));
          activeUntilMs.set(
            conversationId,
            (yield* Clock.currentTimeMillis) + SEND_ACTIVE_WINDOW_MS,
          );
          return {
            remoteId: `grok-send:${result.grokNonce ?? clientNonce}`,
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
        cancel: ({ conversationId }) =>
          provider.cancelRun(conversationId).pipe(
            Effect.mapError(toBotProviderError),
            Effect.flatMap((result) =>
              result.cancelled
                ? Effect.void
                : Effect.fail(
                    fail("failed", "Grok Bot couldn't stop this run. Stop it in Grok Bot."),
                  ),
            ),
          ),
        listPendingRequests: Effect.sync(() =>
          [...openRequests.values()].map((entry) => entry.request),
        ),
        respondToRequest: Effect.fn("GrokBotAdapter.respondToRequest")(function* ({
          requestId,
          response,
        }) {
          const open = openRequests.get(requestId);
          if (!open) return yield* fail("not_found", "This question was already answered.");
          if (response.kind !== "option") {
            return yield* fail("unsupported", "Pick one of Grok Bot's answers.");
          }
          const option = open.widget.options[Number(response.optionId)];
          if (!option) return yield* fail("not_found", "That answer isn't offered anymore.");
          yield* provider
            .respondToWidget(open.widget.botId, open.widget.entryId, option.value)
            .pipe(Effect.mapError(toBotProviderError));
          openRequests.delete(requestId);
          activeUntilMs.set(
            open.widget.botId,
            (yield* Clock.currentTimeMillis) + SEND_ACTIVE_WINDOW_MS,
          );
        }),
        poll,
      };
    }),
  };
  return adapter;
});
