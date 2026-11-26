import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AddonIdSchema, AddonRuntimeStatus } from "./matterAddons.ts";

/**
 * Provider-independent model for external persistent agents ("Bots"). Agents, conversations and
 * delegated work are separate because providers relate them differently: Grok Bot has many Bots
 * with DMs and group chats, Muse one agent with many chats, Devin one chat per Bot that starts
 * many sessions. Ids are the provider's own and only unique within `(providerId, accountScopeId)`.
 */

export const BotProviderId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{1,47}$/),
);
export type BotProviderId = typeof BotProviderId.Type;

const RemoteId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const BotTransportKind = Schema.Literals([
  "direct-api",
  "session-api-derived",
  "local-app-bridge",
  "chat-bridge",
  "link-out",
]);
export type BotTransportKind = typeof BotTransportKind.Type;

/** Only states a provider actually reports; renderers never invent activity. */
export const BotActivityState = Schema.Literals([
  "idle",
  "working",
  "waiting_for_user",
  "waiting_for_approval",
  "finished",
  "suspended",
  "error",
  "offline",
  "unknown",
]);
export type BotActivityState = typeof BotActivityState.Type;

export const BotAvatar = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("data-url"),
    dataUrl: Schema.String.check(Schema.isPattern(/^data:image\/(png|jpeg|gif|webp);base64,/)),
  }),
  Schema.Struct({
    kind: Schema.Literal("parametric"),
    shape: TrimmedNonEmptyString,
    color: TrimmedNonEmptyString,
    seed: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("icon"),
    icon: TrimmedNonEmptyString,
  }),
]);
export type BotAvatar = typeof BotAvatar.Type;

export const BotMetadata = Schema.Record(Schema.String, Schema.Unknown);

export const BotIdentity = Schema.Struct({
  providerId: BotProviderId,
  remoteBotId: RemoteId,
  /** Account isolation key, e.g. a Devin org plus principal. Opaque to the client. */
  accountScopeId: RemoteId,
  name: TrimmedNonEmptyString,
  avatar: Schema.NullOr(BotAvatar),
  status: BotActivityState,
  unreadCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The 1:1 conversation for providers where a Bot has exactly one main chat. */
  defaultConversationId: Schema.NullOr(RemoteId),
  officialAppUrl: Schema.NullOr(Schema.String),
  metadata: BotMetadata,
});
export type BotIdentity = typeof BotIdentity.Type;

export const BotConversationKind = Schema.Literals([
  "direct",
  "side-chat",
  "group",
  "delegated-session",
]);
export type BotConversationKind = typeof BotConversationKind.Type;

export const BotConversation = Schema.Struct({
  conversationId: RemoteId,
  providerId: BotProviderId,
  accountScopeId: RemoteId,
  /** The Bot that owns the conversation; a group lists the rest in `participantBotIds`. */
  botId: RemoteId,
  participantBotIds: Schema.Array(RemoteId),
  kind: BotConversationKind,
  title: Schema.NullOr(Schema.String),
  parentConversationId: Schema.NullOr(RemoteId),
  unreadCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastActivityAt: Schema.NullOr(Schema.String),
  activityState: BotActivityState,
  officialAppUrl: Schema.NullOr(Schema.String),
});
export type BotConversation = typeof BotConversation.Type;

export const BotMessageRole = Schema.Literals(["user", "agent", "system"]);
export type BotMessageRole = typeof BotMessageRole.Type;

export const BotMessageAttribution = Schema.Literals([
  "user-via-matter",
  "user-via-other-client",
  "agent",
  "other-agent",
  "device",
  "system",
]);
export type BotMessageAttribution = typeof BotMessageAttribution.Type;

export const BotAttachment = Schema.Struct({
  id: RemoteId,
  name: Schema.String,
  mimeType: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Int),
  /** Served through Matter's server, never a provider URL that needs provider credentials. */
  url: Schema.NullOr(Schema.String),
});
export type BotAttachment = typeof BotAttachment.Type;

export const BotArtifact = Schema.Struct({
  id: RemoteId,
  kind: TrimmedNonEmptyString,
  title: Schema.String,
  fallbackText: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type BotArtifact = typeof BotArtifact.Type;

export const BotMessagePart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("markdown"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("attachment"), attachmentId: RemoteId }),
  Schema.Struct({ type: Schema.Literal("artifact"), artifactId: RemoteId }),
  /** Provider content Matter cannot render natively; the UI shows the text and a deep link. */
  Schema.Struct({ type: Schema.Literal("unsupported"), fallbackText: Schema.String }),
]);
export type BotMessagePart = typeof BotMessagePart.Type;

