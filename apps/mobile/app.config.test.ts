import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3CODE_IOS_PERSONAL_TEAM: process.env.T3CODE_IOS_PERSONAL_TEAM,
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: process.env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID,
    T3CODE_IOS_APPLE_TEAM_ID: process.env.T3CODE_IOS_APPLE_TEAM_ID,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined, env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  // app.config.ts copies the (mocked) env into process.env, so unset keys must be reset explicitly.
  for (const key of [
    "T3CODE_IOS_PERSONAL_TEAM",
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
    "T3CODE_IOS_APPLE_TEAM_ID",
  ]) {
    vi.stubEnv(key, env[key] ?? "");
  }
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it.each([
  [undefined, "mattr"],
  ["development", "mattr Dev"],
  ["preview", "mattr Preview"],
])("brands APP_VARIANT=%j as %j", async (value, name) => {
  const config = await loadConfig(value);
  expect(config.name).toBe(name);
  expect(config.scheme).toMatch(/^t3code/);
  expect(config.ios?.infoPlist?.NSLocalNetworkUsageDescription).toContain("mattr");
  expect(JSON.stringify(config.ios?.infoPlist)).not.toContain("T3 Code");
  expect(config.icon).toContain("assets/nightly/nightly-ios-1024.png");
  expect(config.ios?.icon).toContain("assets/nightly/app-icon.icon");
});

it("keeps Voice Mode listening and speaking with the screen locked", async () => {
  const config = await loadConfig(undefined);
  const audio = config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-audio",
  );
  expect(audio).toEqual([
    "expo-audio",
    expect.objectContaining({ enableBackgroundPlayback: true, enableBackgroundRecording: true }),
  ]);
  expect(config.ios?.infoPlist?.UIBackgroundModes).toContain("audio");
  expect(config.ios?.infoPlist?.NSSpeechRecognitionUsageDescription).toContain("mattr");
});

it.each([
  [undefined, "com.current.antimatter.mobile"],
  ["development", "com.current.antimatter.mobile.dev"],
])("signs Personal Team builds for APP_VARIANT=%j without paid capabilities", async (value, id) => {
  const config = await loadConfig(value, { T3CODE_IOS_PERSONAL_TEAM: "1" });
  expect(config.ios?.bundleIdentifier).toBe(id);
  expect(config.ios?.appleTeamId).toBe("5PS35RR9RY");
  expect(config.ios).not.toHaveProperty("associatedDomains");
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${id}`,
  ]);
  expect(config.updates?.enabled).toBe(false);
  // First in the list, so its mod runs after expo-notifications adds aps-environment.
  expect(config.plugins?.[0]).toBe("./plugins/withoutIosPersonalTeamCapabilities.cjs");
  expect(
    config.plugins?.filter(
      (plugin) => plugin === "./plugins/withoutIosPersonalTeamCapabilities.cjs",
    ),
  ).toHaveLength(1);
});

it("leaves paid builds' plugin order and team alone", async () => {
  const config = await loadConfig(undefined);
  expect(config.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
  expect(config.plugins).not.toContain("./plugins/withoutIosPersonalTeamCapabilities.cjs");
  expect(config.plugins?.[0]).toBe("expo-asset");
});

it("honors Personal Team bundle id and team id overrides", async () => {
  const config = await loadConfig(undefined, {
    T3CODE_IOS_PERSONAL_TEAM: "1",
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.mattr",
    T3CODE_IOS_APPLE_TEAM_ID: "ABCDE12345",
  });
  expect(config.ios?.bundleIdentifier).toBe("com.example.mattr");
  expect(config.ios?.appleTeamId).toBe("ABCDE12345");
});

it("rejects an invalid Personal Team bundle id", async () => {
  await expect(
    loadConfig(undefined, {
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "nope",
    }),
  ).rejects.toThrow("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID");
});

it("defaults relay and Clerk config from antimatter/build-env.mjs when unset", async () => {
  const config = await loadConfig(undefined, { T3CODE_IOS_PERSONAL_TEAM: "1" });
  expect(config.extra?.relay?.url).toBe("https://relay.t3.codes");
  expect(config.extra?.clerk?.publishableKey).toBe("pk_live_Y2xlcmsudDMuY29kZXMk");
  expect(config.extra?.clerk?.jwtTemplate).toBe("t3-relay");
});

it("blackholes expo-observe and strips Axiom observability traces", async () => {
  const config = await loadConfig(undefined, { T3CODE_IOS_PERSONAL_TEAM: "1" });
  expect(config.extra?.eas?.observe?.endpointUrl).toBe("https://observe.invalid");
  expect(config.extra?.observability).toEqual({
    tracesUrl: null,
    tracesDataset: null,
    tracesToken: null,
  });
});
