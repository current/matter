import {
  type AddonRuntimeStatus,
  CLAUDE_CLOUD_ADDON_ID,
  type ClaudeCloudAccountStatus,
  type ClaudeCloudAddonSettings,
  type ClaudeCloudBlocker,
  type ClaudeCloudEligibility,
  type ClaudeCloudErrorCode,
  type ClaudeCloudFollowUpResult,
  type ClaudeCloudLaunchRequest,
  type ClaudeCloudLaunchResult,
  type ClaudeCloudRepositoryState,
  type ClaudeCloudSettingsPatch,
  type ClaudeCloudStatus,
  type ClaudeCloudTeleportResult,
  ClaudeSettings,
  CommandId,
  GitRefName,
  type ProjectId,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  ThreadId,
  TrackedClaudeCloudSession,
  claudeCloudAgentInstructions,
  claudeCloudSessionUrl,
  claudeCloudSettingsFromConfig,
  parseClaudeCloudSessionRef,
} from "@t3tools/contracts";
import { setAddonRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as AddonConfigService from "../bots/AddonConfigService.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
} from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeCloudRunner from "./ClaudeCloudRunner.ts";

export const CLAUDE_CLOUD_SESSIONS_FILENAME = "claude-cloud-sessions.json";

const MAX_TRACKED_SESSIONS = 200;
const AUTH_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const LAUNCH_TIMEOUT_MS = 120_000;
const FOLLOW_UP_TIMEOUT_MS = 10 * 60_000;
const TELEPORT_TIMEOUT_MS = 10 * 60_000;
const ACCOUNT_STATUS_TTL_MS = 5 * 60_000;
const PREVIEW_LENGTH = 500;
const DEFAULT_TELEPORT_PROMPT =
  "Summarize in a few lines where this session left off and what remains to do.";

// Cloud sessions authenticate with the claude.ai login only; API-key auth fails them outright.
const STRIPPED_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

const SESSION_URL_IN_OUTPUT = /https:\/\/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9_-]{4,200})/;
const SESSION_ID_IN_OUTPUT = /\b((?:cse|session)_[A-Za-z0-9]{8,200})\b/;
const TRUST_PROMPT = /trust (?:this|the files in this) folder/i;

export class ClaudeCloudError extends Schema.TaggedError<ClaudeCloudError>()("ClaudeCloudError", {
  code: Schema.String,
  message: Schema.String,
}) {}

const fail = (code: ClaudeCloudErrorCode, message: string) =>
  Effect.fail(new ClaudeCloudError({ code, message }));

const DISABLED_MESSAGE =
  "The claude-cloud add-on is disabled. The user can turn it on in Settings → Add-ons.";

const StoredSessionsFile = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Array(TrackedClaudeCloudSession),
});
type StoredSessionsFile = typeof StoredSessionsFile.Type;
const StoredSessionsJson = fromJsonStringPretty(StoredSessionsFile);
const decodeStoredSessions = Schema.decodeUnknownEffect(StoredSessionsJson);
const encodeStoredSessions = Schema.encodeEffect(StoredSessionsJson);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

const AuthStatusJson = Schema.fromJsonString(
  Schema.Struct({
    loggedIn: Schema.optionalKey(Schema.Boolean),
    authMethod: Schema.optionalKey(Schema.String),
    apiProvider: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.String),
    planTier: Schema.optionalKey(Schema.String),
    subscriptionType: Schema.optionalKey(Schema.String),
  }),
);
const decodeAuthStatus = Schema.decodeUnknownOption(AuthStatusJson);

const CliJsonResult = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.optionalKey(Schema.Boolean),
    is_error: Schema.optionalKey(Schema.Boolean),
    session_id: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
    errors: Schema.optionalKey(Schema.Array(Schema.String)),
    result: Schema.optionalKey(Schema.String),
    reply: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
  }),
);
const decodeCliJson = Schema.decodeUnknownOption(CliJsonResult);

/** The last JSON object a CLI printed, which may follow log lines. */
const parseCliJson = (stdout: string) => {
  const trimmed = stdout.trim();
  const whole = decodeCliJson(trimmed);
  if (Option.isSome(whole)) return whole;
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    const parsed = decodeCliJson(line.trim());
    if (Option.isSome(parsed)) return parsed;
  }
  return Option.none();
};

const preview = (text: string) =>
  text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;

const tail = (text: string) => preview(text.trim().slice(-PREVIEW_LENGTH));

