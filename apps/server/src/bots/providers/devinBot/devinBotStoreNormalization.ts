import { parseBase64DataUrl } from "../../../imageMime.ts";
import {
  validateLoopbackWebSocketUrl,
  type CdpTargetDescriptor,
} from "../grokBot/grokBotStoreNormalization.ts";
import {
  DevinBotLoopbackViolationError,
  type DevinBotSnapshot,
  type DevinBotSummary,
  type DevinChildSession,
  type DevinInboxSummary,
  type DevinInboxTicket,
  type DevinMessage,
  type DevinMessagePage,
} from "./DevinBotTransport.ts";

export type { CdpTargetDescriptor };

const MAX_AVATAR_DATA_URL_LENGTH = 96 * 1024;
const MAX_TITLE_LENGTH = 300;
const MAX_DETAIL_LENGTH = 4_000;
const MAX_CURSOR_LENGTH = 2_048;

const DEVIN_BOT_ID = /^bot-[0-9a-f]{32}$/;
export const DEVIN_SESSION_ID = /^(devin-)?[0-9a-f]{32}$/;
const DEVIN_BOARD_ID = /^board-[0-9a-f]{32}$/;
const DEVIN_TICKET_ID = /^ticket-[0-9a-f]{32}$/;
const DEVIN_ORG_ID = /^org-[0-9a-f]{32}$/;

export interface ValidatedDevinEndpoint {
  readonly port: number;
  readonly httpOrigin: string;
  readonly jsonListUrl: string;
}

export function validateDevinLoopbackEndpoint(input: {
  readonly host: string;
  readonly port: number;
}):
  | { readonly ok: true; readonly endpoint: ValidatedDevinEndpoint }
  | { readonly ok: false; readonly error: DevinBotLoopbackViolationError } {
  const host = input.host.trim();
  const port = input.port;
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      ok: false,
      error: new DevinBotLoopbackViolationError({ host, port: Number.isFinite(port) ? port : -1 }),
    };
  }
  const httpOrigin = `http://127.0.0.1:${port}`;
  return { ok: true, endpoint: { port, httpOrigin, jsonListUrl: `${httpOrigin}/json` } };
}

/** Devin's VS Code workbench window: the only page that mounts the Devin webapp. */
function scoreDevinTarget(target: CdpTargetDescriptor): number {
  if (target.type !== "page") return -1;
  const url = (target.url ?? "").toLowerCase();
  if (!url.startsWith("vscode-file://vscode-app/")) return -1;
  if (!url.includes("/workbench/")) return -1;
  return url.includes("devin.app") ? 20 : 10;
}

export function selectDevinWorkbenchTarget(
  targets: ReadonlyArray<CdpTargetDescriptor>,
  expectedPort: number,
): { readonly target: CdpTargetDescriptor; readonly webSocketDebuggerUrl: string } | null {
  let best: {
    readonly target: CdpTargetDescriptor;
    readonly webSocketDebuggerUrl: string;
    readonly score: number;
  } | null = null;
  for (const target of targets) {
    if (!target.webSocketDebuggerUrl) continue;
    const safeWsUrl = validateLoopbackWebSocketUrl(target.webSocketDebuggerUrl, expectedPort);
    if (!safeWsUrl) continue;
    const score = scoreDevinTarget(target);
    if (score < 0 || (best && best.score >= score)) continue;
    best = { target, webSocketDebuggerUrl: safeWsUrl, score };
  }
  return best ? { target: best.target, webSocketDebuggerUrl: best.webSocketDebuggerUrl } : null;
}

export type DevinBridgeOperation =
  | "snapshot"
  | "avatar"
  | "children"
  | "messages"
  | "inbox"
  | "send"
  | "sleep"
  | "resolve";

