import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { GrokBotCapabilities } from "./grokBotDeepLinks.ts";

export type GrokBotAvailabilityState =
  | "connected"
  | "app_unavailable"
  | "enabled_unconfigured"
  | "incompatible_version"
  | "disconnected"
  | "error";

export type GrokBotActivityStatus =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "waiting"
  | "error"
  | "attention"
  | "offline";

export type GrokBotMessageRole = "user" | "assistant" | "system";

export interface GrokBotAppInfo {
  readonly installed: boolean;
  readonly appPath: string;
  readonly bundleId: string | null;
  readonly version: string | null;
  readonly urlSchemes: readonly string[];
}

export interface GrokBotAvailability {
  readonly state: GrokBotAvailabilityState;
  readonly app: GrokBotAppInfo;
  readonly cdpEndpoint: string;
  readonly targetTitle: string | null;
  readonly targetUrl: string | null;
  readonly launchCommand: string;
  readonly detail: string;
}

export interface GrokBotSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly avatarDataUrl: string | null;
  readonly avatarShape: string | null;
  readonly avatarColor: string | null;
  readonly status: GrokBotActivityStatus;
  readonly isRunning: boolean;
  readonly awaitingUserResponse: boolean;
  readonly unreadCount: number;
  readonly lastMessagePreview: string | null;
  readonly lastActivityAtMs: number | null;
  readonly deepLinkUrl: string;
}

export interface GrokBotMessage {
  readonly id: string;
  readonly seq: number | null;
  readonly botId: string;
  readonly role: GrokBotMessageRole;
  readonly text: string;
  readonly timestampMs: number | null;
  readonly clientNonce: string | null;
  readonly replyToId: string | null;
  readonly isStreaming: boolean;
}

export interface GrokBotMessagePage {
  readonly botId: string;
  readonly messages: readonly GrokBotMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface GrokBotSendResult {
  readonly botId: string;
  readonly clientNonce: string;
  readonly accepted: boolean;
  readonly messageId: string | null;
}

export interface GrokBotCancelResult {
  readonly botId: string;
  readonly cancelled: boolean;
  readonly fallbackDeepLinkUrl: string;
}

export type GrokBotTransportEvent =
  | {
      readonly type: "availability_changed";
      readonly availability: GrokBotAvailability;
    }
  | {
      readonly type: "bots_updated";
      readonly bots: readonly GrokBotSummary[];
    }
  | {
      readonly type: "bot_status_changed";
      readonly botId: string;
      readonly previousStatus: GrokBotActivityStatus;
      readonly status: GrokBotActivityStatus;
      readonly unreadCount: number;
    }
  | {
      readonly type: "message_upserted";
      readonly botId: string;
      readonly message: GrokBotMessage;
    }
  | {
      readonly type: "disconnected";
      readonly reason: string;
    };

export class GrokBotLoopbackViolationError extends Schema.TaggedError<GrokBotLoopbackViolationError>()(
  "GrokBotLoopbackViolationError",
  {
    host: Schema.String,
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `Refused non-loopback Grok Bot CDP endpoint (${this.host}:${this.port}). Only 127.0.0.1 is permitted.`;
  }
}

export class GrokBotAppUnavailableError extends Schema.TaggedError<GrokBotAppUnavailableError>()(
  "GrokBotAppUnavailableError",
  {
    appPath: Schema.String,
    state: Schema.Literals(["app_unavailable", "enabled_unconfigured", "incompatible_version"]),
    launchCommand: Schema.String,
  },
) {
  override get message(): string {
    if (this.state === "app_unavailable") {
      return `Grok Bot app is not installed at ${this.appPath}.`;
    }
    if (this.state === "incompatible_version") {
      return "Grok Bot is running, but no compatible renderer target was found on the loopback debug port.";
    }
    return `Grok Bot is not reachable on the loopback debug port. Launch it with: ${this.launchCommand}`;
  }
}

export class GrokBotCdpConnectionError extends Schema.TaggedError<GrokBotCdpConnectionError>()(
  "GrokBotCdpConnectionError",
  {
    stage: Schema.Literals(["discover_targets", "connect_socket", "socket_closed", "timeout"]),
    endpoint: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Grok Bot CDP connection failed during ${this.stage} at ${this.endpoint}.`;
  }
}

export class GrokBotCdpProtocolError extends Schema.TaggedError<GrokBotCdpProtocolError>()(
  "GrokBotCdpProtocolError",
  {
    operation: Schema.String,
    code: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.code !== undefined
      ? `Grok Bot CDP protocol error (${this.code}) during ${this.operation}.`
      : `Grok Bot CDP protocol error during ${this.operation}.`;
  }
}

export class GrokBotStoreBridgeError extends Schema.TaggedError<GrokBotStoreBridgeError>()(
  "GrokBotStoreBridgeError",
  {
    operation: Schema.Literals(["discover_bots", "list_messages", "send_message", "cancel_run"]),
    botId: Schema.optionalKey(Schema.String),
    reason: Schema.Literals([
      "store_unavailable",
      "bot_not_found",
      "invalid_payload",
      "action_rejected",
    ]),
  },
) {
  override get message(): string {
    return this.botId
      ? `Grok Bot bridge failed (${this.reason}) during ${this.operation} for bot ${this.botId}.`
      : `Grok Bot bridge failed (${this.reason}) during ${this.operation}.`;
  }
}

export type GrokBotTransportError =
  | GrokBotLoopbackViolationError
  | GrokBotAppUnavailableError
  | GrokBotCdpConnectionError
  | GrokBotCdpProtocolError
  | GrokBotStoreBridgeError;

export const isGrokBotLoopbackViolationError = Schema.is(GrokBotLoopbackViolationError);
export const isGrokBotAppUnavailableError = Schema.is(GrokBotAppUnavailableError);

export interface GrokBotTransportShape {
  readonly kind: string;
  readonly capabilities: GrokBotCapabilities;
  readonly detectAvailability: () => Effect.Effect<
    GrokBotAvailability,
    GrokBotLoopbackViolationError
  >;
  readonly discoverBots: () => Effect.Effect<readonly GrokBotSummary[], GrokBotTransportError>;
  readonly listMessages: (
    botId: string,
    cursor?: string,
  ) => Effect.Effect<GrokBotMessagePage, GrokBotTransportError>;
  readonly sendMessage: (
    botId: string,
    text: string,
    options?: { readonly clientNonce?: string },
  ) => Effect.Effect<GrokBotSendResult, GrokBotTransportError>;
  readonly cancelRun: (botId: string) => Effect.Effect<GrokBotCancelResult, GrokBotTransportError>;
  readonly subscribe: (options?: {
    readonly pollInterval?: Duration.Input;
  }) => Effect.Effect<
    PubSub.Subscription<GrokBotTransportEvent>,
    GrokBotTransportError,
    Scope.Scope
  >;
}

export class GrokBotTransport extends Context.Service<GrokBotTransport, GrokBotTransportShape>()(
  "t3/bots/providers/grokBot/GrokBotTransport",
) {}
