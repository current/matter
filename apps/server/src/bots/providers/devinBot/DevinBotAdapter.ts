import {
  NO_BOT_PROVIDER_CAPABILITIES,
  devinBotCdpPortFromConfig,
  type BotActivityState,
  type BotConversation,
  type BotIdentity,
  type BotMessage,
  type BotPendingRequest,
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
import * as DevinBotCdpTransport from "./DevinBotCdpTransport.ts";
import {
  bareDevinId,
  buildDevinAppPathDeepLink,
  buildDevinBotDeepLink,
  buildDevinBotWebUrl,
  buildDevinSessionDeepLink,
  DEVIN_APP_PATH,
} from "./devinBotDeepLinks.ts";
import {
  DevinBotTransport,
  type DevinBotAvailability,
  type DevinBotSnapshot,
  type DevinBotSummary,
  type DevinChildSession,
  type DevinInboxTicket,
  type DevinMessage,
  type DevinBotTransportError,
  type DevinBotTransportShape,
} from "./DevinBotTransport.ts";

const DEVIN_BOT_PROVIDER_ID = "devin-bot";
const DEFAULT_POLL_INTERVALS: BotProviderPollIntervals = { idleMs: 15_000, activeMs: 5_000 };
/** Forward pages walked per sync; at 200 messages a page this covers very long sessions. */
const MAX_PAGES_PER_SYNC = 50;
const CHILD_CONVERSATION_PREFIX = "session:";

export const DEVIN_BOT_CAPABILITIES: BotProviderCapabilities = {
  ...NO_BOT_PROVIDER_CAPABILITIES,
  agentDiscovery: true,
  avatarMetadata: true,
  conversationDiscovery: true,
  history: "paged",
  sendMessage: true,
  sync: "poll",
  activityEvents: true,
  cancel: true,
  questions: true,
  approvals: true,
  officialAppDeepLink: true,
  // Messaging a suspended Bot wakes its cloud session, which spends ACUs.
  creditSpendWarning: true,
};

export interface DevinBotAdapterOptions {
  readonly appPath?: string;
  readonly pollIntervals?: BotProviderPollIntervals;
}

const fail = (reason: BotProviderError["reason"], detail?: string) =>
  new BotProviderError({
    providerId: DEVIN_BOT_PROVIDER_ID,
    reason,
    ...(detail ? { detail } : {}),
  });

function toBotProviderError(error: DevinBotTransportError): BotProviderError {
  switch (error._tag) {
    case "DevinBotAppUnavailableError":
      return fail(
        error.state === "app_unavailable"
          ? "unavailable"
          : error.state === "enabled_unconfigured"
            ? "unconfigured"
            : "incompatible_version",
        error.message,
      );
    case "DevinBotCdpConnectionError":
      return fail("disconnected", "Lost the connection to Devin's debug port.");
    case "DevinBotBridgeError":
      switch (error.reason) {
        case "store_unavailable":
          return fail("disconnected", "Open Devin's agent view so mattr can reach your Bots.");
        case "auth_required":
          return fail("auth_required", "Sign in to Devin, then try again.");
        case "not_found":
          return fail("not_found", error.message);
        case "rate_limited":
          return fail("rate_limited", "Devin is rate limiting requests. Try again shortly.");
        default:
          return fail("failed", error.message);
      }
    case "DevinBotCdpProtocolError":
    case "DevinBotLoopbackViolationError":
      return fail("failed", error.message);
  }
}

function availabilityError(availability: DevinBotAvailability, port: number): BotProviderError {
  switch (availability.state) {
    case "app_unavailable":
      return fail("unavailable", "Devin isn't installed on this Mac.");
    case "enabled_unconfigured":
      return fail("unconfigured", `Devin isn't reachable on debug port ${port}.`);
    default:
      return fail(
        "incompatible_version",
        "Devin's debug port answered, but no Devin window was found.",
      );
  }
}

const RUNNING = new Set(["running", "claimed", "resuming", "new"]);

function toDevinBotActivity(bot: DevinBotSummary): BotActivityState {
  const session = bot.session;
  if (!session) return "idle";
  if (session.needsAttention || session.statusEnum === "blocked") return "waiting_for_user";
  if (session.status === "error") return "error";
  if (session.status !== null && RUNNING.has(session.status)) {
    return session.statusEnum === "finished" ? "idle" : "working";
  }
  return "idle";
}

function toDevinChildActivity(session: DevinChildSession): BotActivityState {
  switch (session.status) {
    case "running":
      switch (session.statusDetail) {
        case "waiting_for_user":
          return "waiting_for_user";
        case "waiting_for_approval":
          return "waiting_for_approval";
        case "finished":
          return "finished";
        default:
          return "working";
      }
    case "new":
    case "claimed":
    case "resuming":
      return "working";
    case "suspended":
      return "suspended";
    case "exit":
      return "finished";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

const isoFromMs = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

interface HistoryCache {
  readonly messages: DevinMessage[];
  readonly seen: Set<string>;
  /** The `after` cursor that produced the newest page; Devin returns no cursor past the end. */
  lastAfter: string | null;
}

/** `boardId:ticketId`, so a response can find its ticket again after a restart. */
const requestIdOf = (ticket: DevinInboxTicket) => `${ticket.boardId}:${ticket.ticketId}`;

function toDevinPendingRequest(
  ticket: DevinInboxTicket,
  context: { readonly botId: string; readonly accountScopeId: string; readonly nowIso: string },
): BotPendingRequest {
  const approval = ticket.cardType === "approval" || ticket.cardType === "doc_review";
  const options = approval
    ? []
    : ticket.cardType === "decision" && ticket.options.length > 0
      ? ticket.options.map((label, index) => ({ id: `answer:${index}`, label }))
      : ticket.buttons.length > 0
        ? ticket.buttons.map((label, index) => ({ id: `button:${index}`, label }))
        : [
            { id: "acknowledge", label: "Done" },
            { id: "dismiss", label: "Dismiss" },
          ];
  const created = ticket.createdAt ? Date.parse(ticket.createdAt) : Number.NaN;
  return {
    requestId: requestIdOf(ticket),
    providerId: DEVIN_BOT_PROVIDER_ID,
    accountScopeId: context.accountScopeId,
    botId: context.botId,
    conversationId: context.botId,
    kind: approval ? "approval" : "question",
    title: ticket.title,
    detail: ticket.detail,
    options,
    allowFreeText: false,
    createdAt: Number.isFinite(created) ? isoFromMs(created) : context.nowIso,
    expiresAt: null,
  };
}

/** Maps a pending-request response to Devin's own inbox-resolve action. */
function toDevinInboxResolution(
  ticket: DevinInboxTicket,
  response:
    | { readonly kind: "option"; readonly optionId: string }
    | { readonly kind: "decision"; readonly decision: "approve" | "decline" }
    | { readonly kind: "text"; readonly text: string },
) {
  if (response.kind === "text") return null;
  if (response.kind === "decision") {
    return response.decision === "approve"
      ? { action: "approve" as const, option: null }
      : { action: "dismiss" as const, option: null };
  }
  const [kind, rawIndex] = response.optionId.split(":");
  if (kind === "acknowledge" || kind === "dismiss") return { action: kind, option: null };
  const labels = kind === "answer" ? ticket.options : kind === "button" ? ticket.buttons : null;
  const label = labels?.[Number(rawIndex)];
  if (!labels || label === undefined) return null;
  return { action: kind === "answer" ? ("answer" as const) : ("button" as const), option: label };
}

const botFingerprint = (bot: DevinBotSummary, askCount: number, avatar: string | null) =>
  [
    bot.name,
    bot.avatarUrl,
    avatar?.length ?? 0,
    bot.session?.devinId,
    bot.session?.status,
    bot.session?.statusEnum,
    bot.session?.isUnread,
    bot.session?.needsAttention,
    askCount,
  ].join("\u0000");

/**
 * Devin Bots through Devin.app's loopback Chrome DevTools port. Every call reuses the signed-in
 * webapp's own API client inside the renderer, so no credential reaches mattr. It only probes
 * 127.0.0.1 on the configured port and never launches, quits or restarts Devin.app.
 */
export const make = Effect.fn("DevinBotAdapter.make")(function* (
  options: DevinBotAdapterOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const appPath = options.appPath ?? DEVIN_APP_PATH;

  const adapter: BotProviderAdapter = {
    providerId: DEVIN_BOT_PROVIDER_ID,
    addonId: "devin-bot",
    displayName: "Devin Bot",
    transport: "local-app-bridge",
    experimental: true,
    officialAppUrl: buildDevinAppPathDeepLink("/bots"),
    pollIntervals: options.pollIntervals ?? DEFAULT_POLL_INTERVALS,
    start: Effect.fn("DevinBotAdapter.start")(function* (context) {
      const port = devinBotCdpPortFromConfig(context.config);
      const built = yield* Layer.buildWithScope(
        DevinBotCdpTransport.layerLive({ port, appPath }).pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
        ),
        yield* Effect.scope,
      );
      const transport: DevinBotTransportShape = yield* Effect.service(DevinBotTransport).pipe(
        Effect.provide(built),
      );
      const call = <A>(effect: Effect.Effect<A, DevinBotTransportError>) =>
        effect.pipe(Effect.mapError(toBotProviderError));

      const availability = yield* call(transport.detectAvailability);
      if (availability.state !== "connected") return yield* availabilityError(availability, port);

      let snapshot: DevinBotSnapshot = yield* call(transport.snapshot);
      const accountScopeId = snapshot.orgId;
      const avatars = new Map<string, string | null>();
      const histories = new Map<string, HistoryCache>();
      const sentTexts = new Map<string, string>();
      const tickets = new Map<
        string,
        { readonly ticket: DevinInboxTicket; readonly botId: string }
      >();
      let previousBots: Map<string, string> | null = null;
      let previousActivity = new Map<string, BotActivityState>();

      const refresh = Effect.gen(function* () {
        const next = yield* call(transport.snapshot);
        if (next.orgId !== accountScopeId) {
          return yield* fail("disconnected", "Devin switched organizations; reconnecting.");
        }
        snapshot = next;
        return next;
      });

      const loadAvatars = Effect.suspend(() =>
        Effect.forEach(
          snapshot.bots,
          (bot) =>
            bot.avatarUrl === null || avatars.has(bot.avatarUrl)
              ? Effect.void
              : transport.avatar(bot.avatarUrl).pipe(
                  Effect.orElseSucceed(() => null),
                  Effect.map((dataUrl) => {
                    if (bot.avatarUrl !== null) avatars.set(bot.avatarUrl, dataUrl);
                  }),
                ),
          { discard: true },
        ),
      );

      const askCountOf = (botId: string) =>
        snapshot.inboxes.find((inbox) => inbox.botId === botId)?.askCount ?? 0;
      const avatarOf = (bot: DevinBotSummary) =>
        bot.avatarUrl === null ? null : (avatars.get(bot.avatarUrl) ?? null);

      const toIdentity = (bot: DevinBotSummary): BotIdentity => {
        const avatar = avatarOf(bot);
        return {
          providerId: DEVIN_BOT_PROVIDER_ID,
          remoteBotId: bot.id,
          accountScopeId,
          name: bot.name,
          avatar: avatar ? { kind: "data-url", dataUrl: avatar } : { kind: "icon", icon: "bot" },
          status: toDevinBotActivity(bot),
          unreadCount: bot.session?.isUnread ? 1 : 0,
          defaultConversationId: bot.id,
          officialAppUrl: buildDevinBotDeepLink(bot.id),
          metadata: {
            webUrl: buildDevinBotWebUrl(bot.id),
            devinStatus: bot.session?.status ?? null,
            pendingAsks: askCountOf(bot.id),
          },
        };
      };

      const toMainConversation = (bot: DevinBotSummary): BotConversation => ({
        conversationId: bot.id,
        providerId: DEVIN_BOT_PROVIDER_ID,
        accountScopeId,
        botId: bot.id,
        participantBotIds: [],
        kind: "direct",
        title: null,
        parentConversationId: null,
        unreadCount: bot.session?.isUnread ? 1 : 0,
        lastActivityAt: null,
        activityState: toDevinBotActivity(bot),
        officialAppUrl: buildDevinBotDeepLink(bot.id),
      });

      const toChildConversation = (
        bot: DevinBotSummary,
        child: DevinChildSession,
      ): BotConversation => ({
        conversationId: `${CHILD_CONVERSATION_PREFIX}${child.devinId}`,
        providerId: DEVIN_BOT_PROVIDER_ID,
        accountScopeId,
        botId: bot.id,
        participantBotIds: [],
        kind: "delegated-session",
        title: child.title,
        parentConversationId: bot.id,
        unreadCount: 0,
        lastActivityAt: child.updatedAtMs === null ? null : isoFromMs(child.updatedAtMs),
        activityState: toDevinChildActivity(child),
        officialAppUrl: buildDevinSessionDeepLink(child.devinId),
      });

      /** A conversation id to its Devin session id and the Bot that owns it. */
      const resolveConversation = Effect.fn("DevinBotAdapter.resolveConversation")(function* (
        conversationId: string,
      ) {
        if (conversationId.startsWith(CHILD_CONVERSATION_PREFIX)) {
          const devinId = bareDevinId(conversationId.slice(CHILD_CONVERSATION_PREFIX.length));
          if (!devinId) return yield* fail("not_found", "That Devin session doesn't exist.");
          return { devinId, botId: null as string | null, child: true };
        }
        const find = (bots: ReadonlyArray<DevinBotSummary>) =>
          bots.find((bot) => bot.id === conversationId);
        const bot = find(snapshot.bots) ?? find((yield* refresh).bots);
        if (!bot) return yield* fail("not_found", "That Devin Bot doesn't exist.");
        if (!bot.session) return yield* fail("not_found", "This Bot has no chat session yet.");
        return { devinId: bot.session.devinId, botId: bot.id, child: false };
      });

      const toMessage = (
        conversationId: string,
        botId: string | null,
        message: DevinMessage,
        seq: number,
      ): BotMessage => {
        const fromDevin = message.source === "devin";
        const nonce = !fromDevin ? sentTexts.get(message.text) : undefined;
        const role = fromDevin || message.fromAgent ? "agent" : "user";
        return {
          remoteId: message.eventId,
          conversationId,
          providerId: DEVIN_BOT_PROVIDER_ID,
          role,
          attribution: fromDevin
            ? "agent"
            : message.fromAgent
              ? "other-agent"
              : nonce !== undefined
                ? "user-via-mattr"
                : "user-via-other-client",
          authorBotId: role === "agent" ? botId : null,
          markdown: message.text,
          parts: [{ type: "markdown", text: message.text }],
          replyToId: null,
          attachments: [],
          artifacts: [],
          createdAt: isoFromMs(message.createdAtSec * 1_000),
          seq,
          clientNonce: nonce ?? null,
          deliveryState: "sent",
        };
      };

      /** Walks forward from the newest known page and returns the messages it hadn't seen. */
      const syncHistory = Effect.fn("DevinBotAdapter.syncHistory")(function* (devinId: string) {
        const cache = histories.get(devinId) ?? { messages: [], seen: new Set(), lastAfter: null };
        histories.set(devinId, cache);
        const added: Array<{ readonly message: DevinMessage; readonly seq: number }> = [];
        for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
          const result = yield* call(transport.messages(devinId, cache.lastAfter));
          for (const message of result.messages) {
            if (cache.seen.has(message.eventId)) continue;
            cache.seen.add(message.eventId);
            cache.messages.push(message);
            added.push({ message, seq: cache.messages.length - 1 });
          }
          if (!result.hasNextPage || result.endCursor === null) break;
          cache.lastAfter = result.endCursor;
        }
        return added;
      });

      const syncConversation = Effect.fn("DevinBotAdapter.syncConversation")(function* (
        conversationId: string,
        devinId: string,
      ) {
        const added = yield* syncHistory(devinId);
        const botId = conversationId.startsWith(CHILD_CONVERSATION_PREFIX) ? null : conversationId;
        yield* Effect.forEach(
          added,
          ({ message, seq }) =>
            context.emit({
              type: "message-upserted",
              message: toMessage(conversationId, botId, message, seq),
            }),
          { discard: true },
        );
      });

      /** Open "Needs you" tickets for every Bot that has asks. */
      const collectPending = Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const requests = new Map<string, BotPendingRequest>();
        tickets.clear();
        for (const inbox of snapshot.inboxes) {
          if (inbox.askCount === 0) continue;
          const open = yield* call(transport.inbox(inbox.boardId));
          for (const ticket of open) {
            const request = toDevinPendingRequest(ticket, {
              botId: inbox.botId,
              accountScopeId,
              nowIso,
            });
            tickets.set(request.requestId, { ticket, botId: inbox.botId });
            requests.set(request.requestId, request);
          }
        }
        return requests;
      });
      let previousRequests = new Map<string, BotPendingRequest>();

      const poll = Effect.gen(function* () {
        const next = yield* refresh;
        yield* loadAvatars;
        const fingerprints = new Map(
          next.bots.map((bot) => [bot.id, botFingerprint(bot, askCountOf(bot.id), avatarOf(bot))]),
        );
        const before = previousBots;
        const changed =
          before === null ||
          before.size !== fingerprints.size ||
          [...fingerprints].some(([id, fingerprint]) => before.get(id) !== fingerprint);
        if (changed) {
          yield* context.emit({
            type: "bots-changed",
            providerId: DEVIN_BOT_PROVIDER_ID,
            bots: next.bots.map(toIdentity),
          });
        }

        const activity = new Map<string, BotActivityState>();
        for (const bot of next.bots) {
          const state = toDevinBotActivity(bot);
          activity.set(bot.id, state);
          const prior = previousActivity.get(bot.id);
          if (prior !== undefined && prior !== state) {
            yield* context.emit({
              type: "activity",
              providerId: DEVIN_BOT_PROVIDER_ID,
              botId: bot.id,
              conversationId: bot.id,
              state,
            });
          }
          const devinId = bot.session?.devinId;
          const opened = devinId !== undefined && histories.has(devinId);
          const moved = before?.get(bot.id) !== fingerprints.get(bot.id);
          if (devinId !== undefined && opened && (state === "working" || moved)) {
            yield* syncConversation(bot.id, devinId);
          }
        }
        // Child sessions run on their own, so opened ones sync every tick.
        for (const devinId of histories.keys()) {
          if (next.bots.some((bot) => bot.session?.devinId === devinId)) continue;
          yield* syncConversation(`${CHILD_CONVERSATION_PREFIX}${devinId}`, devinId);
        }
        previousBots = fingerprints;
        previousActivity = activity;

        const requests = yield* collectPending;
        for (const [requestId, request] of requests) {
          if (!previousRequests.has(requestId)) {
            yield* context.emit({ type: "pending-request", request });
          }
        }
        for (const requestId of previousRequests.keys()) {
          if (!requests.has(requestId)) {
            yield* context.emit({
              type: "pending-request-resolved",
              providerId: DEVIN_BOT_PROVIDER_ID,
              requestId,
            });
          }
        }
        previousRequests = requests;
        return { active: [...activity.values()].some((state) => state === "working") };
      });

      return {
        capabilities: DEVIN_BOT_CAPABILITIES,
        status: Effect.succeed({ kind: "connected" as const }),
        listBots: Effect.gen(function* () {
          const next = yield* refresh;
          yield* loadAvatars;
          return next.bots.map(toIdentity);
        }),
        listConversations: Effect.fn("DevinBotAdapter.listConversations")(function* ({ botId }) {
          const next = yield* refresh;
          const bots = next.bots.filter((bot) => botId === null || bot.id === botId);
          // Child sessions only for one Bot's view; the full list would cost a request per Bot.
          if (botId === null) return bots.map(toMainConversation);
          return yield* Effect.forEach(bots, (bot) =>
            bot.session === null
              ? Effect.succeed([toMainConversation(bot)])
              : call(transport.childSessions(bot.session.devinId)).pipe(
                  Effect.map((children) => [
                    toMainConversation(bot),
                    ...children.map((child) => toChildConversation(bot, child)),
                  ]),
                ),
          ).pipe(Effect.map((groups) => groups.flat()));
        }),
        getMessages: Effect.fn("DevinBotAdapter.getMessages")(function* ({
          conversationId,
          olderCursor,
          limit,
        }) {
          const { devinId, botId } = yield* resolveConversation(conversationId);
          if (olderCursor === null) yield* syncHistory(devinId);
          const cache = histories.get(devinId);
          const all = cache?.messages ?? [];
          const parsed = olderCursor?.startsWith("idx:")
            ? Number(olderCursor.slice(4))
            : all.length;
          const end = Number.isInteger(parsed)
            ? Math.max(0, Math.min(all.length, parsed))
            : all.length;
          const start = Math.max(0, end - limit);
          return {
            messages: all
              .slice(start, end)
              .map((message, index) => toMessage(conversationId, botId, message, start + index)),
            olderCursor: start > 0 ? `idx:${start}` : null,
          };
        }),
        sendMessage: Effect.fn("DevinBotAdapter.sendMessage")(function* ({
          conversationId,
          text,
          clientNonce,
        }) {
          const { devinId } = yield* resolveConversation(conversationId);
          // Devin echoes no nonce, so a sent text is matched back to it when it shows up in history.
          if (sentTexts.size >= 200) sentTexts.delete(sentTexts.keys().next().value ?? "");
          sentTexts.set(text, clientNonce);
          yield* call(transport.sendMessage(devinId, text));
          return {
            remoteId: `pending:${clientNonce}`,
            conversationId,
            providerId: DEVIN_BOT_PROVIDER_ID,
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
        // Devin's own "sleep" command: the session stops and can be woken by a new message.
        cancel: ({ conversationId }) =>
          resolveConversation(conversationId).pipe(
            Effect.flatMap(({ devinId }) => call(transport.sleep(devinId))),
          ),
        listPendingRequests: Effect.gen(function* () {
          yield* refresh;
          previousRequests = yield* collectPending;
          return [...previousRequests.values()];
        }),
        respondToRequest: Effect.fn("DevinBotAdapter.respondToRequest")(function* ({
          requestId,
          response,
        }) {
          const entry = tickets.get(requestId);
          if (!entry) return yield* fail("not_found", "That request was already answered.");
          const resolution = toDevinInboxResolution(entry.ticket, response);
          if (!resolution) {
            return yield* fail("unsupported", "Answer this request in Devin.");
          }
          yield* call(
            transport.resolveInboxTicket({
              boardId: entry.ticket.boardId,
              ticketId: entry.ticket.ticketId,
              ...resolution,
            }),
          );
          tickets.delete(requestId);
          previousRequests.delete(requestId);
        }),
        poll,
      };
    }),
  };
  return adapter;
});
