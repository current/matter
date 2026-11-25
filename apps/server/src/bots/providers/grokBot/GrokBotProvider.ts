import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

import {
  buildGrokBotLaunchCommand,
  buildGrokBotPluginDeepLink,
  buildGrokBotPromptDeepLink,
  getGrokBotActionFallback,
  type GrokBotActionCapabilityKey,
  type GrokBotActionFallback,
  type GrokBotCapabilities,
} from "./grokBotDeepLinks.ts";
import {
  GrokBotTransport,
  type GrokBotAvailability,
  type GrokBotCancelResult,
  type GrokBotMessagePage,
  type GrokBotSendResult,
  type GrokBotSummary,
  type GrokBotTransportError,
  type GrokBotTransportEvent,
  type GrokBotLoopbackViolationError,
} from "./GrokBotTransport.ts";

export const GROK_BOT_PROVIDER_ID = "grok-bot";
export const GROK_BOT_PROVIDER_NAME = "Grok Bot";

export interface GrokBotProviderShape {
  readonly id: typeof GROK_BOT_PROVIDER_ID;
  readonly name: typeof GROK_BOT_PROVIDER_NAME;
  readonly transportKind: string;
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
  readonly getActionFallback: (
    action: GrokBotActionCapabilityKey,
    context?: { readonly botId?: string; readonly text?: string },
  ) => GrokBotActionFallback;
  readonly buildPromptDeepLink: typeof buildGrokBotPromptDeepLink;
  readonly buildPluginDeepLink: typeof buildGrokBotPluginDeepLink;
  readonly buildLaunchCommand: typeof buildGrokBotLaunchCommand;
}

export class GrokBotProvider extends Context.Service<GrokBotProvider, GrokBotProviderShape>()(
  "t3/bots/providers/grokBot/GrokBotProvider",
) {}

const make = Effect.gen(function* () {
  const transport = yield* GrokBotTransport;

  return GrokBotProvider.of({
    id: GROK_BOT_PROVIDER_ID,
    name: GROK_BOT_PROVIDER_NAME,
    transportKind: transport.kind,
    capabilities: transport.capabilities,
    detectAvailability: transport.detectAvailability,
    discoverBots: transport.discoverBots,
    listMessages: transport.listMessages,
    sendMessage: transport.sendMessage,
    cancelRun: transport.cancelRun,
    subscribe: transport.subscribe,
    getActionFallback: (action, context) =>
      getGrokBotActionFallback(transport.capabilities, action, context),
    buildPromptDeepLink: buildGrokBotPromptDeepLink,
    buildPluginDeepLink: buildGrokBotPluginDeepLink,
    buildLaunchCommand: buildGrokBotLaunchCommand,
  });
});

export const layer = Layer.effect(GrokBotProvider, make);