export const BotMessageDeliveryState = Schema.Literals(["sent", "pending", "failed"]);
export type BotMessageDeliveryState = typeof BotMessageDeliveryState.Type;

export const BotMessage = Schema.Struct({
  remoteId: RemoteId,
  conversationId: RemoteId,
  providerId: BotProviderId,
  role: BotMessageRole,
  attribution: BotMessageAttribution,
  authorBotId: Schema.NullOr(RemoteId),
  /** Plain markdown of the whole message, the fallback for any part the client cannot render. */
  markdown: Schema.String,
  parts: Schema.Array(BotMessagePart),
  replyToId: Schema.NullOr(RemoteId),
  attachments: Schema.Array(BotAttachment),
  artifacts: Schema.Array(BotArtifact),
  createdAt: Schema.String,
  /** Provider ordering when it has one; otherwise order by `createdAt`. */
  seq: Schema.NullOr(Schema.Int),
  /** Echoed from an optimistic send so the client can replace its pending copy. */
  clientNonce: Schema.NullOr(Schema.String),
  deliveryState: BotMessageDeliveryState,
});
export type BotMessage = typeof BotMessage.Type;

export const BotPendingRequestOption = Schema.Struct({
  id: RemoteId,
  label: Schema.String,
});

/** A question or approval the provider raised; kept by the server so it survives reconnects. */
export const BotPendingRequest = Schema.Struct({
  requestId: RemoteId,
  providerId: BotProviderId,
  accountScopeId: RemoteId,
  botId: RemoteId,
  conversationId: Schema.NullOr(RemoteId),
  kind: Schema.Literals(["question", "approval"]),
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  options: Schema.Array(BotPendingRequestOption),
  allowFreeText: Schema.Boolean,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
});
export type BotPendingRequest = typeof BotPendingRequest.Type;

export const BotHistorySupport = Schema.Literals(["none", "recent", "paged"]);
export type BotHistorySupport = typeof BotHistorySupport.Type;

/** How updates arrive: pushed by the provider, polled by the platform, or not at all. */
export const BotSyncMode = Schema.Literals(["push", "poll", "none"]);
export type BotSyncMode = typeof BotSyncMode.Type;

export const BotConversationCreation = Schema.Literals(["none", "client-minted", "api"]);
export type BotConversationCreation = typeof BotConversationCreation.Type;

/** What a provider (for the connected account) supports. The UI renders only what is declared. */
export const BotProviderCapabilities = Schema.Struct({
  agentDiscovery: Schema.Boolean,
  avatarMetadata: Schema.Boolean,
  conversationDiscovery: Schema.Boolean,
  history: BotHistorySupport,
  sendMessage: Schema.Boolean,
  /** Token-level streaming of replies, as opposed to whole messages. */
  streaming: Schema.Boolean,
  sync: BotSyncMode,
  activityEvents: Schema.Boolean,
  attachmentsIn: Schema.Boolean,
  artifactsOut: Schema.Boolean,
  cancel: Schema.Boolean,
  questions: Schema.Boolean,
  approvals: Schema.Boolean,
  createConversation: BotConversationCreation,
  manageAgents: Schema.Boolean,
  routines: Schema.Boolean,
  computerView: Schema.Boolean,
  voice: Schema.Boolean,
  officialAppDeepLink: Schema.Boolean,
  /** Sending wakes remote work that bills the user, so the UI confirms first. */
  creditSpendWarning: Schema.Boolean,
});
export type BotProviderCapabilities = typeof BotProviderCapabilities.Type;

export const NO_BOT_PROVIDER_CAPABILITIES: BotProviderCapabilities = {
  agentDiscovery: false,
  avatarMetadata: false,
  conversationDiscovery: false,
  history: "none",
  sendMessage: false,
  streaming: false,
  sync: "none",
  activityEvents: false,
  attachmentsIn: false,
  artifactsOut: false,
  cancel: false,
  questions: false,
  approvals: false,
  createConversation: "none",
  manageAgents: false,
  routines: false,
  computerView: false,
  voice: false,
  officialAppDeepLink: false,
  creditSpendWarning: false,
};

