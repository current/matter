import * as Layer from "effect/Layer";

import type * as BotsPlatformService from "./BotsPlatformService.ts";

/**
 * Where Bots provider add-ons plug in: merge a layer that calls `BotsPlatformService.register`
 * with the provider's adapter. Registering is free; a provider starts only once its add-on is on.
 */
export const layerRegisteredBotProviders: Layer.Layer<
  never,
  never,
  BotsPlatformService.BotsPlatformService
> = Layer.empty;
