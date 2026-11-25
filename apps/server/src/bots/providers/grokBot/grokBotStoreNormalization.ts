import { parseBase64DataUrl } from "../../../imageMime.ts";
import {
  buildGrokBotPromptDeepLink,
  GROK_BOT_DEFAULT_CDP_HOST,
  GROK_BOT_DEFAULT_CDP_PORT,
} from "./grokBotDeepLinks.ts";
import {
  GrokBotLoopbackViolationError,
  type GrokBotActivityStatus,
  type GrokBotMessage,
  type GrokBotMessageRole,
  type GrokBotSummary,
} from "./GrokBotTransport.ts";

const GROK_BOT_MAX_AVATAR_DATA_URL_LENGTH = 512 * 1024;
const GROK_BOT_MAX_PREVIEW_LENGTH = 280;

const ALLOWED_AVATAR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface ValidatedLoopbackEndpoint {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly httpOrigin: string;
  readonly jsonListUrl: string;
}

export interface CdpTargetDescriptor {
  readonly id?: string;
  readonly type?: string;
  readonly title?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface ParsedPlistInfo {
  readonly bundleId: string | null;
  readonly version: string | null;
  readonly urlSchemes: readonly string[];
}

export function validateLoopbackEndpoint(input?: {
  readonly host?: string;
  readonly port?: number;
}):
  | { readonly ok: true; readonly endpoint: ValidatedLoopbackEndpoint }
  | {
      readonly ok: false;
      readonly error: GrokBotLoopbackViolationError;
    } {
  const host = (input?.host ?? GROK_BOT_DEFAULT_CDP_HOST).trim();
  const port = input?.port ?? GROK_BOT_DEFAULT_CDP_PORT;

  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      ok: false,
      error: new GrokBotLoopbackViolationError({
        host,
        port: Number.isFinite(port) ? port : -1,
      }),
    };
  }

  const httpOrigin = `http://127.0.0.1:${port}`;
  return {
    ok: true,
    endpoint: {
      host: "127.0.0.1",
      port,
      httpOrigin,
      jsonListUrl: `${httpOrigin}/json`,
    },
  };
}

export function validateLoopbackWebSocketUrl(rawUrl: string, expectedPort: number): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:") return null;
  if (parsed.hostname !== "127.0.0.1") return null;
  const parsedPort = parsed.port === "" ? 80 : Number.parseInt(parsed.port, 10);
  if (parsedPort !== expectedPort) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.toString();
}

export function sanitizeGrokBotAvatarDataUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > GROK_BOT_MAX_AVATAR_DATA_URL_LENGTH) {
    return null;
  }
  const parsed = parseBase64DataUrl(trimmed);
  if (!parsed) return null;
  if (!ALLOWED_AVATAR_MIME_TYPES.has(parsed.mimeType)) return null;
  return `data:${parsed.mimeType};base64,${parsed.base64}`;
}

function readPlistStringValue(xml: string, key: string): string | null {
  const keyToken = `<key>${key}</key>`;
  const keyIndex = xml.indexOf(keyToken);
  if (keyIndex === -1) return null;
  const afterKey = xml.slice(keyIndex + keyToken.length);
  const openTag = afterKey.indexOf("<string>");
  const nextKey = afterKey.indexOf("<key>");
  if (openTag === -1 || (nextKey !== -1 && openTag > nextKey)) return null;
  const closeTag = afterKey.indexOf("</string>", openTag + 8);
  if (closeTag === -1) return null;
  const value = afterKey.slice(openTag + 8, closeTag).trim();
  return value.length > 0 ? value : null;
}

function readPlistUrlSchemes(xml: string): readonly string[] {
  const keyToken = "<key>CFBundleURLSchemes</key>";
  const keyIndex = xml.indexOf(keyToken);
  if (keyIndex === -1) return [];
  const afterKey = xml.slice(keyIndex + keyToken.length);
  const arrayStart = afterKey.indexOf("<array>");
  if (arrayStart === -1) return [];
  const arrayEnd = afterKey.indexOf("</array>", arrayStart + 7);
  if (arrayEnd === -1) return [];
  const block = afterKey.slice(arrayStart + 7, arrayEnd);
  const schemes: string[] = [];
  let cursor = 0;
  while (cursor < block.length) {
    const start = block.indexOf("<string>", cursor);
    if (start === -1) break;
    const end = block.indexOf("</string>", start + 8);
    if (end === -1) break;
    const scheme = block.slice(start + 8, end).trim();
    if (scheme.length > 0 && !schemes.includes(scheme)) {
      schemes.push(scheme);
    }
    cursor = end + 9;
  }
  return schemes;
}

