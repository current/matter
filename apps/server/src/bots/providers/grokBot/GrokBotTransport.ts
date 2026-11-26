import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
  /** Grok Bot's own live status line while it works, e.g. "is searching X for composers". */
  readonly activityDetail: string | null;
  readonly deepLinkUrl: string;
}

export interface GrokBotWidgetOption {
  readonly label: string;
  readonly value: string;
}

/** A multiple-choice question a Bot asked that nobody has answered yet. */
export interface GrokBotOpenWidget {
  readonly botId: string;
  readonly entryId: string;
  readonly prompt: string;
  readonly options: readonly GrokBotWidgetOption[];
  readonly timestampMs: number | null;
}

export interface GrokBotRoster {
  readonly bots: readonly GrokBotSummary[];
  readonly openWidgets: readonly GrokBotOpenWidget[];
}

export interface GrokBotAttachment {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number | null;
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
  readonly attachments: readonly GrokBotAttachment[];
  /** Set when another Bot, not the user, wrote this message. */
  readonly fromAgentName: string | null;
  readonly fromAgentId: string | null;
  readonly widget: {
    readonly options: readonly GrokBotWidgetOption[];
    readonly respondedValue: string | null;
  } | null;
  /** A Grok Bot card Matter can't draw, such as a connector prompt. */
  readonly cardType: string | null;
}

export interface GrokBotMessagePage {
  readonly botId: string;
  readonly messages: readonly GrokBotMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface GrokBotSendResult {
  readonly botId: string;
  /** The nonce Grok Bot gave the send; its transcript echoes it on the user message. */
  readonly grokNonce: string | null;
  /** "queued" when Grok Bot journaled it but hasn't confirmed delivery yet. */
  readonly state: "delivered" | "queued";
}

export interface GrokBotCancelResult {
  readonly botId: string;
  readonly cancelled: boolean;
  readonly fallbackDeepLinkUrl: string;
}

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

export const GrokBotBridgeOperation = Schema.Literals([
  "discover_bots",
  "list_messages",
  "send_message",
  "cancel_run",
  "respond_widget",
]);
export type GrokBotBridgeOperation = typeof GrokBotBridgeOperation.Type;

export class GrokBotStoreBridgeError extends Schema.TaggedError<GrokBotStoreBridgeError>()(
  "GrokBotStoreBridgeError",
  {
    operation: GrokBotBridgeOperation,
    botId: Schema.optionalKey(Schema.String),
    /** Grok Bot's own failure code, such as `send/agent-read-only`. */
    code: Schema.optionalKey(Schema.String),
    reason: Schema.Literals([
      "store_unavailable",
      "bot_not_found",
      "invalid_payload",
      "action_rejected",
    ]),
  },
) {
  override get message(): string {
    const code = this.code ? `, ${this.code}` : "";
    return this.botId
      ? `Grok Bot bridge failed (${this.reason}${code}) during ${this.operation} for bot ${this.botId}.`
      : `Grok Bot bridge failed (${this.reason}${code}) during ${this.operation}.`;
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
  readonly discoverBots: () => Effect.Effect<GrokBotRoster, GrokBotTransportError>;
  readonly listMessages: (
    botId: string,
    cursor?: string,
  ) => Effect.Effect<GrokBotMessagePage, GrokBotTransportError>;
  readonly sendMessage: (
    botId: string,
    text: string,
  ) => Effect.Effect<GrokBotSendResult, GrokBotTransportError>;
  readonly cancelRun: (botId: string) => Effect.Effect<GrokBotCancelResult, GrokBotTransportError>;
  readonly respondToWidget: (
    botId: string,
    entryId: string,
    value: string,
  ) => Effect.Effect<void, GrokBotTransportError>;
}

export class GrokBotTransport extends Context.Service<GrokBotTransport, GrokBotTransportShape>()(
  "t3/bots/providers/grokBot/GrokBotTransport",
) {}
