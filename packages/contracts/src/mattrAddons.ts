import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * mattr add-on registry: the source of truth for optional features. Enablement (persisted, the
 * user's choice) is separate from runtime status (whether an enabled add-on is actually usable).
 */

export type KnownAddonId = "grok-bot" | "devin-bot" | "voice-assistant" | "claude-cloud";
export type AddonId = KnownAddonId | (string & {});

export const AddonIdSchema = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{1,47}$/),
);

export const AddonCategory = Schema.Literals(["bots", "assistant", "cloud"]);
export type AddonCategory = typeof AddonCategory.Type;

export const AddonSurface = Schema.Literals(["desktop", "web", "mobile"]);
export type AddonSurface = typeof AddonSurface.Type;

export const AddonPlatformRequirements = Schema.Struct({
  surfaces: Schema.Array(AddonSurface),
  /** Host OSes the server must run on, when the add-on needs a local app or OS service. */
  hostOs: Schema.optionalKey(Schema.Array(Schema.Literals(["darwin", "win32", "linux"]))),
  /** A local application the add-on talks to, shown when it is missing. */
  requiresLocalApp: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AddonPlatformRequirements = typeof AddonPlatformRequirements.Type;

export const AddonContribution = Schema.Literals([
  "settings",
  "sidebar-section",
  "routes",
  "commands",
  "overlay",
  "background-service",
  "microphone",
  "network",
  "bots-provider",
  "agent-tools",
]);
export type AddonContribution = typeof AddonContribution.Type;

export const AddonOnboarding = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  enableLabel: TrimmedNonEmptyString,
  skipLabel: TrimmedNonEmptyString,
});
export type AddonOnboarding = typeof AddonOnboarding.Type;

export const AddonManifest = Schema.Struct({
  id: AddonIdSchema,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  /** A generic icon token the client maps to its own icon set. */
  icon: TrimmedNonEmptyString,
  category: AddonCategory,
  platformRequirements: AddonPlatformRequirements,
  dependencies: Schema.Array(AddonIdSchema),
  defaultEnabled: Schema.Boolean,
  onboarding: AddonOnboarding,
  /** Client route that configures the add-on, with an optional hash target. */
  settingsRoute: TrimmedNonEmptyString,
  contributions: Schema.Array(AddonContribution),
  /** Relies on an unofficial or reverse-engineered integration path. */
  experimental: Schema.Boolean,
});
export type AddonManifest = typeof AddonManifest.Type;

export const AddonRuntimeStatusKind = Schema.Literals([
  "disabled",
  "enabled_unconfigured",
  "app_unavailable",
  "connecting",
  "connected",
  "disconnected",
  "auth_required",
  "incompatible_version",
  "error",
]);
export type AddonRuntimeStatusKind = typeof AddonRuntimeStatusKind.Type;

export const AddonStatusActionKind = Schema.Literals([
  "configure",
  "open-app",
  "sign-in",
  "retry",
  "update",
]);
export type AddonStatusActionKind = typeof AddonStatusActionKind.Type;

