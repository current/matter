import {
  ADDON_SECRET_CONFIG_KEY_PATTERN,
  AddonConfig,
  AddonEnablementSource,
  findAddonManifest,
  MATTER_ADDON_MANIFESTS,
  type AddonEnablementSource as AddonEnablementSourceType,
  type AddonManifest,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";

export const ADDONS_CONFIG_FILENAME = "mattr-addons.json";

const StoredAddon = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  enablementSource: Schema.optionalKey(AddonEnablementSource),
  updatedAt: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(AddonConfig),
});
type StoredAddon = typeof StoredAddon.Type;

const StoredAddonsFile = Schema.Struct({
  version: Schema.Literal(1),
  addons: Schema.Record(Schema.String, StoredAddon),
});
type StoredAddonsFile = typeof StoredAddonsFile.Type;

const StoredAddonsJson = fromJsonStringPretty(StoredAddonsFile);
const decodeStoredAddons = Schema.decodeUnknownEffect(StoredAddonsJson);
const encodeStoredAddons = Schema.encodeEffect(StoredAddonsJson);

const EMPTY_FILE: StoredAddonsFile = { version: 1, addons: {} };

export interface AddonEnablement {
  readonly id: string;
  readonly enabled: boolean;
  readonly enablementSource: AddonEnablementSourceType;
  readonly updatedAt: string | null;
}

export interface AddonEnablementChange {
  readonly id: string;
  readonly enabled: boolean;
}

export class AddonConfigError extends Schema.TaggedError<AddonConfigError>()("AddonConfigError", {
  reason: Schema.Literals(["unknown_addon", "secret_config_key", "write_failed"]),
  detail: Schema.optional(Schema.String),
}) {}

export class AddonConfigService extends Context.Service<
  AddonConfigService,
  {
    readonly manifests: ReadonlyArray<AddonManifest>;
    readonly getEnablement: (id: string) => Effect.Effect<AddonEnablement, AddonConfigError>;
    readonly listEnablement: Effect.Effect<ReadonlyArray<AddonEnablement>>;
    readonly isEnabled: (id: string) => Effect.Effect<boolean>;
    readonly setEnabled: (input: {
      readonly id: string;
      readonly enabled: boolean;
      readonly source?: "user" | "migrated";
    }) => Effect.Effect<AddonEnablement, AddonConfigError>;
    readonly getConfig: (id: string) => Effect.Effect<AddonConfig, AddonConfigError>;
    /** Merges into the stored config; a `null` value removes that key. */
    readonly updateConfig: (
      id: string,
      patch: AddonConfig,
    ) => Effect.Effect<AddonConfig, AddonConfigError>;
    readonly changes: Stream.Stream<AddonEnablementChange>;
    /** Ids of add-ons whose config was just written. */
    readonly configChanges: Stream.Stream<string>;
  }
>()("t3/bots/AddonConfigService") {}

const findSecretKey = (config: AddonConfig): string | null => {
  for (const key of Object.keys(config)) {
    if (ADDON_SECRET_CONFIG_KEY_PATTERN.test(key)) return key;
  }
  return null;
};

