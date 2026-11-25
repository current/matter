import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type DevinBotAvailabilityState =
  | "connected"
  | "app_unavailable"
  | "enabled_unconfigured"
  | "incompatible_version";

export interface DevinBotAvailability {
  readonly state: DevinBotAvailabilityState;
  readonly appVersion: string | null;
  readonly targetUrl: string | null;
  readonly launchCommand: string;
}

/** The Bot's backing chat session, as `GET /poke/bots/{bot_id}/session` reports it. */
export interface DevinBotSessionState {
  readonly devinId: string;
  readonly status: string | null;
  readonly statusEnum: string | null;
  readonly isUnread: boolean;
  readonly needsAttention: boolean;
}

export interface DevinBotSummary {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly session: DevinBotSessionState | null;
}

export interface DevinInboxSummary {
  readonly botId: string;
  readonly boardId: string;
  readonly askCount: number;
}

export interface DevinBotSnapshot {
  readonly orgId: string;
  readonly bots: ReadonlyArray<DevinBotSummary>;
  readonly inboxes: ReadonlyArray<DevinInboxSummary>;
}

export interface DevinChildSession {
  /** Bare 32-hex id, as the v3 sessions list returns it. */
  readonly devinId: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly statusDetail: string | null;
  readonly updatedAtMs: number | null;
}

export interface DevinMessage {
  readonly eventId: string;
  readonly source: "user" | "devin";
  readonly text: string;
  readonly createdAtSec: number;
  readonly origin: string | null;
  /** Sent by a Devin principal (the Bot steering a child session), not by a person. */
  readonly fromAgent: boolean;
}

export interface DevinMessagePage {
  readonly messages: ReadonlyArray<DevinMessage>;
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

/** An unresolved "Needs you" inbox ticket on a Bot's board. */
export interface DevinInboxTicket {
  readonly boardId: string;
  readonly ticketId: string;
  readonly title: string;
  readonly detail: string | null;
  readonly cardType: string;
  readonly options: ReadonlyArray<string>;
  readonly buttons: ReadonlyArray<string>;
  readonly createdAt: string | null;
}

/** `inbox-resolve` actions Devin's own inbox cards send. */
export type DevinInboxAction = "answer" | "button" | "approve" | "acknowledge" | "dismiss";

export class DevinBotLoopbackViolationError extends Schema.TaggedError<DevinBotLoopbackViolationError>()(
  "DevinBotLoopbackViolationError",
  { host: Schema.String, port: Schema.Number },
) {
  override get message(): string {
    return `Refused non-loopback Devin CDP endpoint (${this.host}:${this.port}). Only 127.0.0.1 is permitted.`;
  }
}

export class DevinBotAppUnavailableError extends Schema.TaggedError<DevinBotAppUnavailableError>()(
  "DevinBotAppUnavailableError",
  {
    state: Schema.Literals(["app_unavailable", "enabled_unconfigured", "incompatible_version"]),
    port: Schema.Number,
  },
) {
  override get message(): string {
    if (this.state === "app_unavailable") return "Devin isn't installed on this Mac.";
    if (this.state === "incompatible_version") {
      return "Devin's debug port answered, but no Devin window was found on it.";
    }
    return `Devin isn't reachable on debug port ${this.port}.`;
  }
}

export class DevinBotCdpConnectionError extends Schema.TaggedError<DevinBotCdpConnectionError>()(
  "DevinBotCdpConnectionError",
  {
    stage: Schema.Literals(["discover_targets", "connect_socket", "socket_closed", "timeout"]),
    endpoint: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Devin CDP connection failed during ${this.stage} at ${this.endpoint}.`;
  }
}

export class DevinBotCdpProtocolError extends Schema.TaggedError<DevinBotCdpProtocolError>()(
  "DevinBotCdpProtocolError",
  {
    operation: Schema.String,
    code: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.code !== undefined
      ? `Devin CDP protocol error (${this.code}) during ${this.operation}.`
      : `Devin CDP protocol error during ${this.operation}.`;
  }
}

export const DevinBotBridgeReason = Schema.Literals([
  /** No mounted Devin webapp (e.g. Editor Mode) or its client could not be found. */
  "store_unavailable",
  "auth_required",
  "forbidden",
  "not_found",
  "rate_limited",
  "rejected",
  "invalid_args",
  "invalid_payload",
]);
export type DevinBotBridgeReason = typeof DevinBotBridgeReason.Type;

export class DevinBotBridgeError extends Schema.TaggedError<DevinBotBridgeError>()(
  "DevinBotBridgeError",
  {
    operation: Schema.String,
    reason: DevinBotBridgeReason,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return this.status !== undefined
      ? `Devin bridge ${this.operation} failed (${this.reason}, HTTP ${this.status}).`
      : `Devin bridge ${this.operation} failed (${this.reason}).`;
  }
}

export type DevinBotTransportError =
  | DevinBotLoopbackViolationError
  | DevinBotAppUnavailableError
  | DevinBotCdpConnectionError
  | DevinBotCdpProtocolError
  | DevinBotBridgeError;

type Op<A> = Effect.Effect<A, DevinBotTransportError>;

/**
 * Devin.app's embedded webapp, reached through its loopback DevTools port. Every call runs one
 * self-contained expression in the renderer that uses the webapp's own signed-in API client; no
 * credential ever leaves the renderer.
 */
export interface DevinBotTransportShape {
  readonly detectAvailability: Effect.Effect<DevinBotAvailability, DevinBotLoopbackViolationError>;
  readonly snapshot: Op<DevinBotSnapshot>;
  /** A small re-encoded WebP data URL of a Bot's avatar, or null if it can't be loaded. */
  readonly avatar: (url: string) => Op<string | null>;
  readonly childSessions: (devinId: string) => Op<ReadonlyArray<DevinChildSession>>;
  /** One forward page of a session's messages (oldest first). */
  readonly messages: (devinId: string, after: string | null) => Op<DevinMessagePage>;
  readonly inbox: (boardId: string) => Op<ReadonlyArray<DevinInboxTicket>>;
  /** Sends through Devin's REST API, so no ACP socket the user has open in Devin is touched. */
  readonly sendMessage: (devinId: string, text: string) => Op<void>;
  readonly sleep: (devinId: string) => Op<void>;
  readonly resolveInboxTicket: (input: {
    readonly boardId: string;
    readonly ticketId: string;
    readonly action: DevinInboxAction;
    readonly option: string | null;
  }) => Op<void>;
}

export class DevinBotTransport extends Context.Service<DevinBotTransport, DevinBotTransportShape>()(
  "t3/bots/providers/devinBot/DevinBotTransport",
) {}