export function parseGrokBotInfoPlist(xml: string): ParsedPlistInfo {
  const bundleId = readPlistStringValue(xml, "CFBundleIdentifier");
  const version =
    readPlistStringValue(xml, "CFBundleShortVersionString") ??
    readPlistStringValue(xml, "CFBundleVersion");
  const urlSchemes = readPlistUrlSchemes(xml);
  return { bundleId, version, urlSchemes };
}

function scoreGrokBotTarget(target: CdpTargetDescriptor): number {
  const title = (target.title ?? "").toLowerCase();
  const url = (target.url ?? "").toLowerCase();
  if (url.startsWith("devtools://") || url.startsWith("chrome-extension://")) return -1;
  if (target.type !== "page") return -1;

  let score = 0;
  if (title.includes("grok bot") || title.includes("grokbot")) score += 50;
  if (url.includes("grok") || url.includes("sand") || url.startsWith("file://")) score += 20;
  if (url !== "about:blank" && url.length > 0) score += 10;
  return score;
}

export function selectGrokBotRendererTarget(
  targets: readonly CdpTargetDescriptor[],
  expectedPort: number,
): {
  readonly target: CdpTargetDescriptor;
  readonly webSocketDebuggerUrl: string;
} | null {
  let best: {
    readonly target: CdpTargetDescriptor;
    readonly webSocketDebuggerUrl: string;
    readonly score: number;
  } | null = null;

  for (const target of targets) {
    if (!target.webSocketDebuggerUrl) continue;
    const safeWsUrl = validateLoopbackWebSocketUrl(target.webSocketDebuggerUrl, expectedPort);
    if (!safeWsUrl) continue;
    const score = scoreGrokBotTarget(target);
    if (score < 0) continue;
    if (!best || score > best.score) {
      best = { target, webSocketDebuggerUrl: safeWsUrl, score };
    }
  }

  return best ? { target: best.target, webSocketDebuggerUrl: best.webSocketDebuggerUrl } : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeGrokBotStatus(raw: {
  readonly status?: unknown;
  readonly activityState?: unknown;
  readonly isRunning?: unknown;
  readonly awaitingUserResponse?: unknown;
  readonly hasError?: unknown;
  readonly isOffline?: unknown;
}): GrokBotActivityStatus {
  const explicit = asNonEmptyString(raw.status ?? raw.activityState)?.toLowerCase();

  if (raw.awaitingUserResponse === true || explicit === "attention" || explicit === "needs_input") {
    return "attention";
  }
  if (raw.hasError === true || explicit === "error" || explicit === "failed") {
    return "error";
  }
  if (explicit === "searching") return "searching";
  if (explicit === "thinking") return "thinking";
  if (raw.isRunning === true || explicit === "working" || explicit === "running") {
    return "working";
  }
  if (explicit === "waiting") return "waiting";
  if (raw.isOffline === true || explicit === "offline" || explicit === "disconnected") {
    return "offline";
  }
  return "idle";
}

export function normalizeGrokBotSummary(raw: unknown): GrokBotSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = asNonEmptyString(record.id ?? record.agentId ?? record.botId);
  if (!id) return null;
  const name = asNonEmptyString(record.name ?? record.title) ?? id;
  const description = asNonEmptyString(record.description);
  const avatarDataUrl = sanitizeGrokBotAvatarDataUrl(record.avatarDataUrl ?? record.avatarUrl);
  const avatarShape = asNonEmptyString(record.avatarShape ?? record.shape);
  const avatarColor = asNonEmptyString(record.avatarColor ?? record.color);
  const isRunning = record.isRunning === true;
  const awaitingUserResponse = record.awaitingUserResponse === true;
  const status = normalizeGrokBotStatus({
    status: record.status,
    activityState: record.activityState,
    isRunning,
    awaitingUserResponse,
    hasError: record.hasError,
    isOffline: record.isOffline,
  });

  const rawUnread = asFiniteNumber(record.unreadCount);
  const unreadCount =
    rawUnread !== null ? Math.max(0, Math.floor(rawUnread)) : record.hasUnread === true ? 1 : 0;

  const rawPreview = asNonEmptyString(record.lastMessagePreview ?? record.preview);
  const lastMessagePreview = rawPreview ? rawPreview.slice(0, GROK_BOT_MAX_PREVIEW_LENGTH) : null;
  const lastActivityAtMs = asFiniteNumber(
    record.lastActivityAtMs ?? record.updatedAtMs ?? record.lastMessageAtMs,
  );

  return {
    id,
    name,
    description,
    avatarDataUrl,
    avatarShape,
    avatarColor,
    status,
    isRunning,
    awaitingUserResponse,
    unreadCount,
    lastMessagePreview,
    lastActivityAtMs,
    deepLinkUrl: buildGrokBotPromptDeepLink({ botId: id }),
  };
}