// Runs inside Devin's renderer. It finds the webapp's own API client and org by duck-typing React
// context values under `.devin-app-root` (no minified names), never reads tokens, cookies or
// `window.vscode`, and returns only the fields mattr maps. Wrapped in an IIFE so nothing leaks
// into the page's globals.
const BRIDGE_BODY = String.raw`
  const fail = (reason, status) => (status ? { ok: false, reason, status } : { ok: false, reason });
  const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);
  const findContext = () => {
    let api = null;
    let auth = null;
    for (const root of document.querySelectorAll(".devin-app-root")) {
      const key = Object.keys(root).find((name) => name.startsWith("__reactContainer$"));
      const container = key ? root[key] : null;
      if (!container) continue;
      const stack = [container.stateNode?.current ?? container];
      const seen = new Set();
      while (stack.length > 0 && seen.size < 50000) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const value = props && typeof props === "object" ? props.value : null;
        if (value && typeof value === "object") {
          const client = value.client;
          if (!api && typeof value.invalidateQueries === "function" && client && typeof client.api === "function" && typeof client.api.get === "function" && typeof client.api.post === "function") api = client.api;
          if (!auth && typeof value.orgId === "string" && typeof value.isAuthenticated === "boolean" && typeof value.changeOrganization === "function") auth = { orgId: value.orgId, signedIn: value.isAuthenticated };
        }
        if (api && auth) return { api, auth };
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
    }
    return null;
  };
  const context = findContext();
  if (!context) return fail("store_unavailable");
  if (!context.auth.signedIn || !/^org-[0-9a-f]{32}$/.test(context.auth.orgId)) return fail("auth_required");
  const org = encodeURIComponent(context.auth.orgId);
  const enc = encodeURIComponent;
  const request = async (method, path, options) => {
    const response = await context.api[method](path, { throwHttpErrors: false, retry: 0, timeout: 15000, ...options });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  };
  const httpFail = (status) => fail(status === 401 ? "auth_required" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 429 ? "rate_limited" : "rejected", status);
  const ok = (data) => ({ ok: true, data });
  const sent = (response) => (response.status >= 200 && response.status < 300 ? ok({}) : httpFail(response.status));
  const labels = (list) => (Array.isArray(list) ? list.map((entry) => entry && text(entry.label)).filter(Boolean) : []);

  if (op === "snapshot") {
    const listed = await request("get", "poke/bots", { searchParams: { include_shared: "true" } });
    if (listed.status !== 200 || !Array.isArray(listed.body)) return httpFail(listed.status);
    const bots = await Promise.all(listed.body.filter((bot) => bot && typeof bot.bot_id === "string").map(async (bot) => {
      const response = await request("get", "poke/bots/" + enc(bot.bot_id) + "/session");
      const session = response.status === 200 && response.body ? response.body.session : null;
      return {
        id: bot.bot_id,
        name: text(bot.name),
        avatarUrl: text(bot.avatar_url),
        session: session && typeof session.devin_id === "string" ? { devinId: session.devin_id, status: text(session.status), statusEnum: text(session.status_enum), isUnread: session.is_unread === true, needsAttention: session.needs_attention === true } : null,
      };
    }));
    const summaries = await request("get", org + "/boards/inbox/summaries");
    const rows = summaries.status === 200 && summaries.body && Array.isArray(summaries.body.inboxes) ? summaries.body.inboxes : [];
    const inboxes = rows.filter((row) => row && typeof row.agent_bot_id === "string" && typeof row.board_id === "string").map((row) => ({ botId: row.agent_bot_id, boardId: row.board_id, askCount: typeof row.ask_count === "number" ? row.ask_count : 0 }));
    return ok({ orgId: context.auth.orgId, bots, inboxes });
  }
  if (op === "avatar") {
    let url;
    try { url = new URL(args.url); } catch { return fail("invalid_args"); }
    const host = url.hostname;
    if (url.protocol !== "https:" || !(host.endsWith(".devinusercontent.com") || host === "devin.ai" || host.endsWith(".devin.ai"))) return fail("invalid_args");
    const response = await fetch(url.href, { credentials: "omit" });
    if (!response.ok) return httpFail(response.status);
    const blob = await response.blob();
    if (blob.size > 8 * 1024 * 1024) return fail("rejected");
    const bitmap = await createImageBitmap(blob);
    const size = 96;
    const canvas = new OffscreenCanvas(size, size);
    const scale = Math.max(size / bitmap.width, size / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    canvas.getContext("2d").drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
    bitmap.close();
    const encoded = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(encoded);
    });
    return ok({ dataUrl });
  }
  if (op === "children") {
    const response = await request("get", "v3/organizations/" + org + "/sessions", { searchParams: { parent_session_id: args.devinId, first: "100" } });
    if (response.status !== 200 || !response.body || !Array.isArray(response.body.items)) return httpFail(response.status);
    return ok({ sessions: response.body.items.map((session) => ({ devinId: text(session.session_id), title: text(session.title), status: text(session.status), statusDetail: text(session.status_detail), updatedAt: typeof session.updated_at === "number" || typeof session.updated_at === "string" ? session.updated_at : null, archived: session.is_archived === true })) });
  }
  if (op === "messages") {
    const searchParams = args.after ? { first: "200", after: args.after } : { first: "200" };
    const response = await request("get", "v3/organizations/" + org + "/sessions/" + enc(args.devinId) + "/messages", { searchParams });
    if (response.status !== 200 || !response.body || !Array.isArray(response.body.items)) return httpFail(response.status);
    return ok({
      messages: response.body.items.map((message) => ({ eventId: text(message.event_id), source: text(message.source), text: typeof message.message === "string" ? message.message : "", createdAt: typeof message.created_at === "number" ? message.created_at : null, origin: text(message.origin), fromAgent: typeof message.user_id === "string" && message.user_id.startsWith("devin-") })),
      endCursor: text(response.body.end_cursor),
      hasNextPage: response.body.has_next_page === true,
    });
  }
  if (op === "inbox") {
    const response = await request("get", org + "/boards/" + enc(args.boardId));
    if (response.status !== 200 || !response.body || !Array.isArray(response.body.tickets)) return httpFail(response.status);
    const now = Date.now();
    const open = response.body.tickets.filter((ticket) => ticket && ticket.inbox && !ticket.inbox.resolution && !ticket.deleted_at && ticket.category === "started" && ticket.inbox.on_hold !== true && !(ticket.inbox.snoozed_until && Date.parse(ticket.inbox.snoozed_until) > now));
    return ok({ tickets: open.map((ticket) => ({ ticketId: text(ticket.ticket_id), title: text(ticket.title), summary: text(ticket.inbox.summary), details: text(ticket.inbox.details), cardType: text(ticket.inbox.card && ticket.inbox.card.type), options: labels(ticket.inbox.card && ticket.inbox.card.options), buttons: labels(ticket.inbox.card && ticket.inbox.card.buttons), createdAt: text(ticket.inbox.engaged_at) || text(ticket.created_at) })) });
  }
  if (op === "send") {
    return sent(await request("post", "v3/organizations/" + org + "/sessions/" + enc(args.devinId) + "/messages", { json: { message: args.text } }));
  }
  if (op === "sleep") {
    return sent(await request("post", "sessions/" + enc(args.devinId) + "/sleep"));
  }
  if (op === "resolve") {
    const body = args.option === null ? { action: args.action } : { action: args.action, option: args.option };
    return sent(await request("post", org + "/boards/" + enc(args.boardId) + "/tickets/" + enc(args.ticketId) + "/inbox-resolve", { json: body }));
  }
  return fail("invalid_args");
`;

