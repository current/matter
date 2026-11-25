import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as AddonConfigService from "./AddonConfigService.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-addon-config-" });
const layer = AddonConfigService.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);

const configFilePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, AddonConfigService.ADDONS_CONFIG_FILENAME);
});

/** A fresh service over the same state dir, as after a server restart. */
const restarted = AddonConfigService.make;

describe("AddonConfigService", () => {
  it.effect("defaults optional add-ons to disabled without touching disk", () =>
    Effect.gen(function* () {
      const service = yield* AddonConfigService.AddonConfigService;
      const fileSystem = yield* FileSystem.FileSystem;
      const all = yield* service.listEnablement;
      assert.deepStrictEqual(
        all.map(({ id, enabled, enablementSource }) => ({ id, enabled, enablementSource })),
        [
          { id: "grok-bot", enabled: false, enablementSource: "default" },
          { id: "voice-assistant", enabled: false, enablementSource: "default" },
        ],
      );
      assert.isFalse(yield* fileSystem.exists(yield* configFilePath));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("persists enablement privately and reads it back after a restart", () =>
    Effect.gen(function* () {
      const service = yield* AddonConfigService.AddonConfigService;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* service.setEnabled({ id: "grok-bot", enabled: true });
      const stat = yield* fileSystem.stat(yield* configFilePath);
      assert.strictEqual(stat.mode & 0o777, 0o600);
      const fresh = yield* restarted;
      const enablement = yield* fresh.getEnablement("grok-bot");
      assert.isTrue(enablement.enabled);
      assert.strictEqual(enablement.enablementSource, "user");
      assert.isString(enablement.updatedAt);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps config when an add-on is disabled and re-enabled", () =>
    Effect.gen(function* () {
      const service = yield* AddonConfigService.AddonConfigService;
      yield* service.setEnabled({ id: "grok-bot", enabled: true });
      yield* service.updateConfig("grok-bot", { transport: "local-app", pinnedBots: ["a"] });
      yield* service.setEnabled({ id: "grok-bot", enabled: false });
      assert.deepStrictEqual(yield* (yield* restarted).getConfig("grok-bot"), {
        transport: "local-app",
        pinnedBots: ["a"],
      });
      yield* service.setEnabled({ id: "grok-bot", enabled: true });
      assert.deepStrictEqual(yield* service.getConfig("grok-bot"), {
        transport: "local-app",
        pinnedBots: ["a"],
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never lets a migration override the user's own choice", () =>
    Effect.gen(function* () {
      const service = yield* AddonConfigService.AddonConfigService;
      yield* service.setEnabled({ id: "voice-assistant", enabled: false });
      const after = yield* service.setEnabled({
        id: "voice-assistant",
        enabled: true,
        source: "migrated",
      });
      assert.isFalse(after.enabled);
      assert.strictEqual(after.enablementSource, "user");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects credential-looking config keys and removes keys set to null", () =>
    Effect.gen(function* () {
      const service = yield* AddonConfigService.AddonConfigService;
      const rejected = yield* Effect.flip(service.updateConfig("grok-bot", { apiKey: "x" }));
      assert.strictEqual(rejected.reason, "secret_config_key");
      yield* service.updateConfig("grok-bot", { a: 1, b: 2 });
      assert.deepStrictEqual(yield* service.updateConfig("grok-bot", { a: null }), { b: 2 });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails for unknown add-ons and reports them as disabled", () =>
    Effect.gen(function* () {
      const service = yield* AddonConfigService.AddonConfigService;
      const error = yield* Effect.flip(service.setEnabled({ id: "nope", enabled: true }));
      assert.strictEqual(error.reason, "unknown_addon");
      assert.isFalse(yield* service.isEnabled("nope"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("publishes a change only when enablement actually flips", () =>
    Effect.gen(function* () {
      const service = yield* AddonConfigService.AddonConfigService;
      const initial = (yield* service.getEnablement("voice-assistant")).enabled;
      const collected = yield* service.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* service.setEnabled({ id: "voice-assistant", enabled: !initial });
      yield* service.setEnabled({ id: "voice-assistant", enabled: !initial });
      yield* service.setEnabled({ id: "voice-assistant", enabled: initial });
      const changes = yield* Fiber.join(collected);
      assert.deepStrictEqual(Array.from(changes), [
        { id: "voice-assistant", enabled: !initial },
        { id: "voice-assistant", enabled: initial },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