function normalizeMessageRole(raw: unknown): GrokBotMessageRole {
  const normalized = asNonEmptyString(raw)?.toLowerCase();
  if (normalized === "user" || normalized === "human") return "user";
  if (normalized === "system" || normalized === "tool") return "system";
  return "assistant";
}

export function normalizeGrokBotMessage(
  botId: string,
  raw: unknown,
  fallbackIndex: number,
): GrokBotMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : typeof record.body === "string"
          ? record.body
          : "";
  const seq = asFiniteNumber(record.seq);
  const id =
    asNonEmptyString(record.id ?? record.messageId ?? record.remoteId) ??
    (seq !== null ? `${botId}:seq:${seq}` : `${botId}:idx:${fallbackIndex}`);
  const timestampMs = asFiniteNumber(record.timestampMs ?? record.createdAtMs ?? record.timestamp);
  const clientNonce = asNonEmptyString(record.clientNonce ?? record.nonce);
  const replyToId = asNonEmptyString(record.replyToId);

  return {
    id,
    seq,
    botId,
    role: normalizeMessageRole(record.role ?? record.senderRole ?? record.author),
    text,
    timestampMs,
    clientNonce,
    replyToId,
    isStreaming: record.isStreaming === true,
  };
}

export function deduplicateGrokBotMessages(
  messages: readonly GrokBotMessage[],
): readonly GrokBotMessage[] {
  const byId = new Map<string, GrokBotMessage>();
  const idByNonce = new Map<string, string>();

  for (const message of messages) {
    const existingByNonceId = message.clientNonce ? idByNonce.get(message.clientNonce) : undefined;
    if (existingByNonceId && existingByNonceId !== message.id) {
      const previous = byId.get(existingByNonceId);
      // Prefer authoritative remote entries (with seq or non-optimistic id) over local echoes.
      if (previous && message.seq !== null && previous.seq === null) {
        byId.delete(existingByNonceId);
        byId.set(message.id, message);
        if (message.clientNonce) {
          idByNonce.set(message.clientNonce, message.id);
        }
        continue;
      }
      if (previous && previous.seq !== null && message.seq === null) {
        continue;
      }
    }

    byId.set(message.id, message);
    if (message.clientNonce) {
      idByNonce.set(message.clientNonce, message.id);
    }
  }

  return [...byId.values()].toSorted((left, right) => {
    if (left.seq !== null && right.seq !== null && left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    if (
      left.timestampMs !== null &&
      right.timestampMs !== null &&
      left.timestampMs !== right.timestampMs
    ) {
      return left.timestampMs - right.timestampMs;
    }
    return left.id.localeCompare(right.id);
  });
}

/**
 * Self-contained read-only Fiber/store lookup shared by CDP Runtime.evaluate expressions.
 * Touches only renderer UI stores (roster/transcript); never reads tokens, cookies, or Keychain.
 */
const RENDERER_STORE_HELPER_SNIPPET = `
  const findStores = () => {
    const rootEl = document.querySelector(".sand-agent-item") || document.querySelector("#root") || document.body;
    if (!rootEl) return null;
    const fiberKey = Object.keys(rootEl).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (!fiberKey) return null;
    let fiber = rootEl[fiberKey];
    const found = { roster: null, transcript: null };
    let depth = 0;
    while (fiber && depth < 160) {
      const value = fiber.memoizedProps && fiber.memoizedProps.value;
      if (value && typeof value === "object") {
        if (!found.roster && (Array.isArray(value.agents) || typeof value.getAgents === "function" || Array.isArray(value.bots))) {
          found.roster = value;
        }
        if (!found.transcript && (typeof value.getMessages === "function" || typeof value.sendPrompt === "function" || typeof value.sendMessage === "function" || value.byAgentId)) {
          found.transcript = value;
        }
      }
      fiber = fiber.return;
      depth += 1;
    }
    return found.roster || found.transcript ? found : null;
  };
`;

export function buildDiscoverBotsExpression(): string {
  return `(async () => {
    try {
      ${RENDERER_STORE_HELPER_SNIPPET}
      const stores = findStores();
      if (!stores || !stores.roster) {
        return { ok: false, reason: "store_unavailable" };
      }
      const rawAgents = typeof stores.roster.getAgents === "function"
        ? await stores.roster.getAgents()
        : Array.isArray(stores.roster.agents)
          ? stores.roster.agents
          : Array.isArray(stores.roster.bots)
            ? stores.roster.bots
            : [];
      const bots = rawAgents.map((a) => ({
        id: a && (a.id ?? a.agentId ?? a.botId),
        name: a && (a.name ?? a.title),
        description: a && a.description,
        avatarDataUrl: a && (a.avatarDataUrl ?? a.avatarUrl),
        avatarShape: a && (a.avatarShape ?? a.shape),
        avatarColor: a && (a.avatarColor ?? a.color),
        status: a && (a.status ?? a.activityState),
        isRunning: Boolean(a && a.isRunning),
        awaitingUserResponse: Boolean(a && a.awaitingUserResponse),
        unreadCount: a && a.unreadCount,
        hasUnread: Boolean(a && a.hasUnread),
        lastMessagePreview: a && (a.lastMessagePreview ?? a.preview),
        lastActivityAtMs: a && (a.lastActivityAtMs ?? a.updatedAtMs),
      }));
      return { ok: true, data: { bots } };
    } catch {
      return { ok: false, reason: "store_unavailable" };
    }
  })()`;
}

export function buildListMessagesExpression(botId: string, cursor?: string): string {
  const argsJson = JSON.stringify({ botId, cursor: cursor ?? null });
  return `(async () => {
    try {
      const args = ${argsJson};
      ${RENDERER_STORE_HELPER_SNIPPET}
      const stores = findStores();
      if (!stores || !stores.transcript) {
        return { ok: false, reason: "store_unavailable" };
      }
      const transcript = stores.transcript;
      const result = typeof transcript.getMessages === "function"
        ? await transcript.getMessages(args.botId, args.cursor)
        : transcript.byAgentId && transcript.byAgentId[args.botId]
          ? { messages: transcript.byAgentId[args.botId], nextCursor: null, hasMore: false }
          : null;
      if (!result) {
        return { ok: false, reason: "bot_not_found" };
      }
      const messages = Array.isArray(result) ? result : Array.isArray(result.messages) ? result.messages : [];
      return {
        ok: true,
        data: {
          messages,
          nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
          hasMore: Boolean(result.hasMore),
        },
      };
    } catch {
      return { ok: false, reason: "store_unavailable" };
    }
  })()`;
}

export function buildSendMessageExpression(
  botId: string,
  text: string,
  clientNonce: string,
): string {
  const argsJson = JSON.stringify({ botId, text, clientNonce });
  return `(async () => {
    try {
      const args = ${argsJson};
      ${RENDERER_STORE_HELPER_SNIPPET}
      const stores = findStores();
      if (!stores || !stores.transcript) {
        return { ok: false, reason: "store_unavailable" };
      }
      const transcript = stores.transcript;
      if (typeof transcript.sendMessage === "function") {
        const res = await transcript.sendMessage(args.botId, args.text, { clientNonce: args.clientNonce });
        return { ok: true, data: { accepted: true, messageId: res && typeof res.id === "string" ? res.id : null } };
      }
      if (typeof transcript.sendPrompt === "function") {
        const res = await transcript.sendPrompt({ agentId: args.botId, text: args.text, clientNonce: args.clientNonce });
        return { ok: true, data: { accepted: true, messageId: res && typeof res.id === "string" ? res.id : null } };
      }
      return { ok: false, reason: "action_rejected" };
    } catch {
      return { ok: false, reason: "action_rejected" };
    }
  })()`;
}

export function buildCancelRunExpression(botId: string): string {
  const argsJson = JSON.stringify({ botId });
  return `(async () => {
    try {
      const args = ${argsJson};
      ${RENDERER_STORE_HELPER_SNIPPET}
      const stores = findStores();
      if (!stores || !stores.transcript) {
        return { ok: false, reason: "store_unavailable" };
      }
      const transcript = stores.transcript;
      if (typeof transcript.cancelRun === "function") {
        await transcript.cancelRun(args.botId);
        return { ok: true, data: { cancelled: true } };
      }
      if (typeof transcript.interruptAgentRun === "function") {
        await transcript.interruptAgentRun(args.botId);
        return { ok: true, data: { cancelled: true } };
      }
      return { ok: true, data: { cancelled: false } };
    } catch {
      return { ok: true, data: { cancelled: false } };
    }
  })()`;
}
