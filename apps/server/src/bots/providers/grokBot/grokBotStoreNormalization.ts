import { parseBase64DataUrl } from "../../../imageMime.ts";
import {
  buildGrokBotPromptDeepLink,
  GROK_BOT_DEFAULT_CDP_HOST,
  GROK_BOT_DEFAULT_CDP_PORT,
} from "./grokBotDeepLinks.ts";
import {
  GrokBotLoopbackViolationError,
  type GrokBotActivityStatus,
  type GrokBotAttachment,
  type GrokBotMessage,
  type GrokBotMessageRole,
  type GrokBotOpenWidget,
  type GrokBotSummary,
  type GrokBotWidgetOption,
} from "./GrokBotTransport.ts";

const GROK_BOT_MAX_AVATAR_DATA_URL_LENGTH = 512 * 1024;
const GROK_BOT_MAX_PREVIEW_LENGTH = 280;
const GROK_BOT_MAX_ACTIVITY_DETAIL_LENGTH = 160;

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

  const activityDetail = isRunning
    ? (asNonEmptyString(record.activityDetail)?.slice(0, GROK_BOT_MAX_ACTIVITY_DETAIL_LENGTH) ??
      null)
    : null;

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
    activityDetail,
    deepLinkUrl: buildGrokBotPromptDeepLink({ botId: id }),
  };
}

function normalizeWidgetOptions(raw: unknown): readonly GrokBotWidgetOption[] {
  if (!Array.isArray(raw)) return [];
  const options: GrokBotWidgetOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const value = asNonEmptyString(record.value);
    if (!value) continue;
    options.push({ label: asNonEmptyString(record.label) ?? value, value });
  }
  return options;
}

export function normalizeGrokBotOpenWidget(raw: unknown): GrokBotOpenWidget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const botId = asNonEmptyString(record.botId);
  const entryId = asNonEmptyString(record.entryId);
  const options = normalizeWidgetOptions(record.options);
  if (!botId || !entryId || options.length === 0) return null;
  return {
    botId,
    entryId,
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    options,
    timestampMs: asFiniteNumber(record.timestampMs),
  };
}

function normalizeMessageRole(raw: unknown): GrokBotMessageRole {
  const normalized = asNonEmptyString(raw)?.toLowerCase();
  if (normalized === "user" || normalized === "human") return "user";
  if (normalized === "system" || normalized === "tool") return "system";
  return "assistant";
}

function normalizeGrokBotMessage(
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
        : "";
  const seq = asFiniteNumber(record.seq);
  const id =
    asNonEmptyString(record.id ?? record.messageId) ??
    (seq !== null ? `${botId}:seq:${seq}` : `${botId}:idx:${fallbackIndex}`);
  const kind = asNonEmptyString(record.kind);
  const attachmentName = asNonEmptyString(record.attachmentName);
  const attachments: readonly GrokBotAttachment[] =
    kind === "attachment" && attachmentName
      ? [{ id, name: attachmentName, sizeBytes: asFiniteNumber(record.attachmentBytes) }]
      : [];
  const options = kind === "widget" ? normalizeWidgetOptions(record.options) : [];

  return {
    id,
    seq,
    botId,
    role: normalizeMessageRole(record.role),
    text,
    timestampMs: asFiniteNumber(record.timestampMs),
    clientNonce: asNonEmptyString(record.clientNonce),
    replyToId: asNonEmptyString(record.replyToId),
    isStreaming: record.isStreaming === true,
    attachments,
    fromAgentName: asNonEmptyString(record.fromAgentName),
    fromAgentId: asNonEmptyString(record.fromAgentId),
    widget:
      kind === "widget"
        ? { options, respondedValue: asNonEmptyString(record.respondedValue) }
        : null,
    cardType: kind === "card" ? (asNonEmptyString(record.cardType) ?? "card") : null,
  };
}

/**
 * Normalizes a transcript page. Grok Bot stores a user's uploads as their own entries beside the
 * message they were sent with, so they fold into that message by its batch or nonce.
 */