/** A self-contained renderer expression; `args` is embedded as JSON, never as code. */
export function buildDevinBridgeExpression(
  op: DevinBridgeOperation,
  args: Readonly<Record<string, string | null>> = {},
): string {
  return `(async (op, args) => {${BRIDGE_BODY}})(${JSON.stringify(op)}, ${JSON.stringify(args)}).catch(() => ({ ok: false, reason: "rejected" }))`;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asText = (value: unknown, max = MAX_TITLE_LENGTH): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
};

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

export function isDevinCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH;
}

export function isDevinBoardId(value: string): boolean {
  return DEVIN_BOARD_ID.test(value);
}

export function isDevinTicketId(value: string): boolean {
  return DEVIN_TICKET_ID.test(value);
}

export function normalizeDevinSnapshot(data: Record<string, unknown>): DevinBotSnapshot | null {
  if (!matches(data.orgId, DEVIN_ORG_ID)) return null;
  const bots: DevinBotSummary[] = [];
  for (const entry of Array.isArray(data.bots) ? data.bots : []) {
    const bot = asRecord(entry);
    if (!bot || !matches(bot.id, DEVIN_BOT_ID)) continue;
    const session = asRecord(bot.session);
    bots.push({
      id: bot.id,
      name: asText(bot.name) ?? "Devin Bot",
      avatarUrl: asText(bot.avatarUrl, 2_048),
      session:
        session && matches(session.devinId, DEVIN_SESSION_ID)
          ? {
              devinId: session.devinId,
              status: asText(session.status, 64),
              statusEnum: asText(session.statusEnum, 64),
              isUnread: session.isUnread === true,
              needsAttention: session.needsAttention === true,
            }
          : null,
    });
  }
  const inboxes: DevinInboxSummary[] = [];
  for (const entry of Array.isArray(data.inboxes) ? data.inboxes : []) {
    const row = asRecord(entry);
    if (!row || !matches(row.botId, DEVIN_BOT_ID) || !matches(row.boardId, DEVIN_BOARD_ID)) {
      continue;
    }
    const askCount = typeof row.askCount === "number" && row.askCount > 0 ? row.askCount : 0;
    inboxes.push({ botId: row.botId, boardId: row.boardId, askCount });
  }
  return { orgId: data.orgId, bots, inboxes };
}

const toMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1_000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export function normalizeDevinChildSessions(
  data: Record<string, unknown>,
): ReadonlyArray<DevinChildSession> {
  const sessions: DevinChildSession[] = [];
  for (const entry of Array.isArray(data.sessions) ? data.sessions : []) {
    const session = asRecord(entry);
    if (!session || session.archived === true || !matches(session.devinId, DEVIN_SESSION_ID)) {
      continue;
    }
    sessions.push({
      devinId: session.devinId.replace(/^devin-/, ""),
      title: asText(session.title),
      status: asText(session.status, 64),
      statusDetail: asText(session.statusDetail, 64),
      updatedAtMs: toMs(session.updatedAt),
    });
  }
  return sessions;
}

export function normalizeDevinMessagePage(data: Record<string, unknown>): DevinMessagePage {
  const messages: DevinMessage[] = [];
  for (const entry of Array.isArray(data.messages) ? data.messages : []) {
    const message = asRecord(entry);
    if (!message) continue;
    const eventId = asText(message.eventId, 512);
    const source = message.source === "devin" || message.source === "user" ? message.source : null;
    if (!eventId || !source) continue;
    messages.push({
      eventId,
      source,
      text: typeof message.text === "string" ? message.text : "",
      createdAtSec:
        typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
          ? message.createdAt
          : 0,
      origin: asText(message.origin, 64),
      fromAgent: message.fromAgent === true,
    });
  }
  return {
    messages,
    endCursor: isDevinCursor(data.endCursor) ? data.endCursor : null,
    hasNextPage: data.hasNextPage === true,
  };
}

const labelList = (value: unknown): ReadonlyArray<string> =>
  (Array.isArray(value) ? value : [])
    .map((label) => asText(label, MAX_TITLE_LENGTH))
    .filter((label): label is string => label !== null);

export function normalizeDevinInboxTickets(
  boardId: string,
  data: Record<string, unknown>,
): ReadonlyArray<DevinInboxTicket> {
  const tickets: DevinInboxTicket[] = [];
  for (const entry of Array.isArray(data.tickets) ? data.tickets : []) {
    const ticket = asRecord(entry);
    if (!ticket || !matches(ticket.ticketId, DEVIN_TICKET_ID)) continue;
    const summary = asText(ticket.summary);
    tickets.push({
      boardId,
      ticketId: ticket.ticketId,
      title: summary ?? asText(ticket.title) ?? "Devin needs you",
      detail: asText(ticket.details, MAX_DETAIL_LENGTH),
      cardType: asText(ticket.cardType, 64) ?? "freeform",
      options: labelList(ticket.options),
      buttons: labelList(ticket.buttons),
      createdAt: asText(ticket.createdAt, 64),
    });
  }
  return tickets;
}

/** Accepts only the small WebP the bridge re-encodes, so no original image bytes pass through. */
export function sanitizeDevinAvatarDataUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_AVATAR_DATA_URL_LENGTH) return null;
  const parsed = parseBase64DataUrl(raw.trim());
  if (!parsed || parsed.mimeType !== "image/webp") return null;
  return `data:image/webp;base64,${parsed.base64}`;
}
