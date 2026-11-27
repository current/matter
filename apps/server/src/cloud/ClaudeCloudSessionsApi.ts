import {
  type ClaudeCloudAccountProblemNote,
  type ClaudeCloudErrorCode,
  type ClaudeCloudInterruptRequest,
  type ClaudeCloudPendingRequest,
  type ClaudeCloudRemoteSession,
  type ClaudeCloudRemoteSessionsResponse,
  type ClaudeCloudSessionState,
  type ClaudeCloudTranscriptResponse,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type TrackedClaudeCloudSession,
  ClaudeCloudSessionId,
  claudeCloudSessionUrl,
  parseClaudeCloudSessionRef,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  claudeAccountConfigPath,
  readClaudeOrganizationId,
} from "../provider/claudeResetCredits.ts";
import * as ClaudeCloudRunner from "./ClaudeCloudRunner.ts";
import * as ClaudeCloudService from "./ClaudeCloudService.ts";
import {
  type ClaudeCloudTranscriptActivity,
  mapClaudeCloudEvents,
} from "./claudeCloudTranscript.ts";

const API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "ccr-byoc-2025-07-29";
const SESSIONS_LIST_LIMIT = 100;
const EVENTS_PAGE_LIMIT = 1000;
const MAX_EVENT_PAGES = 50;
const HTTP_TIMEOUT_MS = 20_000;
const KEYCHAIN_TIMEOUT_MS = 10_000;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 12;
const TRANSCRIPT_FETCH_MIN_INTERVAL_MS = 1_000;

export const CLAUDE_CLOUD_REFRESH_REQUIRED_DETAIL =
  "Claude's sign-in needs a refresh: run any Claude chat or `claude` once.";

const INTERRUPT_UNSUPPORTED_DETAIL =
  "Interrupting a Claude Cloud session isn't supported yet: the Claude CLI does not allow attaching to an existing cloud session for this account. Stop it on claude.ai or in the Claude app.";

const fail = (code: ClaudeCloudErrorCode, message: string) =>
  Effect.fail(new ClaudeCloudService.ClaudeCloudError({ code, message }));

const OAuthCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeOAuthCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthCredentials));

const PostTurnSummarySchema = Schema.Struct({
  status_category: Schema.optional(Schema.NullOr(Schema.String)),
  status_detail: Schema.optional(Schema.NullOr(Schema.String)),
  recent_action: Schema.optional(Schema.NullOr(Schema.String)),
  needs_action: Schema.optional(Schema.NullOr(Schema.String)),
});

const ContextUsageSchema = Schema.Struct({
  used_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  max_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
});

const ExternalMetadataSchema = Schema.Struct({
  current_branches: Schema.optional(Schema.Unknown),
  context_usage: Schema.optional(Schema.NullOr(ContextUsageSchema)),
  last_served_model: Schema.optional(Schema.NullOr(Schema.String)),
  post_turn_summary: Schema.optional(Schema.NullOr(PostTurnSummarySchema)),
});

const SessionSourceSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const SessionOutcomeSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  git_info: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repo: Schema.optional(Schema.NullOr(Schema.String)),
        branches: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
});

const SessionContextSchema = Schema.Struct({
  sources: Schema.optional(Schema.NullOr(Schema.Array(SessionSourceSchema))),
  outcomes: Schema.optional(Schema.NullOr(Schema.Array(SessionOutcomeSchema))),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  permission_mode: Schema.optional(Schema.NullOr(Schema.String)),
});

const RemoteSessionApiSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  session_status: Schema.optional(Schema.NullOr(Schema.String)),
  status_bucket: Schema.optional(Schema.NullOr(Schema.String)),
  unread: Schema.optional(Schema.NullOr(Schema.Boolean)),
  connection_status: Schema.optional(Schema.NullOr(Schema.String)),
  environment_kind: Schema.optional(Schema.NullOr(Schema.String)),
  origin: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  configured_model: Schema.optional(Schema.NullOr(Schema.String)),
  post_turn_summary: Schema.optional(Schema.NullOr(PostTurnSummarySchema)),
  external_metadata: Schema.optional(Schema.NullOr(ExternalMetadataSchema)),
  session_context: Schema.optional(Schema.NullOr(SessionContextSchema)),
});
type RemoteSessionApi = typeof RemoteSessionApiSchema.Type;

const RemoteSessionsListResponseSchema = Schema.Struct({
  data: Schema.Array(RemoteSessionApiSchema),
  has_more: Schema.optional(Schema.Boolean),
  first_id: Schema.optional(Schema.NullOr(Schema.String)),
  last_id: Schema.optional(Schema.NullOr(Schema.String)),
});

