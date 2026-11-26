import * as Effect from "effect/Effect";

/**
 * mattr: MattrComposerPredictions replaces the providers' own next-prompt suggestions, so adapters
 * never pay for a second, competing prediction. The setting still turns mattr's predictor on and off.
 */
export const withoutNativePromptSuggestions = (
  _providerSetting: Effect.Effect<boolean>,
): Effect.Effect<boolean> => Effect.succeed(false);
