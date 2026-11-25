import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("AnalyticsService test", (it) => {
  it.effect("is a zero-network, zero-disk-write no-op even when telemetry env vars are set", () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make(() =>
        Effect.sync(() => {
          requests += 1;
          throw new Error("AnalyticsService must not make outbound HTTP requests");
        }),
      );
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3CODE_TELEMETRY_ENABLED: true,
              T3CODE_POSTHOG_KEY: "phc_test_key",
              T3CODE_POSTHOG_HOST: "http://localhost",
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "darwin"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
            Layer.succeed(HttpClient.HttpClient, client),
            ManagedPolicy.layerTest({
              schemaVersion: 1,
              organization: "Example Corp",
              limits: { telemetry: true },
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const { anonymousIdPath } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;

        assert.isFalse(yield* analytics.record("test.event", { index: 1 }));
        assert.isFalse(yield* analytics.record("test.anonymous", {}, { anonymous: true }));
        yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        yield* analytics.flush;

        assert.isFalse(yield* fs.exists(anonymousIdPath));
      }).pipe(Effect.provide(runtimeLayer));

      assert.strictEqual(requests, 0);
    }),
  );

  it.effect("shutdown completes immediately without spawning background flush work", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        AnalyticsService.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.never),
            ),
          ),
        ),
        scope,
      );
      const recorded = yield* Effect.flatMap(AnalyticsService.AnalyticsService, (analytics) =>
        analytics.record("test.shutdown"),
      ).pipe(Effect.provide(context));
      assert.isFalse(recorded);

      yield* Scope.close(scope, Exit.void);
    }),
  );
});
