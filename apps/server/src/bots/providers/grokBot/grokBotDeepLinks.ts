import { GROK_BOT_DEFAULT_CDP_PORT, grokBotLaunchCommand } from "@t3tools/contracts";

export { GROK_BOT_DEFAULT_CDP_PORT };
export const GROK_BOT_APP_PATH = "/Applications/Grok Bot.app";
export const GROK_BOT_BUNDLE_ID = "com.anysphere.sand";
export const GROK_BOT_URL_SCHEME = "grokbot";
export const GROK_BOT_DEFAULT_CDP_HOST = "127.0.0.1";
export const GROK_BOT_MAX_PROMPT_LENGTH = 1_000;

export type GrokBotSyncMode = "push" | "poll" | "none";

export interface GrokBotCapabilities {
  readonly discoverBots: boolean;
  readonly multiConversation: boolean;
  readonly historyPagination: boolean;
  readonly replyThreads: boolean;
  readonly pushEvents: boolean;
  readonly boundedPolling: boolean;
  readonly attachmentsUpload: boolean;
  readonly attachmentsDownload: boolean;
  readonly interrupt: boolean;
  readonly interactiveWidgets: boolean;
  readonly approvals: boolean;
  readonly routines: boolean;
  readonly botCrud: boolean;
  readonly customAvatarImage: boolean;
  readonly parametricCharacterAvatar: boolean;
  readonly deepLinkUrl: boolean;
  readonly syncMode: GrokBotSyncMode;
  readonly experimental: boolean;
}

export type GrokBotActionCapabilityKey = Exclude<
  keyof GrokBotCapabilities,
  "syncMode" | "experimental"
>;

export interface GrokBotActionFallback {
  readonly supported: boolean;
  readonly label: string;
  readonly deepLinkUrl: string;
}

export const GROK_BOT_CDP_CAPABILITIES: GrokBotCapabilities = {
  discoverBots: true,
  multiConversation: false,
  historyPagination: true,
  replyThreads: false,
  pushEvents: false,
  boundedPolling: true,
  attachmentsUpload: false,
  attachmentsDownload: false,
  interrupt: true,
  interactiveWidgets: true,
  approvals: false,
  routines: false,
  botCrud: false,
  customAvatarImage: true,
  parametricCharacterAvatar: true,
  deepLinkUrl: true,
  syncMode: "poll",
  experimental: true,
};

export const GROK_BOT_DEEP_LINK_ONLY_CAPABILITIES: GrokBotCapabilities = {
  discoverBots: false,
  multiConversation: false,
  historyPagination: false,
  replyThreads: false,
  pushEvents: false,
  boundedPolling: false,
  attachmentsUpload: false,
  attachmentsDownload: false,
  interrupt: false,
  interactiveWidgets: false,
  approvals: false,
  routines: false,
  botCrud: false,
  customAvatarImage: false,
  parametricCharacterAvatar: true,
  deepLinkUrl: true,
  syncMode: "none",
  experimental: false,
};

const SAFE_BOT_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

function sanitizeIdentifier(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!SAFE_BOT_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export const buildGrokBotLaunchCommand = grokBotLaunchCommand;

export function buildGrokBotPromptDeepLink(input?: {
  readonly botId?: string;
  readonly text?: string;
}): string {
  const params = new URLSearchParams();
  const safeBotId = sanitizeIdentifier(input?.botId);
  if (safeBotId) {
    params.set("id", safeBotId);
  }
  if (input?.text !== undefined) {
    const trimmed = input.text.trim();
    if (trimmed.length > 0) {
      params.set("text", trimmed.slice(0, GROK_BOT_MAX_PROMPT_LENGTH));
    }
  }
  const query = params.toString();
  return query.length > 0
    ? `${GROK_BOT_URL_SCHEME}://app/v1/prompt?${query}`
    : `${GROK_BOT_URL_SCHEME}://app/v1/prompt`;
}

export function buildGrokBotPluginDeepLink(pluginId: string): string | null {
  const safePluginId = sanitizeIdentifier(pluginId);
  if (!safePluginId) return null;
  const params = new URLSearchParams({ id: safePluginId });
  return `${GROK_BOT_URL_SCHEME}://app/v1/plugin/add?${params.toString()}`;
}

export function getGrokBotActionFallback(
  capabilities: GrokBotCapabilities,
  action: GrokBotActionCapabilityKey,
  context?: { readonly botId?: string; readonly text?: string },
): GrokBotActionFallback {
  return {
    supported: capabilities[action],
    label: "Open in Grok Bot",
    deepLinkUrl: buildGrokBotPromptDeepLink(context),
  };
}
