import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BotsPlatformService from "./BotsPlatformService.ts";
import * as GrokBotAdapter from "./providers/grokBot/GrokBotAdapter.ts";

/**
 * Where Bots provider add-ons plug in: register the provider's adapter here. Registering is free;
 * a provider starts only once its add-on is on, and stops (closing its scope) when it is turned off.
 */
export const layerRegisteredBotProviders = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* BotsPlatformService.BotsPlatformService;
    yield* platform.register(yield* GrokBotAdapter.make());
  }),
);