export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(serverConfig.stateDir, ADDONS_CONFIG_FILENAME);
  const manifests = MATTER_ADDON_MANIFESTS;

  const writeLock = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<AddonEnablementChange>();
  const configChangesPubSub = yield* PubSub.unbounded<string>();
  // Read lazily so a server with no add-on traffic never touches the file.
  const cache = yield* Ref.make<StoredAddonsFile | null>(null);

  const load = Effect.fn("AddonConfigService.load")(function* () {
    const cached = yield* Ref.get(cache);
    if (cached) return cached;
    const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
    const decoded =
      raw === null
        ? EMPTY_FILE
        : yield* decodeStoredAddons(raw).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("mattr-addons.json is unreadable; using defaults.", error),
            ),
            Effect.orElseSucceed(() => EMPTY_FILE),
          );
    yield* Ref.set(cache, decoded);
    return decoded;
  });

  const persist = Effect.fn("AddonConfigService.persist")(function* (next: StoredAddonsFile) {
    const encoded = yield* encodeStoredAddons(next).pipe(
      Effect.mapError(
        (error) => new AddonConfigError({ reason: "write_failed", detail: String(error) }),
      ),
    );
    yield* fileSystem
      .makeDirectory(serverConfig.stateDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fileSystem
      .writeFileString(filePath, `${encoded}\n`, { mode: 0o600 })
      .pipe(
        Effect.mapError(
          (error) => new AddonConfigError({ reason: "write_failed", detail: error.message }),
        ),
      );
    yield* fileSystem.chmod(filePath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
    yield* Ref.set(cache, next);
  });

  const requireManifest = (id: string) => {
    const manifest = findAddonManifest(id);
    return manifest
      ? Effect.succeed(manifest)
      : Effect.fail(new AddonConfigError({ reason: "unknown_addon", detail: id }));
  };

  const toEnablement = (manifest: AddonManifest, stored: StoredAddon | undefined) =>
    ({
      id: manifest.id,
      enabled: stored?.enabled ?? manifest.defaultEnabled,
      enablementSource:
        stored?.enabled === undefined ? "default" : (stored.enablementSource ?? "user"),
      updatedAt: stored?.updatedAt ?? null,
    }) satisfies AddonEnablement;

  const getEnablement = Effect.fn("AddonConfigService.getEnablement")(function* (id: string) {
    const manifest = yield* requireManifest(id);
    const file = yield* load();
    return toEnablement(manifest, file.addons[id]);
  });

  const listEnablement = Effect.gen(function* () {
    const file = yield* load();
    return manifests.map((manifest) => toEnablement(manifest, file.addons[manifest.id]));
  }).pipe(Effect.withSpan("AddonConfigService.listEnablement"));

  const isEnabled = (id: string) =>
    getEnablement(id).pipe(
      Effect.map((enablement) => enablement.enabled),
      Effect.orElseSucceed(() => false),
    );

  const setEnabled = Effect.fn("AddonConfigService.setEnabled")(function* (input: {
    readonly id: string;
    readonly enabled: boolean;
    readonly source?: "user" | "migrated";
  }) {
    const manifest = yield* requireManifest(input.id);
    const result = yield* writeLock.withPermit(
      Effect.gen(function* () {
        const file = yield* load();
        const previous = file.addons[input.id];
        const before = toEnablement(manifest, previous);
        // A migration never overrides a choice the user already made.
        if (input.source === "migrated" && before.enablementSource === "user") {
          return { enablement: before, changed: false };
        }
        // Disabling keeps the add-on's config so turning it back on restores everything.
        const nextEntry: StoredAddon = {
          ...previous,
          enabled: input.enabled,
          enablementSource: input.source ?? "user",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* persist({ ...file, addons: { ...file.addons, [input.id]: nextEntry } });
        return {
          enablement: toEnablement(manifest, nextEntry),
          changed: before.enabled !== input.enabled,
        };
      }),
    );
    if (result.changed) {
      yield* PubSub.publish(changesPubSub, { id: input.id, enabled: input.enabled });
    }
    return result.enablement;
  });

  const getConfig = Effect.fn("AddonConfigService.getConfig")(function* (id: string) {
    yield* requireManifest(id);
    const file = yield* load();
    return file.addons[id]?.config ?? {};
  });

  const updateConfig = Effect.fn("AddonConfigService.updateConfig")(function* (
    id: string,
    patch: AddonConfig,
  ) {
    yield* requireManifest(id);
    const secretKey = findSecretKey(patch);
    if (secretKey !== null) {
      return yield* new AddonConfigError({ reason: "secret_config_key", detail: secretKey });
    }
    const merged = yield* writeLock.withPermit(
      Effect.gen(function* () {
        const file = yield* load();
        const previous = file.addons[id];
        const merged: Record<string, unknown> = { ...previous?.config };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        yield* persist({
          ...file,
          addons: {
            ...file.addons,
            [id]: {
              ...previous,
              config: merged,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
          },
        });
        return merged;
      }),
    );
    yield* PubSub.publish(configChangesPubSub, id);
    return merged;
  });

  return AddonConfigService.of({
    manifests,
    getEnablement,
    listEnablement,
    isEnabled,
    setEnabled,
    getConfig,
    updateConfig,
    changes: Stream.fromPubSub(changesPubSub),
    configChanges: Stream.fromPubSub(configChangesPubSub),
  });
});

export const layer = Layer.effect(AddonConfigService, make);
