import { BRAND_ASSET_PATHS } from "../scripts/lib/brand-assets.ts";
import { BUILD_ENV } from "./build-env.mjs";

// Fork-only mobile config: mattr branding and free Apple ID ("Personal Team") signing, applied
// on top of upstream's app.config.ts so upstream merges stay a three-line conflict at most.

type AppVariant = "development" | "preview" | "production";
type Env = Record<string, string | undefined>;

// Structural stand-in for ExpoConfig: `expo` is a dependency of apps/mobile only, not of this folder.
interface MobileConfigShape {
  readonly plugins?: ReadonlyArray<unknown>;
  readonly ios?: { readonly entitlements?: object } & object;
  readonly android?: object;
  readonly web?: object;
  readonly updates?: object;
  readonly extra?: unknown;
}

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;

const MATTR_APP_ICON = fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng);
const MATTR_IOS_ICON = fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject);

// Chris's free Apple ID Personal Team OU; `T3CODE_IOS_APPLE_TEAM_ID` signs with another one.
const MATTR_PERSONAL_TEAM_ID = "5PS35RR9RY";
const PERSONAL_TEAM_CAPABILITIES_PLUGIN = "./plugins/withoutIosPersonalTeamCapabilities.cjs";

const PERSONAL_TEAM_BUNDLE_IDENTIFIERS: Record<AppVariant, string> = {
  development: "com.current.antimatter.mobile.dev",
  preview: "com.current.antimatter.mobile.preview",
  production: "com.current.antimatter.mobile",
};

export function resolveMattrPersonalTeamBundleIdentifier(env: Env, appVariant: AppVariant) {
  return (
    env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim() || PERSONAL_TEAM_BUNDLE_IDENTIFIERS[appVariant]
  );
}

export function rebrandMattrMobileText(text: string): string {
  return text
    .replace(/\bT3(\s+)Connect\b/g, "mattr$1Connect")
    .replace(/\bT3(\s+)Code(?! for GitHub)/g, "mattr");
}

function rebrandDeep<T>(value: T): T {
  if (typeof value === "string") return rebrandMattrMobileText(value) as T;
  if (Array.isArray(value)) return value.map(rebrandDeep) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rebrandDeep(entry)]),
    ) as T;
  }
  return value;
}

export function withMattrMobileConfig<Config extends MobileConfigShape>(
  config: Config,
  options: {
    readonly env: Env;
    readonly isIosPersonalTeamBuild: boolean;
    readonly iosBundleIdentifier: string;
  },
): Config {
  const { extra, ...rest } = config;
  const extraRecord = (extra !== null && typeof extra === "object" ? extra : {}) as Record<
    string,
    unknown
  >;
  const existingRelay = (
    extraRecord.relay !== null && typeof extraRecord.relay === "object" ? extraRecord.relay : {}
  ) as Record<string, unknown>;
  const existingClerk = (
    extraRecord.clerk !== null && typeof extraRecord.clerk === "object" ? extraRecord.clerk : {}
  ) as Record<string, unknown>;
  const existingEas = (
    extraRecord.eas !== null && typeof extraRecord.eas === "object" ? extraRecord.eas : {}
  ) as Record<string, unknown>;
  const existingObserve = (
    existingEas.observe !== null && typeof existingEas.observe === "object"
      ? existingEas.observe
      : {}
  ) as Record<string, unknown>;
  const relayUrl =
    (typeof existingRelay.url === "string" && existingRelay.url.trim()) ||
    BUILD_ENV.T3CODE_RELAY_URL;
  const mergedExtra = {
    ...extraRecord,
    relay: {
      ...existingRelay,
      url: relayUrl,
    },
    clerk: {
      ...existingClerk,
      publishableKey:
        (typeof existingClerk.publishableKey === "string" && existingClerk.publishableKey.trim()) ||
        BUILD_ENV.T3CODE_CLERK_PUBLISHABLE_KEY,
      jwtTemplate:
        (typeof existingClerk.jwtTemplate === "string" && existingClerk.jwtTemplate.trim()) ||
        BUILD_ENV.T3CODE_CLERK_JWT_TEMPLATE,
    },
    eas: {
      ...existingEas,
      observe: {
        ...existingObserve,
        endpointUrl:
          (typeof existingObserve.endpointUrl === "string" && existingObserve.endpointUrl.trim()) ||
          new URL("/v1/mobile/observe", relayUrl).toString(),
      },
    },
  };
  const branded = { ...rebrandDeep(rest), extra: mergedExtra };

  // Voice Mode keeps listening and speaking with the screen locked.
  const audioPlugins = branded.plugins?.map((plugin) =>
    Array.isArray(plugin) && plugin[0] === "expo-audio"
      ? [
          plugin[0],
          { ...plugin[1], enableBackgroundPlayback: true, enableBackgroundRecording: true },
        ]
      : plugin,
  );
  // Mods run in reverse plugin order. Upstream lists the capability stripper last, so it runs
  // before expo-notifications adds `aps-environment` and Personal Team signing fails; first in
  // the list it runs after every other entitlements mod.
  const plugins =
    options.isIosPersonalTeamBuild && audioPlugins?.includes(PERSONAL_TEAM_CAPABILITIES_PLUGIN)
      ? [
          PERSONAL_TEAM_CAPABILITIES_PLUGIN,
          ...audioPlugins.filter((plugin) => plugin !== PERSONAL_TEAM_CAPABILITIES_PLUGIN),
        ]
      : audioPlugins;

  const { appleTeamId, associatedDomains, ...ios } = (branded.ios ?? {}) as Record<
    string,
    unknown
  > & {
    entitlements?: object;
  };
  const personalTeamId = options.env.T3CODE_IOS_APPLE_TEAM_ID?.trim() || MATTR_PERSONAL_TEAM_ID;
  const infoPlist = (ios.infoPlist ?? {}) as Record<string, unknown>;

  return {
    ...branded,
    icon: MATTR_APP_ICON,
    plugins,
    ios: {
      ...ios,
      icon: MATTR_IOS_ICON,
      infoPlist: {
        ...infoPlist,
        // On-device Apple Speech is Voice Mode's fallback when the server has no Deepgram key.
        NSSpeechRecognitionUsageDescription:
          "Allow mattr to transcribe your voice on this device when your server can't.",
      },
      entitlements: {
        ...ios.entitlements,
        "keychain-access-groups": [`$(AppIdentifierPrefix)${options.iosBundleIdentifier}`],
      },
      ...(options.isIosPersonalTeamBuild
        ? { appleTeamId: personalTeamId }
        : { appleTeamId, associatedDomains }),
    },
    android: { ...branded.android, icon: MATTR_APP_ICON },
    web: { ...branded.web, favicon: MATTR_APP_ICON },
    // Local Personal Team builds must never fetch upstream's OTA bundles.
    ...(options.isIosPersonalTeamBuild ? { updates: { ...branded.updates, enabled: false } } : {}),
  } as unknown as Config;
}
