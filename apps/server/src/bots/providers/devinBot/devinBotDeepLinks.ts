import { DEVIN_BOT_DEFAULT_CDP_PORT, devinBotLaunchCommand } from "@t3tools/contracts";

export { DEVIN_BOT_DEFAULT_CDP_PORT, devinBotLaunchCommand };
export const DEVIN_APP_PATH = "/Applications/Devin.app";
const DEVIN_URL_SCHEME = "devin";
const DEVIN_WEB_ORIGIN = "https://app.devin.ai";

const HEX_ID = /^[0-9a-f]{32}$/;

/** `bot-<hex>` or `devin-<hex>` (or bare hex) to the bare 32-hex id Devin's routes use. */
export function bareDevinId(id: string): string | null {
  const bare = id.replace(/^(bot|devin)-/, "");
  return HEX_ID.test(bare) ? bare : null;
}

const base64Url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** Opens a webapp path inside Devin.app: `devin://app/open/<base64url(path)>`. */
export function buildDevinAppPathDeepLink(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  return `${DEVIN_URL_SCHEME}://app/open/${base64Url(path)}`;
}

export function buildDevinBotDeepLink(botId: string): string {
  const bare = bareDevinId(botId);
  return (
    (bare ? buildDevinAppPathDeepLink(`/bots/${bare}`) : null) ??
    `${DEVIN_URL_SCHEME}://app/open/${base64Url("/bots")}`
  );
}

export function buildDevinSessionDeepLink(devinId: string): string | null {
  const bare = bareDevinId(devinId);
  return bare ? `${DEVIN_URL_SCHEME}://session/${bare}` : null;
}

export function buildDevinBotWebUrl(botId: string): string {
  const bare = bareDevinId(botId);
  return bare ? `${DEVIN_WEB_ORIGIN}/bots/${bare}` : `${DEVIN_WEB_ORIGIN}/bots`;
}