const RemoteSessionEventsPageSchema = Schema.Struct({
  data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  has_more: Schema.optional(Schema.Boolean),
  first_id: Schema.optional(Schema.NullOr(Schema.String)),
  last_id: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeSessionId = Schema.decodeUnknownOption(ClaudeCloudSessionId);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const GITHUB_REPO_PATTERN =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+\/[^/\s?#]+?)(?:\.git)?\/?$/i;

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

export const claudeKeychainServiceName = Effect.fn(
  "ClaudeCloudSessionsApi.claudeKeychainServiceName",
)(function* (configDir: string | undefined) {
  if (configDir === undefined) return "Claude Code-credentials";
  const digester = yield* Digest.Digest;
  const suffix = (yield* digester
    .digest(Digest.sha256, new TextEncoder().encode(configDir))
    .pipe(Effect.map(Hex.encode))).slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
});

interface ParsedCredentials {
  readonly accessToken: Redacted.Redacted<string>;
  readonly expiresAt: number | null;
}

const parseOAuthCredentials = (raw: string): ParsedCredentials | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let jsonText: string;
  if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else if (trimmed.length % 2 === 0 && HEX_PATTERN.test(trimmed)) {
    jsonText = Buffer.from(trimmed, "hex").toString("utf8").replace(/\0+$/g, "").trim();
  } else {
    return null;
  }
  const parsed = decodeOAuthCredentials(jsonText);
  if (Option.isNone(parsed)) return null;
  const accessToken = parsed.value.claudeAiOauth?.accessToken?.trim();
  if (!accessToken) return null;
  const expiresAt = parsed.value.claudeAiOauth?.expiresAt;
  return {
    accessToken: Redacted.make(accessToken),
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
  };
};

const nonEmpty = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractRepository = (raw: RemoteSessionApi): string | null => {
  for (const source of raw.session_context?.sources ?? []) {
    const url = nonEmpty(source.url);
    if (url === null) continue;
    const match = GITHUB_REPO_PATTERN.exec(url);
    if (match?.[1]) return match[1];
  }
  for (const outcome of raw.session_context?.outcomes ?? []) {
    const repo = nonEmpty(outcome.git_info?.repo);
    if (repo !== null) return repo;
  }
  return null;
};

const extractBranch = (
  raw: RemoteSessionApi,
  tracked: TrackedClaudeCloudSession | null,
): string | null => {
  const branches = raw.external_metadata?.current_branches;
  if (Array.isArray(branches)) {
    for (const entry of branches) {
      const value = nonEmpty(typeof entry === "string" ? entry : null);
      if (value !== null) return value;
    }
  } else if (branches !== null && typeof branches === "object") {
    for (const entry of Object.values(branches as Record<string, unknown>)) {
      const value = nonEmpty(typeof entry === "string" ? entry : null);
      if (value !== null) return value;
    }
  }
  for (const outcome of raw.session_context?.outcomes ?? []) {
    for (const branch of outcome.git_info?.branches ?? []) {
      const value = nonEmpty(branch);
      if (value !== null) return value;
    }
  }
  return tracked?.branch ?? null;
};

export function mapClaudeCloudSessionState(input: {
  readonly sessionStatus: string | null | undefined;
  readonly postTurnSummaryCategory: string | null | undefined;
  readonly transcriptActivity?: ClaudeCloudTranscriptActivity | null;
}): ClaudeCloudSessionState {
  if (input.sessionStatus === "archived") return "archived";
  // A permission prompt keeps the session "running" in the API while it waits on the user.
  if (input.transcriptActivity === "needs_input") return "needs_input";
  if (input.sessionStatus === "running" || input.sessionStatus === "pending") return "running";
  if (input.postTurnSummaryCategory === "need_input") return "needs_input";
  if (input.transcriptActivity !== undefined && input.transcriptActivity !== null) {
    return input.transcriptActivity;
  }
  return "idle";
}

const mapRemoteSession = (input: {
  readonly raw: RemoteSessionApi;
  readonly instanceId: ProviderInstanceId;
  readonly tracked: TrackedClaudeCloudSession | null;
  readonly transcriptActivity?: ClaudeCloudTranscriptActivity | null;
}): ClaudeCloudRemoteSession | null => {
  const validId = decodeSessionId(input.raw.id);
  if (Option.isNone(validId)) return null;
  const id = validId.value;
  const summaryObj =
    input.raw.post_turn_summary ?? input.raw.external_metadata?.post_turn_summary ?? null;
  const createdAt = nonEmpty(input.raw.created_at) ?? input.tracked?.createdAt ?? EPOCH_ISO;
  const updatedAt =
    nonEmpty(input.raw.updated_at) ??
    nonEmpty(input.raw.created_at) ??
    input.tracked?.lastMessageAt ??
    input.tracked?.createdAt ??
    createdAt;
  const usage = input.raw.external_metadata?.context_usage;
  const contextUsage =
    usage !== null &&
    usage !== undefined &&
    typeof usage.used_tokens === "number" &&
    Number.isFinite(usage.used_tokens) &&
    usage.used_tokens >= 0 &&
    typeof usage.max_tokens === "number" &&
    Number.isFinite(usage.max_tokens) &&
    usage.max_tokens >= 0
      ? {
          usedTokens: Math.floor(usage.used_tokens),
          maxTokens: Math.floor(usage.max_tokens),
        }
      : null;

  return {
    id,
    url: claudeCloudSessionUrl(id),
    title: nonEmpty(input.raw.title) ?? input.tracked?.title ?? "Cloud session",
    instanceId: input.instanceId,
    state: mapClaudeCloudSessionState({
      sessionStatus: input.raw.session_status,
      postTurnSummaryCategory: summaryObj?.status_category,
      ...(input.transcriptActivity === undefined
        ? {}
        : { transcriptActivity: input.transcriptActivity }),
    }),
    unread: input.raw.unread === true,
    origin: nonEmpty(input.raw.origin),
    repository: extractRepository(input.raw),
    branch: extractBranch(input.raw, input.tracked),
    model:
      nonEmpty(input.raw.configured_model) ??
      nonEmpty(input.raw.session_context?.model) ??
      nonEmpty(input.raw.external_metadata?.last_served_model),
    createdAt,
    updatedAt,
    summary: nonEmpty(summaryObj?.status_detail) ?? nonEmpty(summaryObj?.recent_action),
    needsAction: nonEmpty(summaryObj?.needs_action),
    contextUsage,
    tracked: input.tracked,
  };
};

const trackedFallbackSession = (tracked: TrackedClaudeCloudSession): ClaudeCloudRemoteSession => ({
  id: tracked.id,
  url: tracked.url,
  title: tracked.title,
  instanceId: tracked.instanceId,
  state: "idle",
  unread: false,
  origin: "cli",
  repository: null,
  branch: tracked.branch,
  model: null,
  createdAt: tracked.createdAt,
  updatedAt: tracked.lastMessageAt ?? tracked.createdAt,
  summary: tracked.lastReplyPreview,
  needsAction: null,
  contextUsage: null,
  tracked,
});

const eventUuid = (event: Readonly<Record<string, unknown>>): string | null =>
  nonEmpty(typeof event.uuid === "string" ? event.uuid : null);

// Events the transcript never shows; dropping them at ingest keeps cached sessions small.
const NOISE_EVENT_TYPES = new Set(["env_manager_log", "tool_progress", "rate_limit_event"]);
const NOISE_SYSTEM_SUBTYPES = new Set(["status", "hook_started", "hook_response"]);
const isTranscriptNoise = (event: Readonly<Record<string, unknown>>): boolean =>
  (typeof event.type === "string" && NOISE_EVENT_TYPES.has(event.type)) ||
  (event.type === "system" &&
    typeof event.subtype === "string" &&
    NOISE_SYSTEM_SUBTYPES.has(event.subtype));

const sortSessionsNewestFirst = (sessions: Array<ClaudeCloudRemoteSession>) =>
  sessions.sort((a, b) => {
    const aMs = Date.parse(a.updatedAt);
    const bMs = Date.parse(b.updatedAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
      return bMs - aMs;
    }
    const isoCmp = b.updatedAt.localeCompare(a.updatedAt);
    if (isoCmp !== 0) return isoCmp;
    return a.id.localeCompare(b.id);
  });

interface CachedCredentials extends ParsedCredentials {
  readonly organizationUuid: string | null;
}

interface TranscriptCacheEntry {
  readonly sessionId: string;
  readonly instanceId: ProviderInstanceId;
  readonly lastFetchedAt: number;
  readonly lastEventId: string | null;
  readonly rawEvents: ReadonlyArray<Record<string, unknown>>;
  readonly seenEventUuids: ReadonlySet<string>;
  readonly session: ClaudeCloudRemoteSession;
  readonly rev: number;
  readonly itemState: ReadonlyMap<string, { readonly json: string; readonly rev: number }>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly pendingRequest: ClaudeCloudPendingRequest | null;
  readonly activity: ClaudeCloudTranscriptActivity | null;
}

interface ClaudeCloudSessionsApiEventsPage {
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly lastId: string | null;
}

export interface ClaudeCloudSessionsApiOptions {
  readonly mapEvents?: typeof mapClaudeCloudEvents;
}

export class ClaudeCloudSessionsApi extends Context.Service<
  ClaudeCloudSessionsApi,
  {
    readonly listRemoteSessions: (options?: {
      readonly includeArchived?: boolean;
    }) => Effect.Effect<ClaudeCloudRemoteSessionsResponse, ClaudeCloudService.ClaudeCloudError>;
    readonly getSession: (input: {
      readonly sessionId: string;
      readonly instanceId?: ProviderInstanceId;
    }) => Effect.Effect<ClaudeCloudRemoteSession, ClaudeCloudService.ClaudeCloudError>;
    readonly listEventsAfter: (input: {
      readonly sessionId: string;
      readonly afterId?: string | null;
      readonly instanceId?: ProviderInstanceId;
    }) => Effect.Effect<ClaudeCloudSessionsApiEventsPage, ClaudeCloudService.ClaudeCloudError>;
    readonly getTranscript: (input: {
      readonly sessionId: string;
      readonly sinceRev?: number;
      readonly instanceId?: ProviderInstanceId;
    }) => Effect.Effect<ClaudeCloudTranscriptResponse, ClaudeCloudService.ClaudeCloudError>;
    readonly interruptSession: (
      input: ClaudeCloudInterruptRequest,
    ) => Effect.Effect<void, ClaudeCloudService.ClaudeCloudError>;
    readonly knownInstanceId: (sessionRef: string) => Effect.Effect<ProviderInstanceId | undefined>;
  }
>()("t3/cloud/ClaudeCloudSessionsApi") {}

export const make = Effect.fn("ClaudeCloudSessionsApi.make")(function* (
  options?: ClaudeCloudSessionsApiOptions,
) {
  const cloud = yield* ClaudeCloudService.ClaudeCloudService;
  const runner = yield* ClaudeCloudRunner.ClaudeCloudRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digester = yield* Digest.Digest;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const fsServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const mapEvents = options?.mapEvents ?? mapClaudeCloudEvents;

  const tokenCache = yield* Ref.make<ReadonlyMap<ProviderInstanceId, CachedCredentials>>(new Map());
  const knownInstances = yield* Ref.make<ReadonlyMap<string, ProviderInstanceId>>(new Map());
  const transcriptCache = yield* Ref.make<ReadonlyMap<string, TranscriptCacheEntry>>(new Map());
  const inFlightFetches = new Map<
    string,
    Deferred.Deferred<TranscriptCacheEntry, ClaudeCloudService.ClaudeCloudError>
  >();

  const rememberSessionInstance = (sessionId: string, instanceId: ProviderInstanceId) =>
    Ref.update(knownInstances, (current) => {
      if (current.get(sessionId) === instanceId) return current;
      const next = new Map(current);
      next.set(sessionId, instanceId);
      return next;
    });

  const touchTranscriptCache = (sessionId: string) =>
    Ref.modify(transcriptCache, (current) => {
      const entry = current.get(sessionId);
      if (entry === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(sessionId);
      next.set(sessionId, entry);
      return [entry, next] as const;
    });

  const putTranscriptCache = (entry: TranscriptCacheEntry) =>
    Ref.update(transcriptCache, (current) => {
      const next = new Map(current);
      next.delete(entry.sessionId);
      next.set(entry.sessionId, entry);
      while (next.size > TRANSCRIPT_CACHE_MAX_ENTRIES) {
        const oldestKey = next.keys().next().value;
        if (oldestKey === undefined) break;
        next.delete(oldestKey);
      }
      return next;
    });

  const readCredentials = Effect.fn("ClaudeCloudSessionsApi.readCredentials")(function* (
    account: ClaudeCloudService.ClaudeCloudAccountLaunch,
  ) {
    let raw: string;
    if (platform === "darwin") {
      const serviceName = yield* claudeKeychainServiceName(account.configDir).pipe(
        Effect.provideService(Digest.Digest, digester),
      );
      const result = yield* runner
        .exec({
          command: "security",
          args: ["find-generic-password", "-s", serviceName, "-w"],
          cwd: home,
          env: process.env,
          timeoutMs: KEYCHAIN_TIMEOUT_MS,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ClaudeCloudService.ClaudeCloudError({
                code: "api_unavailable",
                message: "Could not read Claude credentials from Keychain.",
              }),
          ),
        );
      if (result.timedOut || result.exitCode !== 0) {
        return yield* fail("api_unavailable", "Could not read Claude credentials from Keychain.");
      }
      raw = result.stdout;
    } else {
      const credentialsPath = path.join(account.resolvedHomePath, ".credentials.json");
      raw = yield* fileSystem.readFileString(credentialsPath).pipe(
        Effect.mapError(
          () =>
            new ClaudeCloudService.ClaudeCloudError({
              code: "api_unavailable",
              message: "Could not read Claude credentials file.",
            }),
        ),
      );
    }

    const parsed = parseOAuthCredentials(raw);
    if (parsed === null) {
      return yield* fail(
        "api_unavailable",
        "Claude credentials could not be parsed. Run `claude` once to sign in.",
      );
    }
    const accountConfigPath = yield* claudeAccountConfigPath(account.configDir).pipe(
      Effect.provide(fsServices),
    );
    const organizationUuid =
      (yield* readClaudeOrganizationId(accountConfigPath).pipe(Effect.provide(fsServices))) ?? null;
    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      organizationUuid,
    } satisfies CachedCredentials;
  });

  const evictToken = (instanceId: ProviderInstanceId) =>
    Ref.update(tokenCache, (current) => {
      if (!current.has(instanceId)) return current;
      const next = new Map(current);
      next.delete(instanceId);
      return next;
    });

  // Reads from memory until expired; on expiry or forceReload (401), re-reads once without ever refreshing or writing credentials.
  const resolveCredentials = Effect.fn("ClaudeCloudSessionsApi.resolveCredentials")(function* (
    account: ClaudeCloudService.ClaudeCloudAccountLaunch,
    forceReload: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (!forceReload) {
      const cached = (yield* Ref.get(tokenCache)).get(account.instanceId);
      if (cached !== undefined && (cached.expiresAt === null || cached.expiresAt > now)) {
        return cached;
      }
    }
    yield* evictToken(account.instanceId);
    const fresh = yield* readCredentials(account);
    const checkedAt = yield* Clock.currentTimeMillis;
    if (fresh.expiresAt !== null && fresh.expiresAt <= checkedAt) {
      return yield* fail("api_unavailable", CLAUDE_CLOUD_REFRESH_REQUIRED_DETAIL);
    }
    yield* Ref.update(tokenCache, (current) => new Map(current).set(account.instanceId, fresh));
    return fresh;
  });

  const executeGet = Effect.fn("ClaudeCloudSessionsApi.executeGet")(function* (
    creds: CachedCredentials,
    urlPath: string,
    urlParams?: Readonly<Record<string, string>>,
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${Redacted.value(creds.accessToken)}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_BETA,
      ...(creds.organizationUuid !== null ? { "x-organization-uuid": creds.organizationUuid } : {}),
    };
    const request = HttpClientRequest.get(
      `${API_BASE}${urlPath}`,
      urlParams === undefined ? undefined : { urlParams },
    ).pipe(HttpClientRequest.setHeaders(headers));

    return yield* httpClient.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.timeout(Duration.millis(HTTP_TIMEOUT_MS)),
      Effect.mapError(
        () =>
          new ClaudeCloudService.ClaudeCloudError({
            code: "api_unavailable",
            message: "Could not reach the Claude sessions API.",
          }),
      ),
    );
  });

  const apiGetJson = Effect.fn("ClaudeCloudSessionsApi.apiGetJson")(function* <
    S extends Schema.Top & { readonly DecodingServices: never },
  >(
    account: ClaudeCloudService.ClaudeCloudAccountLaunch,
    urlPath: string,
    schema: S,
    urlParams?: Readonly<Record<string, string>>,
  ) {
    const creds = yield* resolveCredentials(account, false);
    let response = yield* executeGet(creds, urlPath, urlParams);
    if (response.status === 401) {
      const reloaded = yield* resolveCredentials(account, true);
      response = yield* executeGet(reloaded, urlPath, urlParams);
      if (response.status === 401) {
        yield* evictToken(account.instanceId);
        return yield* fail("api_unavailable", CLAUDE_CLOUD_REFRESH_REQUIRED_DETAIL);
      }
    }
    if (response.status === 404) {
      return yield* fail("not_found", "Cloud session was not found.");
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* fail(
        "api_unavailable",
        `Claude sessions API returned HTTP ${response.status}.`,
      );
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.timeout(Duration.millis(HTTP_TIMEOUT_MS)),
      Effect.mapError(
        () =>
          new ClaudeCloudService.ClaudeCloudError({
            code: "api_unavailable",
            message: "Claude sessions API returned an unexpected response.",
          }),
      ),
    );
  });

  const requireValidSessionId = (ref: string) => {
    const id = parseClaudeCloudSessionRef(ref);
    return id === null
      ? fail("invalid_request", "Pass a cse_… or session_… id, or a claude.ai/code link.")
      : Effect.succeed(id);
  };

  const resolveAccountCandidates = Effect.fn("ClaudeCloudSessionsApi.resolveAccountCandidates")(
    function* (sessionId: string, requestedInstanceId?: ProviderInstanceId) {
      const accounts = yield* cloud.listClaudeAccounts();
      const known = (yield* Ref.get(knownInstances)).get(sessionId);
      const trackedList = yield* cloud.listSessions();
      const tracked = trackedList.find((entry) => entry.id === sessionId) ?? null;
      const targetId = requestedInstanceId ?? known ?? tracked?.instanceId;

      if (targetId !== undefined) {
        const account = accounts.find((entry) => entry.instanceId === targetId);
        if (account === undefined) {
          return yield* fail("invalid_request", `No Claude instance named "${targetId}".`);
        }
        if (!account.account.ready) {
          return yield* fail(
            "account_not_ready",
            `${account.displayName} can't read cloud sessions: ${account.account.detail ?? account.account.problem ?? "not ready"}`,
          );
        }
        return {
          candidates: [account] as ReadonlyArray<ClaudeCloudService.ClaudeCloudAccountLaunch>,
          tracked,
        };
      }

      const ready = accounts.filter((entry) => entry.account.ready);
      if (ready.length === 0) {
        return yield* fail("account_not_ready", "No Claude instance has a ready claude.ai login.");
      }
      return { candidates: ready, tracked };
    },
  );

  const fetchRawSession = Effect.fn("ClaudeCloudSessionsApi.fetchRawSession")(function* (
    account: ClaudeCloudService.ClaudeCloudAccountLaunch,
    sessionId: string,
  ) {
    return yield* apiGetJson(
      account,
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      RemoteSessionApiSchema,
    );
  });

  const fetchEventsAfterForAccount = Effect.fn("ClaudeCloudSessionsApi.fetchEventsAfterForAccount")(
    function* (
      account: ClaudeCloudService.ClaudeCloudAccountLaunch,
      sessionId: string,
      afterId: string | null,
    ) {
      const events: Array<Record<string, unknown>> = [];
      let cursor = afterId;
      let pages = 0;

      while (pages < MAX_EVENT_PAGES) {
        pages += 1;
        const prevCursor = cursor;
        const page = yield* apiGetJson(
          account,
          `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
          RemoteSessionEventsPageSchema,
          {
            limit: String(EVENTS_PAGE_LIMIT),
            ...(cursor !== null ? { after_id: cursor } : {}),
          },
        );
        for (const item of page.data) {
          events.push(item);
        }
        const lastEvent = page.data.at(-1);
        const nextCursor = nonEmpty(page.last_id) ?? (lastEvent ? eventUuid(lastEvent) : null);
        if (nextCursor !== null) {
          cursor = nextCursor;
        }
        if (
          page.has_more !== true ||
          page.data.length === 0 ||
          nextCursor === null ||
          nextCursor === prevCursor
        ) {
          break;
        }
      }

      return { events, lastId: cursor } satisfies ClaudeCloudSessionsApiEventsPage;
    },
  );

  const listRemoteSessions = Effect.fn("ClaudeCloudSessionsApi.listRemoteSessions")(
    function* (input?: { readonly includeArchived?: boolean }) {
      const includeArchived = input?.includeArchived === true;
      const accounts = yield* cloud.listClaudeAccounts();
      const trackedList = yield* cloud.listSessions();
      const trackedById = new Map<string, TrackedClaudeCloudSession>(
        trackedList.map((session) => [session.id, session]),
      );

      const readyAccounts = accounts.filter((entry) => entry.account.ready);
      const perAccountResults = yield* Effect.forEach(
        readyAccounts,
        (account) =>
          apiGetJson(account, "/v1/sessions", RemoteSessionsListResponseSchema, {
            limit: String(SESSIONS_LIST_LIMIT),
          }).pipe(
            Effect.map((response) => ({ ok: true as const, account, response })),
            Effect.catchTags({
              ClaudeCloudError: (error) => Effect.succeed({ ok: false as const, account, error }),
            }),
          ),
        { concurrency: "unbounded" },
      );

      const problems: Array<ClaudeCloudAccountProblemNote> = [];
      const mergedById = new Map<string, ClaudeCloudRemoteSession>();
      const seenRemoteIds = new Set<string>();

      for (const result of perAccountResults) {
        if (!result.ok) {
          problems.push({
            instanceId: result.account.instanceId,
            detail: result.error.message,
          });
          continue;
        }
        for (const raw of result.response.data) {
          if (raw.environment_kind === "bridge") continue;
          const mapped = mapRemoteSession({
            raw,
            instanceId: result.account.instanceId,
            tracked: trackedById.get(raw.id) ?? null,
          });
          if (mapped === null) continue;
          seenRemoteIds.add(mapped.id);
          yield* rememberSessionInstance(mapped.id, result.account.instanceId);
          if (!includeArchived && mapped.state === "archived") continue;
          if (!mergedById.has(mapped.id)) {
            mergedById.set(mapped.id, mapped);
          }
        }
      }

      for (const tracked of trackedList) {
        if (seenRemoteIds.has(tracked.id) || mergedById.has(tracked.id)) continue;
        mergedById.set(tracked.id, trackedFallbackSession(tracked));
      }

      const sessions = sortSessionsNewestFirst([...mergedById.values()]);
      return { sessions, problems } satisfies ClaudeCloudRemoteSessionsResponse;
    },
  );

  const resolveSessionWithRaw = Effect.fn("ClaudeCloudSessionsApi.resolveSessionWithRaw")(
    function* (sessionId: string, requestedInstanceId?: ProviderInstanceId) {
      const { candidates, tracked } = yield* resolveAccountCandidates(
        sessionId,
        requestedInstanceId,
      );
      let lastNotFound: ClaudeCloudService.ClaudeCloudError | null = null;
      for (const account of candidates) {
        const outcome = yield* fetchRawSession(account, sessionId).pipe(Effect.result);
        if (outcome._tag === "Success") {
          yield* rememberSessionInstance(sessionId, account.instanceId);
          return { account, raw: outcome.success, tracked };
        }
        if (outcome.failure.code === "not_found" && candidates.length > 1) {
          lastNotFound = outcome.failure;
          continue;
        }
        return yield* outcome.failure;
      }
      return yield* (
        lastNotFound ??
        new ClaudeCloudService.ClaudeCloudError({
          code: "not_found",
          message: "Cloud session was not found.",
        })
      );
    },
  );

  const getSession = Effect.fn("ClaudeCloudSessionsApi.getSession")(function* (input: {
    readonly sessionId: string;
    readonly instanceId?: ProviderInstanceId;
  }) {
    const id = yield* requireValidSessionId(input.sessionId);
    const { account, raw, tracked } = yield* resolveSessionWithRaw(id, input.instanceId);
    const mapped = mapRemoteSession({ raw, instanceId: account.instanceId, tracked });
    if (mapped === null) {
      return yield* fail("api_unavailable", "Claude sessions API returned an invalid session id.");
    }
    return mapped;
  });

  const listEventsAfter = Effect.fn("ClaudeCloudSessionsApi.listEventsAfter")(function* (input: {
    readonly sessionId: string;
    readonly afterId?: string | null;
    readonly instanceId?: ProviderInstanceId;
  }) {
    const id = yield* requireValidSessionId(input.sessionId);
    const { candidates } = yield* resolveAccountCandidates(id, input.instanceId);
    let lastNotFound: ClaudeCloudService.ClaudeCloudError | null = null;
    for (const account of candidates) {
      const outcome = yield* fetchEventsAfterForAccount(account, id, input.afterId ?? null).pipe(
        Effect.result,
      );
      if (outcome._tag === "Success") {
        yield* rememberSessionInstance(id, account.instanceId);
        return outcome.success;
      }
      if (outcome.failure.code === "not_found" && candidates.length > 1) {
        lastNotFound = outcome.failure;
        continue;
      }
      return yield* outcome.failure;
    }
    return yield* (
      lastNotFound ??
      new ClaudeCloudService.ClaudeCloudError({
        code: "not_found",
        message: "Cloud session was not found.",
      })
    );
  });

  const buildTranscriptResponse = (
    entry: TranscriptCacheEntry,
    sinceRev: number | undefined,
  ): ClaudeCloudTranscriptResponse => {
    const isFull =
      sinceRev === undefined || !Number.isInteger(sinceRev) || sinceRev < 0 || sinceRev > entry.rev;
    const turnItems = isFull
      ? [...entry.turnItems]
      : entry.turnItems.filter((item) => (entry.itemState.get(item.id)?.rev ?? 0) > sinceRev);
    return {
      session: entry.session,
      rev: entry.rev,
      full: isFull,
      turnItems,
      pendingRequest: entry.pendingRequest,
      canInterrupt: false,
    };
  };

  const refreshTranscriptEntry = Effect.fn("ClaudeCloudSessionsApi.refreshTranscriptEntry")(
    function* (
      id: string,
      existing: TranscriptCacheEntry | undefined,
      requestedInstanceId?: ProviderInstanceId,
    ) {
      const effectiveInstanceId = requestedInstanceId ?? existing?.instanceId;
      const { candidates, tracked } = yield* resolveAccountCandidates(id, effectiveInstanceId);

      let account: ClaudeCloudService.ClaudeCloudAccountLaunch;
      let rawSession: RemoteSessionApi;
      let delta: ClaudeCloudSessionsApiEventsPage;

      if (candidates.length === 1) {
        account = candidates[0]!;
        [rawSession, delta] = yield* Effect.all(
          [
            fetchRawSession(account, id),
            fetchEventsAfterForAccount(account, id, existing?.lastEventId ?? null),
          ],
          { concurrency: "unbounded" },
        );
        yield* rememberSessionInstance(id, account.instanceId);
      } else {
        const resolved = yield* resolveSessionWithRaw(id, effectiveInstanceId);
        account = resolved.account;
        rawSession = resolved.raw;
        delta = yield* fetchEventsAfterForAccount(account, id, existing?.lastEventId ?? null);
      }

      const seenEventUuids = new Set(existing?.seenEventUuids ?? []);
      const rawEvents = [...(existing?.rawEvents ?? [])];
      let added = 0;
      for (const event of delta.events) {
        const uuid = eventUuid(event);
        if (uuid !== null) {
          if (seenEventUuids.has(uuid)) continue;
          seenEventUuids.add(uuid);
        }
        if (isTranscriptNoise(event)) continue;
        rawEvents.push(event);
        added += 1;
      }

      const mappedTranscript =
        existing !== undefined && added === 0
          ? {
              turnItems: existing.turnItems,
              pendingRequest: existing.pendingRequest,
              activity: existing.activity,
            }
          : mapEvents({ sessionId: id, events: rawEvents });
      const prevItemState = existing?.itemState ?? new Map();
      let nextRev = existing?.rev ?? 0;
      const nextItemState = new Map<string, { readonly json: string; readonly rev: number }>();

      for (const item of mappedTranscript.turnItems) {
        const serialized = encodeUnknownJson(item);
        const prev = prevItemState.get(item.id);
        if (prev !== undefined && prev.json === serialized) {
          nextItemState.set(item.id, prev);
        } else {
          nextRev += 1;
          nextItemState.set(item.id, { json: serialized, rev: nextRev });
        }
      }

      const session = mapRemoteSession({
        raw: rawSession,
        instanceId: account.instanceId,
        tracked,
        transcriptActivity: mappedTranscript.activity,
      });
      if (session === null) {
        return yield* fail(
          "api_unavailable",
          "Claude sessions API returned an invalid session id.",
        );
      }

      const entry: TranscriptCacheEntry = {
        sessionId: id,
        instanceId: account.instanceId,
        lastFetchedAt: yield* Clock.currentTimeMillis,
        lastEventId: delta.lastId ?? existing?.lastEventId ?? null,
        rawEvents,
        seenEventUuids,
        session,
        rev: nextRev,
        itemState: nextItemState,
        turnItems: mappedTranscript.turnItems,
        pendingRequest: mappedTranscript.pendingRequest,
        activity: mappedTranscript.activity,
      };
      yield* putTranscriptCache(entry);
      return entry;
    },
  );

  const getTranscript = Effect.fn("ClaudeCloudSessionsApi.getTranscript")(function* (input: {
    readonly sessionId: string;
    readonly sinceRev?: number;
    readonly instanceId?: ProviderInstanceId;
  }) {
    const id = yield* requireValidSessionId(input.sessionId);
    const existing = yield* touchTranscriptCache(id);
    const now = yield* Clock.currentTimeMillis;

    if (
      existing !== undefined &&
      (input.instanceId === undefined || input.instanceId === existing.instanceId) &&
      now - existing.lastFetchedAt < TRANSCRIPT_FETCH_MIN_INTERVAL_MS
    ) {
      return buildTranscriptResponse(existing, input.sinceRev);
    }

    const active = inFlightFetches.get(id);
    if (active !== undefined) {
      const entry = yield* Deferred.await(active);
      return buildTranscriptResponse(entry, input.sinceRev);
    }

    const deferred = yield* Deferred.make<
      TranscriptCacheEntry,
      ClaudeCloudService.ClaudeCloudError
    >();
    inFlightFetches.set(id, deferred);

    const entry = yield* refreshTranscriptEntry(id, existing, input.instanceId).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (inFlightFetches.get(id) === deferred) {
            inFlightFetches.delete(id);
          }
          yield* Deferred.done(deferred, exit);
        }),
      ),
    );
    return buildTranscriptResponse(entry, input.sinceRev);
  });

  const interruptSession = Effect.fn("ClaudeCloudSessionsApi.interruptSession")(function* (
    input: ClaudeCloudInterruptRequest,
  ) {
    yield* cloud.listClaudeAccounts();
    yield* requireValidSessionId(input.sessionId);
    return yield* fail("interrupt_unsupported", INTERRUPT_UNSUPPORTED_DETAIL);
  });

  const knownInstanceId = Effect.fn("ClaudeCloudSessionsApi.knownInstanceId")(function* (
    sessionRef: string,
  ) {
    const id = parseClaudeCloudSessionRef(sessionRef) ?? sessionRef.trim();
    return (yield* Ref.get(knownInstances)).get(id);
  });

  return ClaudeCloudSessionsApi.of({
    listRemoteSessions,
    getSession,
    listEventsAfter,
    getTranscript,
    interruptSession,
    knownInstanceId,
  });
});

export const layer = Layer.effect(ClaudeCloudSessionsApi, make());
