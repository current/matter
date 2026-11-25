import { BRAND_ASSET_PATHS } from "../scripts/lib/brand-assets.ts";

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
  const branded = { ...rebrandDeep(rest), extra };

  const plugins = branded.plugins?.map((plugin) =>
    Array.isArray(plugin) && plugin[0] === "expo-audio"
      ? [plugin[0], { ...plugin[1], enableBackgroundPlayback: true }]
      : plugin,
  );

  const { appleTeamId, associatedDomains, ...ios } = (branded.ios ?? {}) as Record<
    string,
    unknown
  > & {
    entitlements?: object;
  };
  const appleTeamIdOverride = options.env.T3CODE_IOS_APPLE_TEAM_ID?.trim();

  return {
    ...branded,
    icon: MATTR_APP_ICON,
    plugins,
    ios: {
      ...ios,
      icon: MATTR_IOS_ICON,
      entitlements: {
        ...ios.entitlements,
        "keychain-access-groups": [`$(AppIdentifierPrefix)${options.iosBundleIdentifier}`],
      },
      ...(options.isIosPersonalTeamBuild
        ? appleTeamIdOverride
          ? { appleTeamId: appleTeamIdOverride }
          : {}
        : { appleTeamId, associatedDomains }),
    },
    android: { ...branded.android, icon: MATTR_APP_ICON },
    web: { ...branded.web, favicon: MATTR_APP_ICON },
    // Local Personal Team builds must never fetch upstream's OTA bundles.
    ...(options.isIosPersonalTeamBuild ? { updates: { ...branded.updates, enabled: false } } : {}),
  } as unknown as Config;
}