export function normalizeGrokBotTranscript(
  botId: string,
  rawEntries: readonly unknown[],
): readonly GrokBotMessage[] {
  const messages: Array<GrokBotMessage | null> = [];
  const userIndexByBatch = new Map<string, number>();
  rawEntries.forEach((raw, index) => {
    const message = normalizeGrokBotMessage(botId, raw, index);
    if (!message) return;
    const record = raw as Record<string, unknown>;
    const batch =
      message.role === "user" ? (asNonEmptyString(record.batchId) ?? message.clientNonce) : null;
    const hostIndex = batch === null ? undefined : userIndexByBatch.get(batch);
    const host = hostIndex === undefined ? null : messages[hostIndex];
    if (batch === null || hostIndex === undefined || !host) {
      if (batch !== null) userIndexByBatch.set(batch, messages.length);
      messages.push(message);
      return;
    }
    const isUpload = record.kind === "attachment";
    if (isUpload) {
      messages[hostIndex] = { ...host, attachments: [...host.attachments, ...message.attachments] };
      return;
    }
    // The text arrived after its uploads: it takes their place and keeps them.
    messages[hostIndex] = null;
    userIndexByBatch.set(batch, messages.length);
    messages.push({ ...message, attachments: [...host.attachments, ...message.attachments] });
  });
  return deduplicateGrokBotMessages(
    messages.filter((message): message is GrokBotMessage => message !== null),
  );
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
 * Finds Grok Bot's own renderer stores (roster, transcript, sendJournal) through the React context
 * a mounted component reads. Every operation goes through them, so mattr never switches the chat
 * Grok Bot shows, and never reads tokens, cookies or the Keychain.
 */
const RENDERER_STORES_SNIPPET = `
  const findGrokStores = () => {
    const root = document.getElementById("root");
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
    if (!key) return null;
    const container = root[key];
    const stack = [container && container.current ? container.current : container];
    let visited = 0;
    while (stack.length > 0 && visited < 20000) {
      const fiber = stack.pop();
      visited += 1;
      if (!fiber) continue;
      let dep = fiber.dependencies ? fiber.dependencies.firstContext : null;
      for (let n = 0; dep && n < 64; n += 1) {
        const v = dep.memoizedValue;
        if (
          v && typeof v === "object" && v.sendJournal && v.transcript && v.roster && v.roster.snapshots &&
          typeof v.sendJournal.sendPrompt === "function" && typeof v.transcript.snapshotsFor === "function"
        ) return v;
        dep = dep.next;
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return null;
  };
  const rosterRows = (stores) => {
    const snapshot = stores.roster.snapshots.get();
    const agents = snapshot ? snapshot.agents : null;
    if (agents && Array.isArray(agents.rows)) return agents.rows;
    return Array.isArray(agents) ? agents : [];
  };
  const str = (v) => (typeof v === "string" ? v : null);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const failureCode = (error) =>
    error && error.failure && typeof error.failure.code === "string" ? error.failure.code : null;
  const mapEntry = (e) => {
    if (!e || typeof e !== "object") return null;
    const base = {
      id: str(e.id),
      seq: num(e.seq),
      timestampMs: num(e.timestampMs),
      clientNonce: str(e.clientNonce),
      batchId: str(e.batchId),
      isStreaming: e.isStreaming === true,
    };
    if (e.kind === "message") {
      const from = e.fromAgent && typeof e.fromAgent === "object" ? e.fromAgent : null;
      const to = e.toAgent && typeof e.toAgent === "object" ? e.toAgent : null;
      return {
        ...base,
        kind: "message",
        role: e.role === "user" ? "user" : e.role === "system" ? "system" : "assistant",
        text: str(e.content) ?? str(e.text) ?? "",
        fromAgentName: from ? str(from.name) : null,
        fromAgentId: from ? str(from.id) : null,
        toAgentName: to ? str(to.name) : null,
      };
    }
    if (e.kind === "user-attachment") {
      return { ...base, kind: "attachment", role: "user", text: "", attachmentName: str(e.file_name) ?? "Attachment", attachmentBytes: num(e.byteSize) };
    }
    if (e.kind !== "send-message") return null;
    const m = e.message;
    if (typeof m === "string") return { ...base, kind: "message", role: "assistant", text: m };
    if (!m || typeof m !== "object") return null;
    if (m.type === "text" || (m.type === undefined && typeof m.content === "string")) {
      return { ...base, kind: "message", role: "assistant", text: str(m.content) ?? str(m.text) ?? "" };
    }
    if (m.type === "attachment") {
      return { ...base, kind: "attachment", role: "assistant", text: "", attachmentName: str(m.file_name) ?? str(m.alt) ?? "Attachment", attachmentBytes: null };
    }
    if (m.type === "widget" && m.widget && typeof m.widget === "object") {
      const options = (Array.isArray(m.widget.options) ? m.widget.options : [])
        .map((o) => ({ label: str(o && o.label) ?? "", value: str(o && o.value) ?? str(o && o.label) ?? "" }))
        .filter((o) => o.value.length > 0);
      return { ...base, kind: "widget", role: "assistant", text: str(m.widget.prompt) ?? "", options, respondedValue: str(e.respondedValue), dismissed: e.widgetDismissed === true };
    }
    return { ...base, kind: "card", role: "assistant", text: "", cardType: str(m.type) ?? "card" };
  };
`;

const expression = (args: Record<string, unknown>, body: string) => `(async () => {
  try {
    const args = ${JSON.stringify(args)};
    ${RENDERER_STORES_SNIPPET}
    const stores = findGrokStores();
    if (!stores) return { ok: false, reason: "store_unavailable" };
    ${body}
  } catch (error) {
    return { ok: false, reason: "store_unavailable", code: error && error.name ? String(error.name) : null };
  }
})()`;

/** Widgets older than the last few entries are history, not open questions. */
const OPEN_WIDGET_WINDOW = 20;

export function buildDiscoverBotsExpression(): string {
  return expression(
    { openWidgetWindow: OPEN_WIDGET_WINDOW },
    `
    const bots = [];
    const widgets = [];
    for (const a of rosterRows(stores)) {
      if (!a || typeof a.id !== "string" || a.isRemovedFromSidebar === true) continue;
      const activity = a.currentActivity && typeof a.currentActivity === "object" ? a.currentActivity : null;
      bots.push({
        id: a.id,
        name: str(a.name),
        description: str(a.description),
        avatarDataUrl: str(a.avatarDataUrl),
        avatarShape: str(a.avatarShape),
        avatarColor: str(a.avatarColor),
        status: str(a.status),
        isRunning: a.isRunning === true || a.isRunningTurn === true || a.isComposingMessage === true,
        awaitingUserResponse: Boolean(a.awaitingUserResponse),
        unreadCount: num(a.unreadCount),
        hasUnread: a.hasUnread === true,
        lastMessagePreview: str(a.lastMessagePreview),
        lastActivityAtMs: num(a.lastActivityAt) ?? num(a.updatedAt),
        activityDetail: activity ? str(activity.detail) : null,
      });
      const snapshot = stores.transcript.snapshotsFor(a.id).get();
      const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
      const tail = entries.slice(-args.openWidgetWindow);
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        const e = tail[i];
        if (e && e.kind === "message" && e.role === "user") break;
        const mapped = mapEntry(e);
        if (mapped && mapped.kind === "widget" && mapped.id && !mapped.respondedValue && !mapped.dismissed && mapped.options.length > 0) {
          widgets.push({ botId: a.id, entryId: mapped.id, prompt: mapped.text, options: mapped.options, timestampMs: mapped.timestampMs });
          break;
        }
      }
    }
    return { ok: true, data: { bots, widgets } };
    `,
  );
}

const GROK_BOT_MESSAGES_PAGE_SIZE = 50;

export function buildListMessagesExpression(botId: string, cursor?: string): string {
  return expression(
    { botId, cursor: cursor ?? null, limit: GROK_BOT_MESSAGES_PAGE_SIZE, loadWaitMs: 4000 },
    `
    if (!rosterRows(stores).some((a) => a && a.id === args.botId)) return { ok: false, reason: "bot_not_found" };
    const transcript = stores.transcript;
    const snapshots = transcript.snapshotsFor(args.botId);
    const waitFor = (isDone) => new Promise((resolve) => {
      if (isDone()) return resolve(true);
      let unsubscribe = null;
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (typeof unsubscribe === "function") unsubscribe();
        resolve(value);
      };
      const timer = setTimeout(() => finish(isDone()), args.loadWaitMs);
      unsubscribe = snapshots.subscribe(() => { if (isDone()) finish(true); });
    });
    const isLoaded = () => {
      const s = snapshots.get();
      return s.loadState === "ready" || s.failure != null || (Array.isArray(s.entries) && s.entries.length > 0);
    };
    if (!isLoaded() && typeof transcript.load === "function") {
      transcript.load(args.botId, { background: true });
      await waitFor(isLoaded);
    }
    const before = args.cursor !== null && /^\\d+$/.test(args.cursor) ? Number(args.cursor) : null;
    const seqOf = (e) => (e && typeof e.seq === "number" ? e.seq : Number.POSITIVE_INFINITY);
    const page = () => {
      const s = snapshots.get();
      const all = Array.isArray(s.entries) ? s.entries : [];
      const inWindow = before === null ? all : all.filter((e) => seqOf(e) < before);
      return { s, mapped: inWindow.map(mapEntry).filter((m) => m !== null) };
    };
    let current = page();
    if (before !== null && current.mapped.length < args.limit && current.s.hasOlder === true && typeof transcript.loadOlder === "function") {
      const loading = Promise.resolve(transcript.loadOlder(args.botId)).catch(() => undefined);
      await Promise.race([loading, delay(args.loadWaitMs)]);
      current = page();
    }
    const messages = current.mapped.slice(-args.limit);
    const oldestSeq = messages.reduce((min, m) => (m.seq !== null && m.seq < min ? m.seq : min), Number.POSITIVE_INFINITY);
    const hasMore = Number.isFinite(oldestSeq) && (current.mapped.length > messages.length || current.s.hasOlder === true);
    return {
      ok: true,
      data: {
        messages,
        nextCursor: hasMore ? String(oldestSeq) : null,
        hasMore,
        loadFailed: current.s.failure != null && messages.length === 0,
      },
    };
    `,
  );
}

/** Grok Bot's send journal settles well inside this; the CDP request waits a little longer. */
export const GROK_BOT_SEND_SETTLE_MS = 10_000;

export function buildSendMessageExpression(botId: string, text: string): string {
  return expression(
    { botId, text, settleMs: GROK_BOT_SEND_SETTLE_MS },
    `
    if (!rosterRows(stores).some((a) => a && a.id === args.botId)) return { ok: false, reason: "bot_not_found" };
    let nonce = null;
    let journaled = false;
    try {
      const claim = stores.egressTunnel && typeof stores.egressTunnel.claim === "function" ? stores.egressTunnel.claim() : null;
      if (claim && typeof claim.catch === "function") claim.catch(() => undefined);
    } catch {}
    const sending = Promise.resolve().then(() => stores.sendJournal.sendPrompt({
      agentId: args.botId,
      prompt: args.text,
      onNonceAssigned: (event) => { nonce = event && typeof event.nonce === "string" ? event.nonce : nonce; },
      onJournaled: () => { journaled = true; },
      onDispatched: (event) => {
        journaled = true;
        try {
          if (stores.agentUsageRefusalHolds && event) stores.agentUsageRefusalHolds.noteSent(event.agentId, event.nonce);
        } catch {}
      },
    }));
    const outcome = await Promise.race([
      sending.then(
        () => ({ state: "delivered" }),
        (error) => ({ state: "failed", code: failureCode(error) ?? (error && error.name ? String(error.name) : null) }),
      ),
      delay(args.settleMs, { state: "timeout" }),
    ]);
    if (outcome.state === "failed") return { ok: false, reason: "action_rejected", code: outcome.code };
    if (outcome.state === "timeout" && !journaled && nonce === null) return { ok: false, reason: "action_rejected", code: "send/timeout" };
    return { ok: true, data: { accepted: true, nonce, state: outcome.state === "delivered" ? "delivered" : "queued" } };
    `,
  );
}

export function buildCancelRunExpression(botId: string): string {
  return expression(
    { botId, settleMs: 8000 },
    `
    const agent = rosterRows(stores).find((a) => a && a.id === args.botId);
    if (!agent) return { ok: false, reason: "bot_not_found" };
    if (typeof stores.roster.interruptAgentRun !== "function") return { ok: true, data: { cancelled: false } };
    const sessions = Array.isArray(agent.runningSessionIds) ? agent.runningSessionIds.filter((s) => typeof s === "string") : [];
    const requests = sessions.length === 0
      ? [{ agentId: args.botId }]
      : sessions.map((sessionId) => ({ agentId: args.botId, sessionId }));
    const settled = await Promise.race([
      Promise.allSettled(requests.map((request) => Promise.resolve().then(() => stores.roster.interruptAgentRun(request)))),
      delay(args.settleMs, null),
    ]);
    const cancelled = Array.isArray(settled) && settled.every((result) => result.status === "fulfilled");
    return { ok: true, data: { cancelled } };
    `,
  );
}

export function buildRespondToWidgetExpression(
  botId: string,
  entryId: string,
  value: string,
): string {
  return expression(
    { botId, entryId, value, settleMs: 8000 },
    `
    if (typeof stores.transcript.respondToWidget !== "function") return { ok: false, reason: "action_rejected", code: "widget/unsupported" };
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => stores.transcript.respondToWidget({ agentId: args.botId, entryId: args.entryId, value: args.value }))
        .then((result) => ({ accepted: !(result && result.accepted === false) }), (error) => ({ accepted: false, code: failureCode(error) })),
      delay(args.settleMs, { accepted: false, code: "widget/timeout" }),
    ]);
    if (!outcome.accepted) return { ok: false, reason: "action_rejected", code: outcome.code ?? null };
    return { ok: true, data: { accepted: true } };
    `,
  );
}
