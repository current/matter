#!/usr/bin/env node
/**
 * Strictly read-only Devin v3 API probe (HTTP GET only; redacts secrets, IDs, prompts, and repo names).
 * Run with DEVIN_API_KEY="cog_..." (optional DEVIN_ORG_ID) or `--from-devin-cli`.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const DEFAULT_BASE_URL = "https://api.devin.ai";
const SAFE_TAG_RE = /^[a-z0-9_.:/-]{1,48}$/i;

function parseArgs(argv) {
  const opts = {
    fromDevinCli: false,
    baseUrl: process.env.DEVIN_API_BASE_URL || DEFAULT_BASE_URL,
    first: 200,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from-devin-cli") opts.fromDevinCli = true;
    else if (arg === "--base-url" && argv[i + 1]) opts.baseUrl = argv[++i];
    else if (arg === "--first" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n >= 1 && n <= 200) opts.first = n;
    } else if (arg === "-h" || arg === "--help") opts.help = true;
  }
  return opts;
}

function readDevinCliCredential() {
  const credPath = NodePath.join(NodeOS.homedir(), ".local", "share", "devin", "credentials.toml");
  if (!NodeFS.existsSync(credPath)) return null;
  const raw = NodeFS.readFileSync(credPath, "utf8");
  const keyMatch = raw.match(/^\s*windsurf_api_key\s*=\s*"([^"]+)"/m);
  const urlMatch = raw.match(/^\s*devin_api_url\s*=\s*"([^"]+)"/m);
  if (!keyMatch) return null;
  return {
    token: keyMatch[1],
    source: "devin-cli-credentials-toml",
    baseUrl: urlMatch ? urlMatch[1] : DEFAULT_BASE_URL,
  };
}

function resolveAuth(opts) {
  if (process.env.DEVIN_API_KEY && !opts.fromDevinCli) {
    const token = process.env.DEVIN_API_KEY.trim();
    const kind = token.startsWith("cog_")
      ? "pat (cog_)"
      : token.startsWith("apk_")
        ? "legacy-api-key (apk_)"
        : "env-token";
    return { token, source: `env:DEVIN_API_KEY (${kind})`, baseUrl: opts.baseUrl };
  }
  if (opts.fromDevinCli) {
    const cli = readDevinCliCredential();
    if (!cli) {
      console.error("No ~/.local/share/devin/credentials.toml windsurf_api_key found.");
      process.exit(1);
    }
    return {
      token: cli.token,
      source: cli.source,
      baseUrl: opts.baseUrl === DEFAULT_BASE_URL ? cli.baseUrl : opts.baseUrl,
    };
  }
  console.error(
    "No credentials provided. Set DEVIN_API_KEY (and optional DEVIN_ORG_ID), or pass --from-devin-cli.",
  );
  process.exit(1);
}

function idShape(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return typeof value;
  if (/^[a-f0-9]{32}$/i.test(value)) return "<hex:32>";
  const dash = value.indexOf("-");
  if (dash > 0 && dash < 18) {
    return `${value.slice(0, dash + 1)}<${value.length - dash - 1}ch>`;
  }
  return `<str:${value.length}>`;
}

function urlPattern(value) {
  if (!value || typeof value !== "string") return value;
  try {
    const u = new URL(value);
    const segments = u.pathname.split("/").map((seg) => {
      if (!seg) return "";
      if (/^[a-f0-9]{16,}$/i.test(seg) || /^(devin|bot)-[a-f0-9]+$/i.test(seg)) {
        return `<id:${seg.length}>`;
      }
      return seg;
    });
    return `${u.origin}${segments.join("/")}`;
  } catch {
    return "<non-url>";
  }
}

function sanitizeTag(tag) {
  if (typeof tag !== "string") return "<non-string>";
  // Keep only short system-like tags (e.g. agent:poke, board, nightly-memory-refinement-model:normal)
  if (SAFE_TAG_RE.test(tag) && !tag.includes("@")) return tag;
  return `<custom-tag:len=${tag.length}>`;
}

function countBy(items, fn) {
  const counts = {};
  for (const item of items) {
    const key = String(fn(item));
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function getJson(url, token) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON response
  }
  return { status: res.status, json, rawLen: text.length };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "Usage: node matter/research/devin-live-probe.mjs [--from-devin-cli] [--base-url URL] [--first N]",
        "Env:   DEVIN_API_KEY (required unless --from-devin-cli), DEVIN_ORG_ID (optional; auto-discovered via /v3/self)",
        "Mode:  Strictly read-only HTTP GET. Redacts all secrets, IDs, titles, prompts, and repo names.",
      ].join("\n"),
    );
    return;
  }

  const auth = resolveAuth(opts);
  const base = auth.baseUrl.replace(/\/+$/, "");
  const report = {
    probedAt: new Date().toISOString(),
    authSource: auth.source,
    baseUrl: base,
    self: null,
    sessions: null,
    botTagFilter: null,
    singleSessionExtraFields: {},
    messagesProbe: {},
    automations: null,
    schedules: null,
  };

  // 1. GET /v3/self
  const selfRes = await getJson(`${base}/v3/self`, auth.token);
  report.self = {
    httpStatus: selfRes.status,
    keys: selfRes.json ? Object.keys(selfRes.json).sort() : null,
    principalType: selfRes.json?.principal_type ?? null,
    fieldShapes: selfRes.json
      ? Object.fromEntries(
          Object.entries(selfRes.json).map(([k, v]) => [
            k,
            k === "principal_type" || typeof v === "boolean" || typeof v === "number"
              ? v
              : idShape(v),
          ]),
        )
      : null,
    orgMatchesDevinSessionsOrg:
      selfRes.json && "org_id" in selfRes.json && "devin_sessions_org_id" in selfRes.json
        ? selfRes.json.org_id === selfRes.json.devin_sessions_org_id
        : null,
  };

  const orgId =
    process.env.DEVIN_ORG_ID?.trim() ||
    selfRes.json?.devin_sessions_org_id ||
    selfRes.json?.org_id ||
    null;

  if (!orgId) {
    console.log(JSON.stringify(report, null, 2));
    console.error("Could not determine org_id from DEVIN_ORG_ID or GET /v3/self.");
    process.exit(1);
  }

  const orgPath = `${base}/v3/organizations/${encodeURIComponent(orgId)}`;

  // 2. GET /v3/organizations/{org}/sessions
  const sessRes = await getJson(`${orgPath}/sessions?first=${opts.first}`, auth.token);
  const items = Array.isArray(sessRes.json?.items) ? sessRes.json.items : [];
  const sessionRef = new Map(items.map((s, i) => [s.session_id, `S${i + 1}`]));
  const suRef = new Map();
  let suCounter = 0;
  const labelSu = (id) => {
    if (!id) return null;
    if (!suRef.has(id)) suRef.set(id, `SU${++suCounter}`);
    return suRef.get(id);
  };

  const botRoots = items.filter((s) => Array.isArray(s.tags) && s.tags.includes("agent:poke"));
  for (const b of botRoots) labelSu(b.service_user_id);

  const allSessionKeys = new Set();
  for (const s of items) {
    for (const k of Object.keys(s)) allSessionKeys.add(k);
  }

  const parentChildTrees = items
    .filter((s) => Array.isArray(s.child_session_ids) && s.child_session_ids.length > 0)
    .map((parent) => {
      const children = parent.child_session_ids
        .map((cid) => items.find((x) => x.session_id === cid))
        .filter(Boolean);
      return {
        ref: sessionRef.get(parent.session_id),
        idShape: idShape(parent.session_id),
        urlPattern: urlPattern(parent.url),
        origin: parent.origin ?? null,
        devinMode: parent.devin_mode ?? null,
        status: parent.status ?? null,
        statusDetail: parent.status_detail ?? null,
        tags: (parent.tags || []).map(sanitizeTag),
        serviceUserRef: labelSu(parent.service_user_id),
        parentRef: parent.parent_session_id
          ? sessionRef.get(parent.parent_session_id) ||
            `EXTERNAL:${idShape(parent.parent_session_id)}`
          : null,
        childCount: parent.child_session_ids.length,
        childrenInPage: children.length,
        childServiceUserRefs: [...new Set(children.map((c) => labelSu(c.service_user_id)))],
        childTags: [...new Set(children.flatMap((c) => (c.tags || []).map(sanitizeTag)))],
        childDevinModes: [...new Set(children.map((c) => c.devin_mode ?? null))],
        childPrTotal: children.reduce(
          (acc, c) => acc + (Array.isArray(c.pull_requests) ? c.pull_requests.length : 0),
          0,
        ),
      };
    });

  const memSessions = items
    .filter(
      (s) => Array.isArray(s.tags) && s.tags.some((t) => t.startsWith("nightly-memory-refinement")),
    )
    .map((s) => ({
      ref: sessionRef.get(s.session_id),
      serviceUserRef: labelSu(s.service_user_id),
      matchesBotServiceUser: botRoots.some(
        (b) => b.service_user_id && b.service_user_id === s.service_user_id,
      ),
    }));

  report.sessions = {
    httpStatus: sessRes.status,
    topLevelKeys: sessRes.json ? Object.keys(sessRes.json).sort() : null,
    count: items.length,
    hasNextPage: sessRes.json?.has_next_page ?? null,
    total: sessRes.json?.total ?? null,
    sessionObjectKeys: [...allSessionKeys].sort(),
    sessionIdShapes: countBy(items, (s) => idShape(s.session_id)),
    urlPatterns: countBy(items, (s) => urlPattern(s.url)),
    origins: countBy(items, (s) => s.origin ?? null),
    devinModes: countBy(items, (s) => s.devin_mode ?? null),
    statuses: countBy(items, (s) => s.status ?? null),
    statusDetails: countBy(items, (s) => s.status_detail ?? null),
    tags: countBy(
      items.flatMap((s) => (Array.isArray(s.tags) ? s.tags : [])),
      sanitizeTag,
    ),
    withParentCount: items.filter((s) => Boolean(s.parent_session_id)).length,
    withChildrenCount: parentChildTrees.length,
    botRootCount: botRoots.length,
    parentChildTrees,
    nightlyMemoryRefinementSessions: memSessions,
  };

  // 3. Server-side ?tags=agent:poke filter check
  const tagRes = await getJson(`${orgPath}/sessions?tags=agent%3Apoke&first=50`, auth.token);
  report.botTagFilter = {
    httpStatus: tagRes.status,
    count: Array.isArray(tagRes.json?.items) ? tagRes.json.items.length : null,
    refs: Array.isArray(tagRes.json?.items)
      ? tagRes.json.items.map((s) => sessionRef.get(s.session_id) || idShape(s.session_id))
      : null,
  };

  // 4. Single-session GET comparison (bot root vs board child vs non-bot)
  const samples = [
    ["botRoot", botRoots[0]],
    ["boardChild", items.find((s) => Array.isArray(s.tags) && s.tags.includes("board"))],
    [
      "nonBot",
      items.find(
        (s) =>
          !s.service_user_id &&
          !(Array.isArray(s.tags) && (s.tags.includes("agent:poke") || s.tags.includes("board"))),
      ),
    ],
  ];
  for (const [label, sample] of samples) {
    if (!sample) continue;
    const detailRes = await getJson(
      `${orgPath}/sessions/${encodeURIComponent(sample.session_id)}`,
      auth.token,
    );
    const listKeys = new Set(Object.keys(sample));
    const detailKeys = detailRes.json ? Object.keys(detailRes.json) : [];
    report.singleSessionExtraFields[label] = {
      httpStatus: detailRes.status,
      ref: sessionRef.get(sample.session_id),
      extraKeysBeyondList: detailKeys.filter((k) => !listKeys.has(k)).sort(),
      hasBotName: Boolean(detailRes.json?.bot_name),
      botNameEqualsTitle:
        typeof detailRes.json?.bot_name === "string" &&
        detailRes.json.bot_name === detailRes.json.title,
      hasSuperdevinName: Boolean(detailRes.json?.superdevin_name),
      selectedDevinMode: detailRes.json?.selected_devin_mode ?? null,
    };
  }

  // 5. Messages probe (read-only GET, first=10) on 1 bot root + 1 board child
  for (const [label, sample] of samples.slice(0, 2)) {
    if (!sample) continue;
    const msgRes = await getJson(
      `${orgPath}/sessions/${encodeURIComponent(sample.session_id)}/messages?first=10`,
      auth.token,
    );
    const msgs = Array.isArray(msgRes.json?.items) ? msgRes.json.items : [];
    const msgKeys = new Set();
    for (const m of msgs) {
      for (const k of Object.keys(m)) msgKeys.add(k);
    }
    report.messagesProbe[label] = {
      httpStatus: msgRes.status,
      ref: sessionRef.get(sample.session_id),
      topLevelKeys: msgRes.json ? Object.keys(msgRes.json).sort() : null,
      count: msgs.length,
      hasNextPage: msgRes.json?.has_next_page ?? null,
      messageKeys: [...msgKeys].sort(),
      sources: countBy(msgs, (m) => m.source ?? null),
      origins: countBy(msgs, (m) => m.origin ?? null),
      eventIdShape: msgs[0] ? idShape(msgs[0].event_id) : null,
    };
  }

  // 6. Automations & schedules probe (read-only GET)
  const autoRes = await getJson(`${orgPath}/automations?first=50`, auth.token);
  const autos = Array.isArray(autoRes.json?.items) ? autoRes.json.items : [];
  report.automations = {
    httpStatus: autoRes.status,
    count: autos.length,
    total: autoRes.json?.total ?? null,
    items: autos.map((a, i) => ({
      ref: `A${i + 1}`,
      kind: a.kind ?? null,
      enabled: a.enabled ?? null,
      triggerEventTypes: (a.triggers || []).map((t) => t.event_type ?? t.type ?? null),
      runAsType: a.run_as?.type ?? null,
      runAsServiceUserRef: labelSu(a.run_as?.service_user_id),
      runAsMatchesBotRef: botRoots.find(
        (b) => b.service_user_id && b.service_user_id === a.run_as?.service_user_id,
      )
        ? sessionRef.get(
            botRoots.find((b) => b.service_user_id === a.run_as?.service_user_id).session_id,
          )
        : null,
      actions: (a.actions || []).map((act) => ({
        type: act.type ?? null,
        keys: Object.keys(act).sort(),
        targetBotIdShape: idShape(act.target_bot_id ?? null),
        targetDevinIdShape: idShape(act.target_devin_id ?? null),
      })),
    })),
  };

  const schedRes = await getJson(`${orgPath}/schedules?first=20`, auth.token);
  report.schedules = {
    httpStatus: schedRes.status,
    count: Array.isArray(schedRes.json?.items) ? schedRes.json.items.length : null,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Probe failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
