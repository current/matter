import type {
  AddonConfig,
  AddonId,
  AddonRuntimeStatus,
  BotConversation,
  BotEvent,
  BotIdentity,
  BotMessage,
  BotMessagesPage,
  BotPendingRequest,
  BotProviderCapabilities,
  BotRespondRequest,
  BotTransportKind,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class BotProviderError extends Schema.TaggedError<BotProviderError>()("BotProviderError", {
  providerId: Schema.String,
  reason: Schema.Literals([
    "unavailable",
    "auth_required",
    "incompatible_version",
    "unsupported",
    "not_found",
    "rate_limited",
    "failed",
  ]),
  /** Shown to the user; never put credentials or raw provider responses here. */
  detail: Schema.optional(Schema.String),
}) {}

export interface BotProviderContext {
  /** The add-on's non-secret config. Credentials come from secret storage, never from here. */
  readonly config: AddonConfig;
  /** Publishes a normalized event to every subscribed client. */
  readonly emit: (event: BotEvent) => Effect.Effect<void>;
}

export interface BotPollResult {
  /** Remote work is running, so the platform polls at the faster interval. */
  readonly active: boolean;
}

/** A started provider. Optional operations are absent when the provider can't do them. */
export interface BotProviderSession {
  readonly capabilities: BotProviderCapabilities;
  readonly status: Effect.Effect<AddonRuntimeStatus>;
  readonly listBots: Effect.Effect<ReadonlyArray<BotIdentity>, BotProviderError>;
  readonly listConversations: (input: {
    readonly botId: string | null;
  }) => Effect.Effect<ReadonlyArray<BotConversation>, BotProviderError>;
  readonly getMessages: (input: {
    readonly conversationId: string;
    readonly olderCursor: string | null;
    readonly limit: number;
  }) => Effect.Effect<BotMessagesPage, BotProviderError>;
  readonly sendMessage?: (input: {
    readonly conversationId: string;
    readonly text: string;
    readonly clientNonce: string;
    readonly replyToId: string | null;
  }) => Effect.Effect<BotMessage, BotProviderError>;
  readonly respondToRequest?: (input: {
    readonly requestId: string;
    readonly response: BotRespondRequest["response"];
  }) => Effect.Effect<void, BotProviderError>;
  readonly cancel?: (input: {
    readonly conversationId: string;
  }) => Effect.Effect<void, BotProviderError>;
  readonly listPendingRequests?: Effect.Effect<ReadonlyArray<BotPendingRequest>, BotProviderError>;
  /** One sync tick for poll-mode providers. The platform owns the schedule and backoff. */
  readonly poll?: Effect.Effect<BotPollResult, BotProviderError>;
}

export interface BotProviderPollIntervals {
  readonly idleMs: number;
  readonly activeMs: number;
}

/**
 * A Bots provider plugged into the platform. `start` runs only while the provider's add-on is
 * enabled; every socket, timer and subscription it opens must be tied to the given scope, which
 * the platform closes on disable. Closing must release local resources only: it never cancels
 * remote work.
 */
export interface BotProviderAdapter {
  readonly providerId: string;
  readonly addonId: AddonId;
  readonly displayName: string;
  readonly transport: BotTransportKind;
  readonly experimental: boolean;
  readonly officialAppUrl: string | null;
  readonly pollIntervals?: BotProviderPollIntervals;
  readonly start: (
    context: BotProviderContext,
  ) => Effect.Effect<BotProviderSession, BotProviderError, Scope.Scope>;
}