const defaultTitle = (prompt: string) => {
  const firstLine = prompt.trim().split("\n", 1)[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine || "Matter task";
};

/** Finds the new session in what `claude --cloud` printed, preferring its claude.ai link. */
export const findLaunchedSessionId = (output: string): string | null =>
  SESSION_URL_IN_OUTPUT.exec(output)?.[1] ?? SESSION_ID_IN_OUTPUT.exec(output)?.[1] ?? null;

const isGithubRemote = (url: string) =>
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(
    url.trim(),
  );

export interface ClaudeCloudLaunchInput extends ClaudeCloudLaunchRequest {
  readonly createdBy: "user" | "agent";
  /** Where to launch from; defaults to the project's root. An agent's thread passes its worktree. */
  readonly cwd?: string;
  readonly sourceThreadId?: ThreadId;
  /** An agent in Ask-first mode passes this only after the user agreed. */
  readonly userApproved?: boolean;
  /** An agent's reason, required while the user has delegation rules. */
  readonly reason?: string;
}

interface ClaudeInstance {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly config: ProviderInstanceConfig;
}

export class ClaudeCloudService extends Context.Service<
  ClaudeCloudService,
  {
    /** Whether agents should see the claude_cloud_* tools right now. */
    readonly agentToolsListed: Effect.Effect<boolean>;
    readonly addonStatus: Effect.Effect<AddonRuntimeStatus>;
    readonly getStatus: (options?: {
      readonly refresh?: boolean;
      readonly projectId?: ProjectId;
    }) => Effect.Effect<ClaudeCloudStatus, ClaudeCloudError>;
    readonly updateSettings: (
      patch: ClaudeCloudSettingsPatch,
    ) => Effect.Effect<ClaudeCloudAddonSettings, ClaudeCloudError>;
    readonly checkEligibility: (input: {
      readonly instanceId?: ProviderInstanceId;
      readonly projectId?: ProjectId;
      readonly cwd?: string;
    }) => Effect.Effect<ClaudeCloudEligibility, ClaudeCloudError>;
    readonly launchSession: (
      input: ClaudeCloudLaunchInput,
    ) => Effect.Effect<ClaudeCloudLaunchResult, ClaudeCloudError>;
    readonly sendFollowUp: (input: {
      readonly sessionId: string;
      readonly prompt: string;
      readonly instanceId?: ProviderInstanceId;
    }) => Effect.Effect<ClaudeCloudFollowUpResult, ClaudeCloudError>;
    readonly teleportToWorktree: (input: {
      readonly sessionId: string;
      readonly projectId: ProjectId;
      readonly instanceId?: ProviderInstanceId;
      readonly prompt?: string;
    }) => Effect.Effect<ClaudeCloudTeleportResult, ClaudeCloudError>;
    readonly listSessions: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<TrackedClaudeCloudSession>, ClaudeCloudError>;
    readonly forgetSession: (sessionId: string) => Effect.Effect<boolean, ClaudeCloudError>;
  }
>()("t3/cloud/ClaudeCloudService") {}

export const make = Effect.gen(function* () {
  const addons = yield* AddonConfigService.AddonConfigService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ClaudeCloudRunner.ClaudeCloudRunner;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const home = yield* HostProcess.HomeDirectory;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const sessionsPath = path.join(serverConfig.stateDir, CLAUDE_CLOUD_SESSIONS_FILENAME);

  const writeLock = yield* Semaphore.make(1);
  const sessionsCache = yield* Ref.make<ReadonlyArray<TrackedClaudeCloudSession> | null>(null);
  const accountCache = yield* Ref.make<
    ReadonlyMap<string, { readonly status: ClaudeCloudAccountStatus; readonly at: number }>
  >(new Map());

  // Read synchronously when a provider session starts, so it is kept current here.
  let snapshot: { enabled: boolean; settings: ClaudeCloudAddonSettings } = {
    enabled: false,
    settings: claudeCloudSettingsFromConfig({}),
  };
  const readSettings = addons.getConfig(CLAUDE_CLOUD_ADDON_ID).pipe(
    Effect.map(claudeCloudSettingsFromConfig),
    Effect.orElseSucceed(() => claudeCloudSettingsFromConfig({})),
  );
  const refreshSnapshot = Effect.gen(function* () {
    snapshot = {
      enabled: yield* addons.isEnabled(CLAUDE_CLOUD_ADDON_ID),
      settings: yield* readSettings,
    };
  });
  yield* refreshSnapshot;
  yield* Stream.merge(
    addons.changes.pipe(Stream.map((change) => change.id)),
    addons.configChanges,
  ).pipe(
    Stream.filter((id) => id === CLAUDE_CLOUD_ADDON_ID),
    Stream.runForEach(() => refreshSnapshot),
    Effect.forkScoped,
  );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      setAddonRuntimeInstructions(CLAUDE_CLOUD_ADDON_ID, () =>
        snapshot.enabled ? claudeCloudAgentInstructions(snapshot.settings) : "",
      ),
    ),
    () => Effect.sync(() => setAddonRuntimeInstructions(CLAUDE_CLOUD_ADDON_ID, null)),
  );

  const requireEnabled = Effect.gen(function* () {
    if (!(yield* addons.isEnabled(CLAUDE_CLOUD_ADDON_ID))) {
      return yield* fail("addon_disabled", DISABLED_MESSAGE);
    }
    return yield* readSettings;
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const loadSessions = Effect.gen(function* () {
    const cached = yield* Ref.get(sessionsCache);
    if (cached) return cached;
    const raw = yield* fileSystem
      .readFileString(sessionsPath)
      .pipe(Effect.orElseSucceed(() => null));
    const sessions =
      raw === null
        ? []
        : yield* decodeStoredSessions(raw).pipe(
            Effect.map((file) => file.sessions),
            Effect.tapError((error) =>
              Effect.logWarning(
                `${CLAUDE_CLOUD_SESSIONS_FILENAME} is unreadable; starting empty.`,
                error,
              ),
            ),
            Effect.orElseSucceed(() => []),
          );
    yield* Ref.set(sessionsCache, sessions);
    return sessions;
  });

  const persistSessions = Effect.fn("ClaudeCloudService.persistSessions")(function* (
    sessions: ReadonlyArray<TrackedClaudeCloudSession>,
  ) {
    const next: StoredSessionsFile = {
      version: 1,
      sessions: sessions.slice(0, MAX_TRACKED_SESSIONS),
    };
    const encoded = yield* encodeStoredSessions(next).pipe(
      Effect.mapError(
        (error) => new ClaudeCloudError({ code: "cli_failed", message: String(error) }),
      ),
    );
    yield* fileSystem
      .makeDirectory(serverConfig.stateDir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* fileSystem.writeFileString(sessionsPath, `${encoded}\n`, { mode: 0o600 }).pipe(
      Effect.mapError(
        (error) =>
          new ClaudeCloudError({
            code: "cli_failed",
            message: `Could not save ${CLAUDE_CLOUD_SESSIONS_FILENAME}: ${error.message}`,
          }),
      ),
    );
    yield* fileSystem.chmod(sessionsPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
    yield* Ref.set(sessionsCache, next.sessions);
  });

  const updateSessions = (
    update: (
      sessions: ReadonlyArray<TrackedClaudeCloudSession>,
    ) => ReadonlyArray<TrackedClaudeCloudSession>,
  ) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const next = update(yield* loadSessions);
        yield* persistSessions(next);
        return next;
      }),
    );

  const patchSession = (id: string, patch: Partial<TrackedClaudeCloudSession>) =>
    updateSessions((sessions) =>
      sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)),
    );

  const claudeInstances = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (error) => new ClaudeCloudError({ code: "cli_failed", message: String(error) }),
      ),
    );
    return Object.entries(deriveProviderInstanceConfigMap(settings))
      .filter(([, instance]) => instance.driver === "claudeAgent")
      .map(([instanceId, config]): ClaudeInstance => ({
        instanceId: ProviderInstanceId.make(instanceId),
        displayName: config.displayName ?? instanceId,
        config,
      }));
  });

  const instanceLaunch = Effect.fn("ClaudeCloudService.instanceLaunch")(function* (
    instance: ClaudeInstance,
  ) {
    const claudeConfig = Option.getOrElse(decodeClaudeSettings(instance.config.config ?? {}), () =>
      Option.getOrThrow(decodeClaudeSettings({})),
    );
    const processEnv = yield* mergeClaudeProcessEnvironment(
      claudeConfig,
      instance.config.environment,
      process.env,
    );
    const env: NodeJS.ProcessEnv = { ...(yield* makeClaudeEnvironment(claudeConfig, processEnv)) };
    for (const key of STRIPPED_ENV_KEYS) delete env[key];
    const binary = claudeConfig.binaryPath.trim();
    return { command: binary.length > 0 ? binary : "claude", env };
  }, Effect.provide(services));

  const probeAccount = Effect.fn("ClaudeCloudService.probeAccount")(function* (
    instance: ClaudeInstance,
  ) {
    const launch = yield* instanceLaunch(instance);
    const checkedAt = yield* nowIso;
    const base = {
      instanceId: instance.instanceId,
      displayName: instance.displayName,
      checkedAt,
    };
    const result = yield* runner
      .exec({
        command: launch.command,
        args: ["auth", "status", "--json"],
        cwd: home,
        env: launch.env,
        timeoutMs: AUTH_TIMEOUT_MS,
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return {
        ...base,
        ready: false,
        problem: "cli_unavailable",
        detail: result.failure.message,
      } satisfies ClaudeCloudAccountStatus;
    }
    const auth = decodeAuthStatus(result.success.stdout.trim());
    if (Option.isNone(auth)) {
      return {
        ...base,
        ready: false,
        problem: "error",
        detail: tail(result.success.stderr || result.success.stdout) || "No auth status.",
      } satisfies ClaudeCloudAccountStatus;
    }
    const { loggedIn, authMethod, apiProvider, email, planTier, subscriptionType } = auth.value;
    const identity = {
      ...(email === undefined ? {} : { email }),
      ...((planTier ?? subscriptionType) ? { planTier: planTier ?? subscriptionType } : {}),
    };
    if (loggedIn !== true) {
      return {
        ...base,
        ready: false,
        problem: "signed_out",
        detail: "Sign in with `claude auth login` using this instance's config folder.",
      } satisfies ClaudeCloudAccountStatus;
    }
    if (authMethod !== "claude.ai" || (apiProvider !== undefined && apiProvider !== "firstParty")) {
      return {
        ...base,
        ...identity,
        ready: false,
        problem: /api.?key/i.test(authMethod ?? "") ? "api_key_auth" : "not_claude_ai",
        detail:
          "Cloud sessions need a claude.ai subscription login, not API, Bedrock or Vertex auth.",
      } satisfies ClaudeCloudAccountStatus;
    }
    return { ...base, ...identity, ready: true } satisfies ClaudeCloudAccountStatus;
  });

  const accountStatus = Effect.fn("ClaudeCloudService.accountStatus")(function* (
    instance: ClaudeInstance,
    refresh: boolean,
  ) {
    const cached = (yield* Ref.get(accountCache)).get(instance.instanceId);
    const now = yield* Clock.currentTimeMillis;
    if (!refresh && cached !== undefined && now - cached.at < ACCOUNT_STATUS_TTL_MS) {
      return cached.status;
    }
    const status = yield* probeAccount(instance);
    const at = yield* Clock.currentTimeMillis;
    yield* Ref.update(accountCache, (map) => new Map(map).set(instance.instanceId, { status, at }));
    return status;
  });

  const resolveInstance = Effect.fn("ClaudeCloudService.resolveInstance")(function* (
    requested: ProviderInstanceId | undefined,
    settings: ClaudeCloudAddonSettings,
  ) {
    const instances = yield* claudeInstances;
    const wanted = requested ?? settings.defaultInstanceId;
    if (wanted !== null && wanted !== undefined) {
      const instance = instances.find((entry) => entry.instanceId === wanted);
      if (instance === undefined) {
        return yield* fail("invalid_request", `No Claude instance named "${wanted}".`);
      }
      return { instance, account: yield* accountStatus(instance, false) };
    }
    for (const instance of instances) {
      const account = yield* accountStatus(instance, false);
      if (account.ready) return { instance, account };
    }
    const first = instances[0];
    if (first === undefined)
      return yield* fail("account_not_ready", "No Claude instance is set up.");
    return { instance: first, account: yield* accountStatus(first, false) };
  });

  const requireReadyAccount = (account: ClaudeCloudAccountStatus) =>
    account.ready
      ? Effect.void
      : fail(
          "account_not_ready",
          `${account.displayName} can't run cloud sessions: ${account.detail ?? account.problem ?? "not ready"}`,
        );

  const gitOut = (cwd: string, args: ReadonlyArray<string>, timeoutMs = GIT_TIMEOUT_MS) =>
    runner.exec({ command: "git", args, cwd, env: process.env, timeoutMs }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
      Effect.orElseSucceed(() => null),
    );

  const repositoryState = Effect.fn("ClaudeCloudService.repositoryState")(function* (cwd: string) {
    const [remote, branch, upstream, porcelain] = yield* Effect.all(
      [
        gitOut(cwd, ["remote", "get-url", "origin"]),
        gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
        gitOut(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
        gitOut(cwd, ["status", "--porcelain"]),
      ],
      { concurrency: "unbounded" },
    );
    const hasUpstream = upstream !== null && upstream !== "";
    const ahead = yield* gitOut(
      cwd,
      hasUpstream
        ? ["rev-list", "--count", "@{u}..HEAD"]
        : ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
    );
    return {
      cwd,
      githubRemote: remote !== null && isGithubRemote(remote) ? remote : null,
      branch: branch === null || branch === "HEAD" ? null : branch,
      hasUpstream,
      aheadCount: Number(ahead ?? 0) || 0,
      dirty: porcelain !== null && porcelain.length > 0,
    } satisfies ClaudeCloudRepositoryState;
  });

  const blockersFor = (repository: ClaudeCloudRepositoryState | null) => {
    const blockers: Array<ClaudeCloudBlocker> = [];
    if (repository === null) return ["no_project"] satisfies Array<ClaudeCloudBlocker>;
    if (repository.githubRemote === null) blockers.push("no_github_remote");
    if (repository.branch === null) blockers.push("detached_head");
    else if (!repository.hasUpstream || repository.aheadCount > 0)
      blockers.push("unpushed_commits");
    return blockers;
  };

  const warningsFor = (repository: ClaudeCloudRepositoryState | null) =>
    repository?.dirty === true
      ? ["Uncommitted changes stay on this Mac; the cloud session starts from the pushed branch."]
      : [];

  const projectRoot = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(
        (error) => new ClaudeCloudError({ code: "project_not_found", message: String(error) }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => fail("project_not_found", `Project "${projectId}" was not found.`),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  const resolveCwd = (input: { readonly projectId?: ProjectId; readonly cwd?: string }) =>
    input.cwd !== undefined
      ? Effect.succeed<string | null>(input.cwd)
      : input.projectId !== undefined
        ? projectRoot(input.projectId)
        : Effect.succeed<string | null>(null);

  const getStatus = Effect.fn("ClaudeCloudService.getStatus")(function* (options?: {
    readonly refresh?: boolean;
    readonly projectId?: ProjectId;
  }) {
    const enabled = yield* addons.isEnabled(CLAUDE_CLOUD_ADDON_ID);
    const settings = yield* readSettings;
    if (!enabled) {
      return {
        enabled,
        settings,
        instances: [],
        accounts: [],
        sessions: [],
      } satisfies ClaudeCloudStatus;
    }
    const instances = yield* claudeInstances;
    const accounts =
      options?.refresh === true
        ? yield* Effect.forEach(instances, (instance) => accountStatus(instance, true), {
            concurrency: "unbounded",
          })
        : [...(yield* Ref.get(accountCache)).values()].map((entry) => entry.status);
    const sessions = yield* listSessions(options?.projectId);
    return {
      enabled,
      settings,
      instances: instances.map(({ instanceId, displayName }) => ({ instanceId, displayName })),
      accounts,
      sessions,
    } satisfies ClaudeCloudStatus;
  });

  const updateSettings = Effect.fn("ClaudeCloudService.updateSettings")(function* (
    patch: ClaudeCloudSettingsPatch,
  ) {
    yield* requireEnabled;
    const config = yield* addons
      .updateConfig(CLAUDE_CLOUD_ADDON_ID, {
        ...(patch.defaultInstanceId === undefined
          ? {}
          : { defaultInstanceId: patch.defaultInstanceId }),
        ...(patch.agentDelegationMode === undefined
          ? {}
          : { agentDelegationMode: patch.agentDelegationMode }),
        ...(patch.delegationRules === undefined ? {} : { delegationRules: patch.delegationRules }),
        ...(patch.autoPushBeforeLaunch === undefined
          ? {}
          : { autoPushBeforeLaunch: patch.autoPushBeforeLaunch }),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new ClaudeCloudError({
              code: "invalid_request",
              message: error.detail ?? error.reason,
            }),
        ),
      );
    return claudeCloudSettingsFromConfig(config);
  });

  const checkEligibility = Effect.fn("ClaudeCloudService.checkEligibility")(function* (input: {
    readonly instanceId?: ProviderInstanceId;
    readonly projectId?: ProjectId;
    readonly cwd?: string;
  }) {
    const settings = yield* requireEnabled;
    const { account } = yield* resolveInstance(input.instanceId, settings);
    const cwd = yield* resolveCwd(input);
    const repository = cwd === null ? null : yield* repositoryState(cwd);
    const blockers = blockersFor(repository);
    if (!account.ready) blockers.unshift("account_not_ready");
    return {
      account,
      repository,
      blockers,
      warnings: warningsFor(repository),
    } satisfies ClaudeCloudEligibility;
  });

  const launchSession = Effect.fn("ClaudeCloudService.launchSession")(function* (
    input: ClaudeCloudLaunchInput,
  ) {
    const settings = yield* requireEnabled;
    if (input.createdBy === "agent") {
      if (settings.agentDelegationMode === "off") {
        return yield* fail(
          "delegation_off",
          "The user turned off agent delegation to Claude Cloud. Run the work locally, or ask the user to launch it.",
        );
      }
      if (settings.agentDelegationMode === "ask" && input.userApproved !== true) {
        return yield* fail(
          "approval_required",
          "The user wants to be asked before work goes to Claude Cloud. Ask them, then call again with userApproved: true.",
        );
      }
      if (settings.delegationRules.trim() !== "" && (input.reason?.trim() ?? "") === "") {
        return yield* fail(
          "reason_required",
          `Give a reason that fits the user's delegation rules: ${settings.delegationRules.trim()}`,
        );
      }
    }
    const { instance, account } = yield* resolveInstance(input.instanceId, settings);
    yield* requireReadyAccount(account);
    const cwd = yield* resolveCwd(input);
    if (cwd === null) {
      return yield* fail(
        "invalid_request",
        "Pass a projectId: cloud sessions start from a GitHub repository.",
      );
    }
    const repository = yield* repositoryState(cwd);
    const blockers = blockersFor(repository);
    if (blockers.includes("no_github_remote")) {
      return yield* fail(
        "not_eligible",
        "This repository has no GitHub `origin` remote, which Claude Cloud clones from.",
      );
    }
    if (blockers.includes("detached_head")) {
      return yield* fail(
        "not_eligible",
        "Check out a branch first; Claude Cloud starts from a pushed branch.",
      );
    }
    let pushed = false;
    if (blockers.includes("unpushed_commits")) {
      if (input.pushFirst !== true && !settings.autoPushBeforeLaunch) {
        return yield* fail(
          "not_eligible",
          `Branch ${repository.branch} has ${repository.hasUpstream ? `${repository.aheadCount} unpushed commit(s)` : "never been pushed"}. Push it, or launch with pushFirst.`,
        );
      }
      const push = yield* runner
        .exec({
          command: "git",
          args: ["push", "-u", "origin", "HEAD"],
          cwd,
          env: process.env,
          timeoutMs: PUSH_TIMEOUT_MS,
        })
        .pipe(
          Effect.mapError(
            (error) => new ClaudeCloudError({ code: "cli_failed", message: error.message }),
          ),
        );
      if (push.exitCode !== 0) {
        return yield* fail("cli_failed", `git push failed: ${tail(push.stderr || push.stdout)}`);
      }
      pushed = true;
    }
    const title = input.title ?? defaultTitle(input.prompt);
    const launch = yield* instanceLaunch(instance);
    const run = yield* runner
      .runPty({
        command: launch.command,
        args: ["--cloud", "-n", title, input.prompt],
        cwd,
        env: launch.env,
        timeoutMs: LAUNCH_TIMEOUT_MS,
        match: findLaunchedSessionId,
        // Matter already runs Claude in this project; the folder-trust prompt defaults to yes.
        answers: [{ when: TRUST_PROMPT, send: "\r" }],
      })
      .pipe(
        Effect.mapError(
          (error) => new ClaudeCloudError({ code: "cli_failed", message: error.message }),
        ),
      );
    if (run.match === null) {
      return yield* fail(
        run.timedOut ? "launch_timeout" : "cli_failed",
        `claude --cloud did not report a session${run.timedOut ? " in time" : ""}. Last output: ${tail(run.output) || "(none)"}`,
      );
    }
    const session: TrackedClaudeCloudSession = {
      id: run.match,
      url: claudeCloudSessionUrl(run.match),
      title,
      promptPreview: preview(input.prompt),
      instanceId: instance.instanceId,
      projectId: input.projectId ?? null,
      cwd,
      branch: repository.branch,
      createdBy: input.createdBy,
      sourceThreadId: input.sourceThreadId ?? null,
      reason: input.reason?.trim() || null,
      createdAt: yield* nowIso,
      lastMessageAt: null,
      lastReplyPreview: null,
      teleportedThreadId: null,
      teleportedWorktreePath: null,
    };
    yield* updateSessions((sessions) => [
      session,
      ...sessions.filter((entry) => entry.id !== session.id),
    ]);
    return { session, pushed, warnings: warningsFor(repository) } satisfies ClaudeCloudLaunchResult;
  });

  const requireSessionRef = (ref: string) => {
    const id = parseClaudeCloudSessionRef(ref);
    return id === null
      ? fail("invalid_request", "Pass a cse_… or session_… id, or a claude.ai/code link.")
      : Effect.succeed(id);
  };

  const sendFollowUp = Effect.fn("ClaudeCloudService.sendFollowUp")(function* (input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly instanceId?: ProviderInstanceId;
  }) {
    const settings = yield* requireEnabled;
    const id = yield* requireSessionRef(input.sessionId);
    const tracked = (yield* loadSessions).find((session) => session.id === id);
    const { instance, account } = yield* resolveInstance(
      input.instanceId ?? tracked?.instanceId,
      settings,
    );
    yield* requireReadyAccount(account);
    const launch = yield* instanceLaunch(instance);
    const result = yield* runner
      .exec({
        command: launch.command,
        args: ["-p", input.prompt, "--cloud", id, "--output-format", "json"],
        cwd: tracked?.cwd ?? home,
        env: launch.env,
        timeoutMs: FOLLOW_UP_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError(
          (error) => new ClaudeCloudError({ code: "cli_failed", message: error.message }),
        ),
      );
    const parsed = parseCliJson(result.stdout);
    const body = Option.getOrUndefined(parsed);
    const error =
      body?.ok === false || body?.is_error === true
        ? (body.error ?? body.errors?.join("; ") ?? "The cloud session refused the message.")
        : result.exitCode !== 0
          ? tail(result.stderr || result.stdout) || `claude exited with ${result.exitCode}`
          : null;
    if (error !== null) {
      return yield* fail(/not found/i.test(error) ? "not_found" : "cli_failed", error);
    }
    const reply = body?.result ?? body?.reply ?? body?.message ?? null;
    if (tracked !== undefined) {
      yield* patchSession(id, {
        lastMessageAt: yield* nowIso,
        lastReplyPreview: reply === null ? tracked.lastReplyPreview : preview(reply),
      });
    }
    return { sessionId: id, reply } satisfies ClaudeCloudFollowUpResult;
  });

  const teleportToWorktree = Effect.fn("ClaudeCloudService.teleportToWorktree")(function* (input: {
    readonly sessionId: string;
    readonly projectId: ProjectId;
    readonly instanceId?: ProviderInstanceId;
    readonly prompt?: string;
  }) {
    const settings = yield* requireEnabled;
    const id = yield* requireSessionRef(input.sessionId);
    const tracked = (yield* loadSessions).find((session) => session.id === id);
    const { instance, account } = yield* resolveInstance(
      input.instanceId ?? tracked?.instanceId,
      settings,
    );
    yield* requireReadyAccount(account);
    const root = yield* projectRoot(input.projectId);
    const base = yield* gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (base === null || base === "HEAD") {
      return yield* fail(
        "not_eligible",
        "The project's checkout has no branch to start a worktree from.",
      );
    }
    const suffix = (yield* random.uuidV4()).slice(0, 8);
    // --teleport refuses a dirty tree, so it always runs in a fresh worktree.
    const created = yield* git
      .createWorktree({
        cwd: root,
        refName: GitRefName.make(base),
        newRefName: GitRefName.make(`claude-cloud/${id.slice(0, 24)}-${suffix}`),
        path: null,
      })
      .pipe(
        Effect.mapError(
          (error) => new ClaudeCloudError({ code: "teleport_failed", message: error.message }),
        ),
      );
    const worktreePath = created.worktree.path;
    const launch = yield* instanceLaunch(instance);
    const result = yield* runner
      .exec({
        command: launch.command,
        args: [
          "--teleport",
          id,
          "-p",
          input.prompt ?? DEFAULT_TELEPORT_PROMPT,
          "--output-format",
          "json",
        ],
        cwd: worktreePath,
        env: launch.env,
        timeoutMs: TELEPORT_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError(
          (error) => new ClaudeCloudError({ code: "teleport_failed", message: error.message }),
        ),
      );
    const body = Option.getOrUndefined(parseCliJson(result.stdout));
    if (result.exitCode !== 0 || body?.is_error === true || body?.ok === false) {
      const detail =
        body?.error ??
        body?.errors?.join("; ") ??
        (tail(result.stderr || result.stdout) || "unknown error");
      return yield* fail(
        /not found/i.test(detail) ? "not_found" : "teleport_failed",
        `Teleport failed in ${worktreePath}: ${detail}`,
      );
    }
    const branch = yield* gitOut(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    yield* importer.importRecentAgentThreads({ projectId: input.projectId }).pipe(
      Effect.tapError((error) => Effect.logWarning("Claude Cloud teleport import failed.", error)),
      Effect.ignore,
    );
    const localSessionId = body?.session_id;
    const candidate =
      localSessionId === undefined
        ? null
        : ThreadId.make(`import:${instance.instanceId}:${localSessionId}`);
    const shell =
      candidate === null
        ? null
        : yield* threads.getThreadShell(candidate).pipe(Effect.orElseSucceed(() => null));
    const threadId = shell === null || shell === undefined ? null : candidate;
    if (threadId !== null) {
      // Imports arrive archived; a teleported session is live work.
      yield* threads
        .dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make(`claude-cloud:${yield* random.uuidV4()}`),
          threadId,
          reason: "user",
        })
        .pipe(Effect.ignore);
    }
    if (tracked !== undefined) {
      yield* patchSession(id, {
        teleportedThreadId: threadId,
        teleportedWorktreePath: worktreePath,
      });
    }
    return {
      sessionId: id,
      worktreePath,
      branch: branch === null || branch === "HEAD" ? null : branch,
      threadId,
    } satisfies ClaudeCloudTeleportResult;
  });

  const listSessions = Effect.fn("ClaudeCloudService.listSessions")(function* (
    projectId?: ProjectId,
  ) {
    const sessions = yield* loadSessions;
    return projectId === undefined
      ? sessions
      : sessions.filter((session) => session.projectId === projectId);
  });

  const forgetSession = Effect.fn("ClaudeCloudService.forgetSession")(function* (ref: string) {
    const id = parseClaudeCloudSessionRef(ref) ?? ref;
    const before = yield* loadSessions;
    if (!before.some((session) => session.id === id)) return false;
    yield* updateSessions((sessions) => sessions.filter((session) => session.id !== id));
    return true;
  });

  const agentToolsListed = Effect.gen(function* () {
    if (!(yield* addons.isEnabled(CLAUDE_CLOUD_ADDON_ID))) return false;
    return (yield* readSettings).agentDelegationMode !== "off";
  });

  // Never probes the CLI here: this runs whenever a client loads the add-on list.
  const addonStatus = Effect.gen(function* () {
    const accounts = [...(yield* Ref.get(accountCache)).values()].map((entry) => entry.status);
    if (accounts.length === 0) {
      return {
        kind: "enabled_unconfigured",
        detail: "Check your Claude accounts in Settings → Add-ons.",
      } satisfies AddonRuntimeStatus;
    }
    if (accounts.some((account) => account.ready))
      return { kind: "connected" } satisfies AddonRuntimeStatus;
    return {
      kind: "auth_required",
      detail: "No Claude instance has a claude.ai login that can run cloud sessions.",
      action: { kind: "sign-in" },
    } satisfies AddonRuntimeStatus;
  });

  return ClaudeCloudService.of({
    agentToolsListed,
    addonStatus,
    getStatus,
    updateSettings,
    checkEligibility,
    launchSession,
    sendFollowUp,
    teleportToWorktree,
    listSessions,
    forgetSession,
  });
});

const layer = Layer.effect(ClaudeCloudService, make);

/**
 * The service with its real runner. One reference for every user (HTTP routes and /mcp), so
 * layer memoization builds it, and registers its agent instructions, once.
 */
export const layerWithRunner = layer.pipe(
  Layer.provide(ClaudeCloudRunner.layer),
  Layer.provide(AddonConfigService.layer),
);