export const BotProviderDescriptor = Schema.Struct({
  providerId: BotProviderId,
  addonId: AddonIdSchema,
  displayName: TrimmedNonEmptyString,
  transport: BotTransportKind,
  experimental: Schema.Boolean,
  status: AddonRuntimeStatus,
  capabilities: BotProviderCapabilities,
  officialAppUrl: Schema.NullOr(Schema.String),
});
export type BotProviderDescriptor = typeof BotProviderDescriptor.Type;

export const BotProvidersResponse = Schema.Struct({
  providers: Schema.Array(BotProviderDescriptor),
});
export type BotProvidersResponse = typeof BotProvidersResponse.Type;

export const BotListResponse = Schema.Struct({ bots: Schema.Array(BotIdentity) });
export type BotListResponse = typeof BotListResponse.Type;

export const BotConversationListResponse = Schema.Struct({
  conversations: Schema.Array(BotConversation),
});
export type BotConversationListResponse = typeof BotConversationListResponse.Type;

export const MAX_BOT_MESSAGES_PAGE = 100;

export const BotMessagesPage = Schema.Struct({
  /** Oldest first. */
  messages: Schema.Array(BotMessage),
  /** Pass back to load older messages; null when there are none or history is not paged. */
  olderCursor: Schema.NullOr(Schema.String),
});
export type BotMessagesPage = typeof BotMessagesPage.Type;

const MAX_BOT_MESSAGE_CHARS = 32_000;

export const BotSendMessageRequest = Schema.Struct({
  providerId: BotProviderId,
  conversationId: RemoteId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_BOT_MESSAGE_CHARS)),
  clientNonce: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  replyToId: Schema.optionalKey(RemoteId),
  /** Required when the provider declares `creditSpendWarning`. */
  confirmUsage: Schema.optionalKey(Schema.Boolean),
});
export type BotSendMessageRequest = typeof BotSendMessageRequest.Type;

export const BotRespondRequest = Schema.Struct({
  providerId: BotProviderId,
  requestId: RemoteId,
  response: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("option"), optionId: RemoteId }),
    Schema.Struct({
      kind: Schema.Literal("text"),
      text: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_BOT_MESSAGE_CHARS)),
    }),
    Schema.Struct({
      kind: Schema.Literal("decision"),
      decision: Schema.Literals(["approve", "decline"]),
    }),
  ]),
});
export type BotRespondRequest = typeof BotRespondRequest.Type;

export const BotCancelRequest = Schema.Struct({
  providerId: BotProviderId,
  conversationId: RemoteId,
});
export type BotCancelRequest = typeof BotCancelRequest.Type;

export const BotPendingRequestsResponse = Schema.Struct({
  requests: Schema.Array(BotPendingRequest),
});
export type BotPendingRequestsResponse = typeof BotPendingRequestsResponse.Type;

/** The normalized event stream every provider transport is adapted into. */
export const BotEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("provider-status"),
    providerId: BotProviderId,
    status: AddonRuntimeStatus,
  }),
  Schema.Struct({
    type: Schema.Literal("bots-changed"),
    providerId: BotProviderId,
    bots: Schema.Array(BotIdentity),
  }),
  Schema.Struct({
    type: Schema.Literal("conversation-updated"),
    conversation: BotConversation,
  }),
  Schema.Struct({ type: Schema.Literal("message-upserted"), message: BotMessage }),
  Schema.Struct({
    type: Schema.Literal("message-delta"),
    providerId: BotProviderId,
    conversationId: RemoteId,
    remoteId: RemoteId,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("activity"),
    providerId: BotProviderId,
    botId: RemoteId,
    conversationId: Schema.NullOr(RemoteId),
    state: BotActivityState,
  }),
  Schema.Struct({ type: Schema.Literal("pending-request"), request: BotPendingRequest }),
  Schema.Struct({
    type: Schema.Literal("pending-request-resolved"),
    providerId: BotProviderId,
    requestId: RemoteId,
  }),
]);
export type BotEvent = typeof BotEvent.Type;

/** Error codes the bots HTTP routes return as `{ error }`. */
export const BotsErrorCode = Schema.Literals([
  "invalid_request",
  "provider_not_found",
  "provider_disabled",
  "provider_unavailable",
  "unsupported",
  "usage_confirmation_required",
  "not_found",
  "provider_error",
]);
export type BotsErrorCode = typeof BotsErrorCode.Type;