export const AddonRuntimeStatus = Schema.Struct({
  kind: AddonRuntimeStatusKind,
  /** Human-readable detail. Never contains credentials. */
  detail: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(
    Schema.Struct({
      kind: AddonStatusActionKind,
      url: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type AddonRuntimeStatus = typeof AddonRuntimeStatus.Type;

/** Where an add-on's enabled flag came from: its manifest default, the user, or a migration. */
export const AddonEnablementSource = Schema.Literals(["default", "user", "migrated"]);
export type AddonEnablementSource = typeof AddonEnablementSource.Type;

export const AddonConfig = Schema.Record(Schema.String, Schema.Unknown);
export type AddonConfig = typeof AddonConfig.Type;

export const AddonState = Schema.Struct({
  id: AddonIdSchema,
  enabled: Schema.Boolean,
  enablementSource: AddonEnablementSource,
  updatedAt: Schema.NullOr(Schema.String),
  status: AddonRuntimeStatus,
});
export type AddonState = typeof AddonState.Type;

export const AddonEntry = Schema.Struct({
  manifest: AddonManifest,
  state: AddonState,
});
export type AddonEntry = typeof AddonEntry.Type;

export const AddonListResponse = Schema.Struct({
  addons: Schema.Array(AddonEntry),
});
export type AddonListResponse = typeof AddonListResponse.Type;

export const AddonSetEnabledRequest = Schema.Struct({
  id: AddonIdSchema,
  enabled: Schema.Boolean,
  source: Schema.optionalKey(Schema.Literals(["user", "migrated"])),
});
export type AddonSetEnabledRequest = typeof AddonSetEnabledRequest.Type;

export const AddonConfigResponse = Schema.Struct({
  id: AddonIdSchema,
  config: AddonConfig,
});
export type AddonConfigResponse = typeof AddonConfigResponse.Type;

export const AddonUpdateConfigRequest = Schema.Struct({
  id: AddonIdSchema,
  config: AddonConfig,
});
export type AddonUpdateConfigRequest = typeof AddonUpdateConfigRequest.Type;

/** Restarts an enabled add-on's connection now, instead of waiting for its retry backoff. */
export const AddonReconnectRequest = Schema.Struct({ id: AddonIdSchema });
export type AddonReconnectRequest = typeof AddonReconnectRequest.Type;

/** Config keys that look like credentials. Add-on config is non-secret; secrets go to secret storage. */
export const ADDON_SECRET_CONFIG_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|cookie|credential|bearer|session|private[-_]?key)/i;

export const MATTR_ADDON_MANIFESTS: ReadonlyArray<AddonManifest> = [
  {
    id: "grok-bot",
    displayName: "Grok Bot",
    description: "Talk to your existing Grok Bot teammates from the mattr sidebar.",
    icon: "bot",
    category: "bots",
    platformRequirements: {
      surfaces: ["desktop", "web", "mobile"],
      requiresLocalApp: "Grok Bot",
    },
    dependencies: [],
    defaultEnabled: false,
    onboarding: {
      prompt:
        "Do you use Grok Bot and want to interact with your existing AI teammates from this application?",
      enableLabel: "Enable Grok Bot",
      skipLabel: "Skip",
    },
    settingsRoute: "/settings/addons#addon-grok-bot",
    contributions: ["settings", "sidebar-section", "routes", "network", "bots-provider"],
    experimental: true,
  },
  {
    id: "devin-bot",
    displayName: "Devin Bot",
    description: "Talk to your Devin Bots and answer what they need from the mattr sidebar.",
    icon: "bot",
    category: "bots",
    platformRequirements: {
      surfaces: ["desktop", "web", "mobile"],
      hostOs: ["darwin"],
      requiresLocalApp: "Devin",
    },
    dependencies: [],
    defaultEnabled: false,
    onboarding: {
      prompt:
        "Do you use Devin Bots and want to chat with them and answer their requests from this application?",
      enableLabel: "Enable Devin Bot",
      skipLabel: "Skip",
    },
    settingsRoute: "/settings/addons#addon-devin-bot",
    contributions: ["settings", "sidebar-section", "routes", "network", "bots-provider"],
    experimental: true,
  },
  {
    id: "voice-assistant",
    displayName: "Voice Assistant",
    description:
      "A hands-free assistant that can summarize threads, report progress and steer your agents.",
    icon: "mic",
    category: "assistant",
    platformRequirements: { surfaces: ["desktop", "web", "mobile"] },
    dependencies: [],
    defaultEnabled: false,
    onboarding: {
      prompt:
        "Would you like an integrated, hands-free AI assistant capable of interacting with your coding agents, conversations, and tasks?",
      enableLabel: "Enable Voice Assistant",
      skipLabel: "Skip",
    },
    settingsRoute: "/settings/general#mattr-voice-assistant",
    contributions: ["settings", "commands", "overlay", "microphone", "network"],
    experimental: false,
  },
  {
    id: "claude-cloud",
    displayName: "Claude Cloud",
    description:
      "Offload heavy work to Claude Cloud VMs on your Claude subscription, send follow-ups, and pull sessions back into local worktree threads.",
    icon: "cloud",
    category: "cloud",
    platformRequirements: { surfaces: ["desktop", "web", "mobile"] },
    dependencies: [],
    defaultEnabled: false,
    onboarding: {
      prompt:
        "Do you want to run heavy work such as test suites and large refactors on Claude Cloud with your claude.ai subscription, and let your agents offload it too?",
      enableLabel: "Enable Claude Cloud",
      skipLabel: "Skip",
    },
    settingsRoute: "/settings/addons#addon-claude-cloud",
    contributions: ["settings", "commands", "network", "agent-tools"],
    experimental: true,
  },
];

export function findAddonManifest(id: string): AddonManifest | undefined {
  return MATTR_ADDON_MANIFESTS.find((manifest) => manifest.id === id);
}

/** Grok Bot's loopback debug port lives in its non-secret add-on config under this key. */
export const GROK_BOT_CDP_PORT_CONFIG_KEY = "cdpPort";
export const GROK_BOT_DEFAULT_CDP_PORT = 9222;

const isValidPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;

const portFromConfig = (config: AddonConfig, key: string, fallback: number): number => {
  const raw = config[key];
  const port = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return isValidPort(port) ? port : fallback;
};

export function grokBotCdpPortFromConfig(config: AddonConfig): number {
  return portFromConfig(config, GROK_BOT_CDP_PORT_CONFIG_KEY, GROK_BOT_DEFAULT_CDP_PORT);
}

/** The command a user runs to reopen Grok Bot with its debug port; mattr never runs it. */
export function grokBotLaunchCommand(port: number = GROK_BOT_DEFAULT_CDP_PORT): string {
  return `open -a "Grok Bot" --args --remote-debugging-port=${isValidPort(port) ? port : GROK_BOT_DEFAULT_CDP_PORT}`;
}

/** Devin's loopback debug port; its default differs from Grok Bot's so both apps can run at once. */
export const DEVIN_BOT_CDP_PORT_CONFIG_KEY = "cdpPort";
export const DEVIN_BOT_DEFAULT_CDP_PORT = 9223;

export function devinBotCdpPortFromConfig(config: AddonConfig): number {
  return portFromConfig(config, DEVIN_BOT_CDP_PORT_CONFIG_KEY, DEVIN_BOT_DEFAULT_CDP_PORT);
}

/** The command a user runs to reopen Devin with a loopback-only debug port; mattr never runs it. */
export function devinBotLaunchCommand(port: number = DEVIN_BOT_DEFAULT_CDP_PORT): string {
  const safePort = isValidPort(port) ? port : DEVIN_BOT_DEFAULT_CDP_PORT;
  return `open -a "Devin" --args --remote-debugging-port=${safePort} --remote-debugging-address=127.0.0.1`;
}
