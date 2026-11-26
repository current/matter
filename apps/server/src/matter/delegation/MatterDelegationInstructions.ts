import { DEFAULT_SERVER_SETTINGS, type ServerProvider } from "@t3tools/contracts";
import { setAddonRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { buildMattrDelegationInstructions, mattrDelegationPool } from "./mattrDelegationPolicy.ts";

const MATTR_DELEGATION_INSTRUCTIONS_ID = "mattr-delegation";

/**
 * Keeps the `<mattr_delegation>` session block in step with settings and the provider inventory.
 * Sessions read it synchronously when they start, so the text is kept current here.
 */
export class MattrDelegationInstructions extends Context.Service<
  MattrDelegationInstructions,
  {
    /** The block new sessions get; "" while delegation is off or has fewer than two instances. */
    readonly changes: Stream.Stream<string>;
  }
>()("t3/mattr/delegation/MattrDelegationInstructions") {}

export const layer = Layer.effect(
  MattrDelegationInstructions,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry;
    let settings = DEFAULT_SERVER_SETTINGS;
    let providers: ReadonlyArray<ServerProvider> = [];
    let text = "";
    const ref = yield* SubscriptionRef.make(text);
    const recompute = Effect.suspend(() => {
      text = buildMattrDelegationInstructions(settings, mattrDelegationPool(providers, settings));
      return SubscriptionRef.set(ref, text);
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => setAddonRuntimeInstructions(MATTR_DELEGATION_INSTRUCTIONS_ID, () => text)),
      () => Effect.sync(() => setAddonRuntimeInstructions(MATTR_DELEGATION_INSTRUCTIONS_ID, null)),
    );

    const settingsChanges = yield* settingsService.subscribeChanges;
    yield* forkParked(
      Effect.gen(function* () {
        settings = yield* settingsService.getSettings.pipe(
          Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
        );
        yield* recompute;
        yield* Stream.runForEach(settingsChanges, (next) =>
          Effect.suspend(() => {
            settings = next;
            return recompute;
          }),
        );
      }),
    );
    // A reading that lands after a change is still current, so merging the two cannot go stale.
    yield* forkParked(
      Stream.merge(Stream.fromEffect(registry.getProviders), registry.streamChanges).pipe(
        Stream.runForEach((next) =>
          Effect.suspend(() => {
            providers = next;
            return recompute;
          }),
        ),
      ),
    );

    return MattrDelegationInstructions.of({
      changes: SubscriptionRef.changes(ref).pipe(Stream.changes),
    });
  }),
);
