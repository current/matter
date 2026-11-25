# Devin Official API & CLI Live Feasibility Probe

Status: **Live-tested (read-only)** on 2026-11-25 against a real Devin Max account. Zero writes, zero messages sent, zero ACUs consumed, zero browser cookies touched, zero secrets logged or committed. Follows up on Phase 0 [devin-bots-integration.md](devin-bots-integration.md).

## Executive summary

1. **Major breakthrough — Devin Bots ARE visible on the official v3 Sessions API (Live-tested).** Although `docs.devin.ai/v3-openapi.yaml` (now 208 paths) still has **zero `/bots` endpoints**, every Devin Bot's backing chat session, display name, delegated child session tree, chat history, and Bot automations are all readable today via strictly read-only official v3 `GET` calls:
   - **Bot backing sessions** appear in `GET /v3/organizations/{org_id}/sessions` with `tags: ["agent:poke"]` (server-side filterable via `?tags=agent:poke`), `parent_session_id: null`, `origin: "webapp"`, `devin_mode: "normal"`, and a unique per-Bot `service_user_id`.
   - **Bot display names** are returned directly on single-session `GET /v3/organizations/{org_id}/sessions/{id}` via three extra fields not listed in `v3-openapi.yaml` (`bot_name`, `superdevin_name`, `selected_devin_mode`), and `title` on the list endpoint matches `bot_name`.
   - **Delegated child ("managed Devin") sessions** appear with `tags: ["board"]`, `parent_session_id` pointing to the Bot's `agent:poke` session, the exact same `service_user_id` as their parent Bot, `devin_mode: "fusion" | "lite"`, and `pull_requests: [{ pr_url, pr_state }]`.
   - **Bot chat history** is readable via `GET /v3/organizations/{org_id}/sessions/{id}/messages` (cursor-paginated, chronological), returning both user turns (`origin: "web" | "api"`) and Devin turns (`source: "devin"`).
   - **Bot automations** appear in `GET /v3/organizations/{org_id}/automations` with `run_as.service_user_id` matching the Bot and `actions[].target_bot_id` in `bot-<32-hex>` format (enabling exact `https://app.devin.ai/bots/<32-hex>` deep links when an automation exists for that Bot).
2. **Auth breakthrough — `devin` CLI's local credential is an official v3 API principal (Live-tested).** No `cog_` PAT or `DEVIN_API_KEY` env var is present on this machine, **but** `~/.local/share/devin/credentials.toml` (written by `devin auth login`) stores a `windsurf_api_key` that `GET https://api.devin.ai/v3/self` officially accepts as `principal_type: "windsurf_session"` (documented in `WindsurfSessionUserSelf` in `v3-openapi.yaml`) and resolves to `org_id` / `devin_sessions_org_id` automatically.
3. **Coding provider (`devin acp`) is ALREADY integrated in mattr** via `packages/provider-acp-registry/src/server/devinAcp.ts` and `adapter.ts` (for `agentId === "devin"`). Only a tiny gap remains: local binary overrides (`source === "local"`, `/opt/homebrew/bin/devin` or `devin acp --cloud`) do not currently activate the `isDevin` ACP flavor hooks.
4. **Recommendation:** Ship **Option C (Hybrid)** — a read-only official-v3 **`devin-bots` Observer** add-on on mattr's `BotsPlatformService` with official app deep links (`app.devin.ai/bots/...` / `app.devin.ai/sessions/...`) for chat & approvals, while keeping Devin coding sessions on the existing `provider-acp-registry` (`devin acp` / `devin acp --cloud`). Zero CDP scraping, zero cookie extraction, full remote/mobile/Tailscale compatibility.

---

## 1. Local Devin CLI & Environment Inventory (Read-Only)

### Installed binaries & app bundles

| Surface          | Location                                                                               | Version / details                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Devin CLI        | `/opt/homebrew/bin/devin` → `/opt/homebrew/Caskroom/devin-cli/3000.14.30821/bin/devin` | `devin 3000.14.30821 (a09cd7f323ee)` (231 MB native binary, Homebrew cask `devin-cli`, 204 man pages under `share/man/man1/`)                 |
| Devin Desktop    | `/Applications/Devin.app`                                                              | `1.141.2` (`applicationName: "devin-desktop"`, VS Code / Windsurf fork, `dataFolderName: ".devin"`, URL schemes `devin://` and `windsurf://`) |
| Desktop CLI shim | `/Applications/Devin.app/Contents/Resources/app/bin/devin-desktop`                     | Standard Electron `ELECTRON_RUN_AS_NODE=1` launcher for `out/cli.js`                                                                          |

### Local config, data, env vars, and keychain (metadata only; all secrets redacted)

- **Environment variables (`DEVIN_*`, `COGNITION_*`):** none set.
- **`~/.config/devin/`:**
  - `config.json`: keys `["version"]` only (no `devin.org_id` configured).
  - `mcp_config.json`: `mcpServers` with `cua`.
  - `cli/`: empty directory.
- **`~/.devin/`:** `argv.json`, `.devin-argv-precopy`, `extensions/` (Desktop IDE profile data).
- **`~/.local/share/devin/`:**
  - `credentials.toml` (331 bytes): 4 keys:
    - `windsurf_api_key` (189 chars; **not** a `cog_` PAT or `apk_` key)
    - `api_server_url` = `https://server.codeium.com`
    - `devin_webapp_host` = `app.devin.ai`
    - `devin_api_url` = `https://api.devin.ai`
  - `cli/`: `sessions.db` (~16 MB + `-wal`/`-shm`), `logs/`, `plugins_cache/`, `session_locks/`, `summaries/`, `installation_id`.
  - `mcp/`: MCP state directory.
- **macOS Keychain:** contains only `Devin Safe Storage` (Chromium/Electron cookie encryption key; untouched).
- **Live `devin auth status` (redacted):**
  - Logged in via Devin (`~/.local/share/devin/credentials.toml`), `Tier: Devin Max`, `Plan: Max`, `Team membership: Approved`, `Enterprise: no`, `Allowed models: 1338 explicitly allowed`, `MCP servers: allowed`, `Sandbox: optional`.
- **Live `devin daemon status`:** `no devin daemon is running`.
- **Live `devin doctor --json`:** `ok: true` (3 passing checks: custom subagent profiles, OTEL env, OTEL export).
- **Live `devin models list`:** 56 model families available (`adaptive`, `swe-2.1`, `swe-2`, `swe-2-flash`, `claude-fable-5.2`, etc.).

### `devin` CLI subcommand surface & ACP capabilities

Top-level subcommands (`devin --help`): `auth` (`login`, `logout`, `status`), `mcp`, `models` (`list`), `doctor`, `rules`, `skills`, `plugins`, `cloud` (`drs`), `desktop`, `list`/`ls`, `rm`, `ssh`, `forward`, `update`, `version`, `migrate`, `sandbox`, `setup`, `uninstall`, `acp`, `daemon` (`start`, `stop`, `status`).

- **Bot exposure in CLI:** **None.** Across all 204 bundled man pages (`share/man/man1/*.1`) and all subcommands, `\bbots?\b` has **0 hits**. `devin list --format json` lists only local sessions in the current working directory (`[]` in this worktree). `devin cloud` only exposes `drs` (Declarative Repo Setup: blueprints, sandboxes, builds, secrets, `whoami`) and interactive `--cloud` REPL. `devin cloud drs whoami` fails with `no organization configured — set devin.org_id in your project or user config` even when logged in.
- **`devin acp` capabilities (`devin acp --help` / `devin-acp.1`):**
  - Runs an ACP (Agent Client Protocol) server over stdio.
  - `--process-model <daemon|in-process>` controls whether it shares the background daemon or runs isolated per process.
  - `--agent-type <summarizer|review|codemap>` selects specialized local agent types.
  - `--model <MODEL>` (`DEVIN_MODEL`) and `--refusal-fallback <MODEL>` (`DEVIN_REFUSAL_FALLBACK`) configure local inference.
  - **`--cloud`** relays stdio ACP directly to the **Devin Cloud ACP WebSocket** using `devin auth login` credentials (`--agent-type` and `--model` are ignored in cloud mode). Cloud sessions never check local workspace trust.

---

## 2. Live Official v3 Sessions API Probe

### Auth status & scope

- **Official `cog_` PAT locally:** **Not configured** (`DEVIN_API_KEY` unset; no `cog_` token in `~/.config/devin` or `~/.devin`).
- **Official CLI auth locally:** **Present and accepted by Devin API v3.** `credentials.toml`'s `windsurf_api_key` was tested strictly via read-only `GET` requests:
  - `GET https://api.devin.ai/v3/self` → **HTTP 200** (`principal_type: "windsurf_session"`, matching `WindsurfSessionUserSelf` in `v3-openapi.yaml`), returning `user_id`, `user_name`, `org_id`, `devin_sessions_org_id` (same as `org_id`), and `primary_billing_org_id`.
  - `GET https://api.devin.ai/v3/enterprise/organizations` → **HTTP 403** (`Unauthorized` — expected on non-Enterprise Devin Max plan).
  - `GET https://api.devin.ai/v1/sessions?limit=1` → **HTTP 403** (`Unauthorized` — v1 does not accept `windsurf_session` tokens).

A reusable, zero-dependency, strictly read-only Node probe script is also included at [`antimatter/research/devin-live-probe.mjs`](devin-live-probe.mjs) so Chris can re-run this exact check in ~5 seconds with either a `cog_` PAT (`DEVIN_API_KEY=...`) or local CLI credentials (`--from-devin-cli`), e.g. after Recycling a Bot or after future Devin API releases.

### Live `GET` results (all IDs anonymized, all prompt/title/repo text redacted)

#### A. OpenAPI spec check (`https://docs.devin.ai/v3-openapi.yaml`)

- **208 paths total** (up from 192 in Phase 0), **0 `/bots` paths**.
- Only 1 occurrence of the word `bot` across the entire 1.17 MB spec (an unrelated git-permission docstring).
- Notable documented schemas confirmed: `WindsurfSessionUserSelf`, `PatUserSelf`, `SessionResponse`, `SessionsQueryParams` (supports `tags`, `parent_session_id`, `origins`, `playbook_id`, `automation_ids`, `service_user_ids`, `is_archived`, `first` 1..200, `after`), `SessionMessage`, and `AutomationMessageSessionAction`.

#### B. `GET /v3/organizations/{org_id}/sessions?first=200`

- **HTTP 200**, `68` sessions (`has_next_page: false`, `total: null`).
- **Session object keys (25 fields):** `acus_consumed`, `automation_id`, `category`, `child_session_ids`, `created_at`, `devin_mode`, `is_archived`, `org_id`, `origin`, `parent_session_id`, `playbook_id`, `pull_requests`, `security_profile`, `service_user_id`, `session_id`, `skills`, `status`, `status_detail`, `structured_output`, `subcategory`, `tags`, `title`, `updated_at`, `url`, `user_id`.
- **`session_id` shape:** bare `<32-hex>` (no `devin-` prefix on returned items; `url` is `https://app.devin.ai/sessions/<32-hex>`).
- **Distributions across the 68 sessions:**
  - `origin`: `webapp` (51), `code_scan` (16), `desktop` (1).
  - `devin_mode`: `fusion` (37), `normal` (30), `lite` (1).
  - `status`: `suspended` (68 — none currently running during probe).
  - `status_detail`: `inactivity` (53), `null` (7), `out_of_quota` (7), `user_request` (1).
  - `tags`: **`agent:poke` (6)**, **`board` (38)**, **`nightly-memory-refinement-model:normal` (7)**, untagged (17).
  - `service_user_id`: populated (`service-user-<id>`) on **51** sessions (= 6 + 38 + 7, i.e., **100% of Bot-related sessions and 0% of non-Bot sessions!**); `null` on all 17 non-Bot sessions (`1` desktop + `16` code_scan).

#### C. Bot session graph (anonymized)

| Root ref | `tags`           | `origin` | `devin_mode` | `service_user_id` | Children (`child_session_ids`) | Child `tags` | Child `devin_mode` | Child `service_user_id` |
| -------- | ---------------- | -------- | ------------ | ----------------- | ------------------------------ | ------------ | ------------------ | ----------------------- |
| `S9`     | `["agent:poke"]` | `webapp` | `normal`     | `SU1`             | 1 (1 in page)                  | `["board"]`  | `fusion`           | `SU1`                   |
| `S62`    | `["agent:poke"]` | `webapp` | `normal`     | `SU2`             | 7 (7 in page)                  | `["board"]`  | `fusion`           | `SU2`                   |
| `S63`    | `["agent:poke"]` | `webapp` | `normal`     | `SU3`             | 4 (4 in page)                  | `["board"]`  | `fusion`           | `SU3`                   |
| `S64`    | `["agent:poke"]` | `webapp` | `normal`     | `SU4`             | 8 (8 in page)                  | `["board"]`  | `fusion`           | `SU4`                   |
| `S65`    | `["agent:poke"]` | `webapp` | `normal`     | `SU5`             | 3 (3 in page)                  | `["board"]`  | `fusion`           | `SU5`                   |
| `S68`    | `["agent:poke"]` | `webapp` | `normal`     | `SU6`             | 15 (15 in page)                | `["board"]`  | `fusion`, `lite`   | `SU6`                   |

- **Server-side filtering works:** `GET /v3/organizations/{org_id}/sessions?tags=agent:poke&first=50` returned **HTTP 200** with exact count `6` (`S9`, `S62`, `S63`, `S64`, `S65`, `S68`).
- **Nightly memory refinement sessions (7 sessions):** `S1`, `S2`, `S36`, `S37`, `S38`, `S39`, `S53` all carry `tags: ["nightly-memory-refinement-model:normal"]`, `parent_session_id: null`, `child_session_ids: []`, `status_detail: null`, and **every single one shares a Bot's `service_user_id` (`SU2`–`SU6`)**. Filtering on `tags.includes("agent:poke")` cleanly separates Bot chats from nightly memory jobs.
- **Non-Bot trees cleanly separated:** `S34` (`origin: "code_scan"`, `parent_session_id: S35`, 15 children) has `tags: []` and `service_user_id: null`.

#### D. Single-session `GET /v3/organizations/{org_id}/sessions/{id}` — Undocumented Bot identity fields

Comparing single-session `GET` against list items revealed **3 extra fields** returned only on single-session `GET` (absent from both list responses and `v3-openapi.yaml`):

| Session class           | Extra keys                                           | `bot_name`      | `bot_name === title` | `superdevin_name`            | `selected_devin_mode` |
| ----------------------- | ---------------------------------------------------- | --------------- | -------------------- | ---------------------------- | --------------------- |
| Bot root (`agent:poke`) | `bot_name`, `superdevin_name`, `selected_devin_mode` | non-null string | **true**             | non-null (equals `bot_name`) | `"normal"`            |
| Bot child (`board`)     | same 3 keys                                          | `null`          | `false`              | `null`                       | `"fusion"`            |
| Memory refinement       | same 3 keys                                          | `null`          | `false`              | `null`                       | `"normal"`            |
| Desktop (non-Bot)       | same 3 keys                                          | `null`          | `false`              | `null`                       | `"normal"`            |

**Implication:** Even on the list endpoint alone, `tags.includes("agent:poke")` gives both exact Bot membership and `title` (= Bot name), and single-session `GET` confirms `bot_name` authoritatively.

#### E. `GET /v3/organizations/{org_id}/sessions/{id}/messages`

- **Bot backing session `S9` (`?first=10`):** HTTP 200, `has_next_page: true`, 10 messages (`source`: 5 `user`, 5 `devin`; `origin`: 1 `web`, 4 `api`, 5 `null`).
- **Bot backing session `S68` (`?first=50`):** HTTP 200, `has_next_page: true`, 50 messages (`source`: 20 `user`, 30 `devin`; `origin`: 20 `web`, 30 `null`; `user_id` distinguishes `self` vs `devin-<id>` for internal/Bot-initiated turns).
- **Delegated child `board` session (`?first=10`):** HTTP 200, `has_next_page: true`, 10 messages (`source`: 6 `user`, 4 `devin`; `origin`: 1 `web`, 5 `api`, 4 `null` — `origin: "api"` reflects the parent Bot dispatching/steering its managed child session).
- **Message schema:** `{ event_id ("event-<32ch>"), source ("user" | "devin"), message (string), created_at (unix sec), origin (string | null), user_id (string | null), username (string | null) }`.

#### F. `GET /v3/organizations/{org_id}/automations?first=50` & `/schedules`

- **Automations:** HTTP 200, `3` automations (`A1`, `A2`, `A3`), all `kind: "standard"`, `triggers: [{ event_type: "schedule:recurring", ... }]`.
  - Every automation has `run_as: { type: "service_user", service_user_id }` matching a Bot's `service_user_id` (`A1`/`A2` → `SU2`/`S62`, `A3` → `SU3`/`S63`).
  - Every automation's `actions` entry has `type: "message_session"`, `target_devin_id: null`, and **`target_bot_id: "bot-<32-hex>"`** (distinct from both `session_id` and `service_user_id`).
  - **Deep-link payoff:** Stripping `bot-` from `target_bot_id` yields the 32-hex Bot ID for `https://app.devin.ai/bots/<32-hex>` (for Bots that own at least one automation).
- **Schedules:** `GET /v3/organizations/{org_id}/schedules?first=20` → HTTP 200 (`items: []`, `total: 0`).
- **Attachments:** `GET /v3/organizations/{org_id}/sessions/{id}/attachments` → HTTP 200 (`[]` on tested session).

#### G. Remaining unverified behaviors (intentionally NOT tested to avoid mutations/ACU spend)

1. **Recycle stability:** Whether clicking **Recycle** in Devin creates a new `agent:poke` session sharing the same `service_user_id` (highly likely since `service_user_id` spans the Bot root, all `board` children, all `nightly-memory-refinement` sessions, and all `automations` `run_as` records).
2. **Slack / iMessage message origins:** None of the sampled Bot turns were from Slack or iMessage, so exact `origin` strings for those channels remain unverified.
3. **Sending via `POST .../sessions/{id}/messages` to an `agent:poke` session:** Untested by policy (would wake the session and spend ACUs; also unsupported for Bots).

---

## 3. Official-API Integration Blueprint for mattr

### Comparison of integration options

| Dimension                                  | **(A) Devin Bots Observer (v3 REST + optional `@cognition-ai/sdk`)**                                                                                                     | **(B) Devin Coding Provider (`devin acp` / `devin acp --cloud`)**                                                                                                                                                          | **(C) Hybrid: Official v3 Observer + Deep Links + Existing `devin acp`**                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product surface**                        | Persistent **Devin Bots** in mattr's Bots sidebar & `/bots/devin-bots/$botId`                                                                                            | Interactive **coding threads** in mattr's normal thread list                                                                                                                                                               | **Both:** Bots in Bots platform + Coding sessions in threads                                                                                                                    |
| **Already in mattr?**                      | No (new `BotProviderAdapter`)                                                                                                                                            | **Yes — mostly shipped!** `packages/provider-acp-registry/src/server/devinAcp.ts` + `adapter.ts` already handle `agentId === "devin"` (subagents, message grouping, tool names, plan-bypass guard, shell client terminals) | Builds on existing `BotsPlatformService` + existing `provider-acp-registry`                                                                                                     |
| **Official / ToS-safe?**                   | 100% official v3 HTTPS API (`agent:poke` tag & `bot_name` are observed internal fields on official v3 endpoints; flag `experimental: true`)                              | 100% official ACP stdio protocol (`devin acp` & `devin acp --cloud`)                                                                                                                                                       | 100% official across all surfaces; zero Electron CDP or cookie scraping                                                                                                         |
| **Remote / mobile / Tailscale**            | Full support (server holds PAT or CLI token; clients never see secrets)                                                                                                  | Full support via mattr server spawning `devin acp` on host                                                                                                                                                                 | Full support across web, desktop, mobile, Tailscale, relay                                                                                                                      |
| **Bot discovery & names**                  | **Yes** (`?tags=agent:poke` + `title` / single-GET `bot_name`)                                                                                                           | No (`devin acp` has zero Bot awareness)                                                                                                                                                                                    | **Yes** (v3 API)                                                                                                                                                                |
| **Bot chat history & child tree**          | **Yes** (`.../messages`, `child_session_ids`, `board` children, PR chips, automations)                                                                                   | No (only sessions started inside mattr ACP)                                                                                                                                                                                | **Yes** (v3 API)                                                                                                                                                                |
| **Real-time updates**                      | Adaptive polling owned by `BotsPlatformService` (`30s` idle / `8s` active); optional `@cognition-ai/sdk` (`0.0.x` beta) only while viewing an actively `running` session | Native ACP JSON-RPC streaming over stdio                                                                                                                                                                                   | Adaptive polling + optional SDK live stream when viewing an active session                                                                                                      |
| **Sending to Bot / "Needs you" approvals** | **No** (no Bots send/approve API; `POST .../messages` to backing session is unsupported & spends ACUs)                                                                   | N/A (normal coding turns only)                                                                                                                                                                                             | **Deep-link out** to `https://app.devin.ai/bots/<id>` (when known via automation `target_bot_id`) or `https://app.devin.ai/sessions/<session_id>` / `https://app.devin.ai/bots` |
| **Auth UX**                                | `cog_` PAT in `ServerSecretStore` **or** opt-in reuse of `~/.local/share/devin/credentials.toml` (`windsurf_session`)                                                    | Reuses `devin auth login` automatically                                                                                                                                                                                    | Zero-config on Macs with `devin auth login`, PAT fallback for headless/remote/CI                                                                                                |
| **Estimated effort**                       | M (~2–3 days, read-only observer + settings card)                                                                                                                        | XS (~0.5 day to extend `isDevin` to local binary + optional `--cloud` preset)                                                                                                                                              | M (~3 days total for both)                                                                                                                                                      |

**Recommendation: Option (C) — Hybrid.** Keep coding sessions in `provider-acp-registry` (with the tiny local-binary/`--cloud` polish below) and add a clean, strictly **read-only** `devin-bots` Observer add-on on `BotsPlatformService` with deep links to `app.devin.ai` for replies, approvals, and Bot settings. Revisit write support only if Cognition adds official `/v3/organizations/{org}/bots` endpoints.

#### Tiny Option (B) polish worth doing independently

In `packages/provider-acp-registry/src/server/adapter.ts:200`, `isDevin` currently checks only:

```ts
const isDevin = registryAgentId === "devin";
```

Matching the local binary pattern already used for `isCopilot`, `isOpenCode`, `isKimi`, and `isClaude` (`options.settings.source === "local" && /^devin(\.exe|\.cmd)?$/i.test(...)`) lets a local `devin` install (`/opt/homebrew/bin/devin`) and `devin acp --cloud` (via `commandArgs: ["acp", "--cloud"]`) inherit `devinAcp.ts`'s subagent routing, message grouping, tool naming, `plan_bypass` filter, and `clientTerminals` automatically.

---

### Concrete schema mapping (`mattrBots.ts` + `BotProviderAdapter.ts` + `mattrAddons.ts`)

#### 1. Add-on manifest (`packages/contracts/src/mattrAddons.ts`)

- Add `"devin-bots"` to `KnownAddonId` and `MATTR_ADDON_MANIFESTS`:
  - `id: "devin-bots"`, `displayName: "Devin Bots"`, `category: "bots"`, `defaultEnabled: false`.
  - `platformRequirements: { surfaces: ["desktop", "web", "mobile"] }` (no `hostOs` or `requiresLocalApp` restriction when using a `cog_` PAT).
  - `settingsRoute: "/settings/addons#addon-devin-bots"`.
  - `contributions: ["settings", "sidebar-section", "routes", "network", "bots-provider"]`.
  - `experimental: true` (official v3 endpoints, but `agent:poke` tag & single-GET `bot_name` are undocumented in OpenAPI).
- **Non-secret config** (`<stateDir>/mattr-addons.json`, validated against `ADDON_SECRET_CONFIG_KEY_PATTERN`):
  - `authSource: "pat" | "devin-cli"` (default `"devin-cli"` if `~/.local/share/devin/credentials.toml` exists, else `"pat"`).
  - `orgId?: string` (optional override; auto-resolved from `GET /v3/self` → `devin_sessions_org_id ?? org_id`).
  - `onlyOwnUser?: boolean` (default `true` — filters to `self.user_id` to respect private Bots in shared orgs).
- **Secret storage** (`apps/server/src/auth/ServerSecretStore.ts`):
  - Store user-pasted `cog_` PAT under secret name `"mattr-addon-devin-bots-pat"` (mode `0600` in `serverConfig.secretsDir`, never in `mattr-addons.json` and never echoed to clients).
  - Add a dedicated secret-set/clear route (e.g. `POST /api/mattr/addons/devin-bots/credential` gated by `AuthSettingsWriteScope`) or reuse `ServerSecretStore` via a small secret helper; when `authSource === "devin-cli"`, read `~/.local/share/devin/credentials.toml` strictly server-side on demand.

#### 2. `BotProviderCapabilities` (`packages/contracts/src/mattrBots.ts`)

```ts
export const DEVIN_BOTS_CAPABILITIES: BotProviderCapabilities = {
  ...NO_BOT_PROVIDER_CAPABILITIES,
  agentDiscovery: true, // GET .../sessions?tags=agent:poke
  avatarMetadata: false, // no avatar endpoint; adapter emits deterministic parametric avatar
  conversationDiscovery: true, // Bot root chat + child `board` delegated sessions
  history: "paged", // GET .../sessions/{id}/messages?first=N&after=cursor
  sendMessage: false, // read-only observer (no official Bots send API; avoids ACU spend)
  streaming: false, // polling first; can flip true later if @cognition-ai/sdk stream is wired
  sync: "poll", // owned by BotsPlatformService pollLoop
  activityEvents: true, // emitted on poll diff of status / status_detail
  attachmentsIn: false, // read-only
  artifactsOut: true, // session pull_requests[] -> BotArtifact, attachments -> BotAttachment
  cancel: false, // read-only
  questions: false, // surfaced as read-only BotPendingRequest (or deep-link), no respond API
  approvals: false, // same — "Needs you" approvals happen in app.devin.ai
  createConversation: "none",
  manageAgents: false,
  routines: true, // read-only metadata from GET .../automations (matched by service_user_id)
  computerView: false,
  voice: false,
  officialAppDeepLink: true, // app.devin.ai/bots/<id> (via automation target_bot_id) or /sessions/<id>
  creditSpendWarning: true, // guards any future opt-in write capability
};
```

#### 3. Entity & field mapping

| mattr contract (`packages/contracts/src/mattrBots.ts`) | Devin v3 source                                 | Mapping rule                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BotIdentity.providerId`                               | constant                                        | `"devin-bots"`                                                                                                                                                                                                                                                                                                                                                          |
| `BotIdentity.accountScopeId`                           | `GET /v3/self`                                  | `${orgId}:${self.user_id}` (isolates org + principal)                                                                                                                                                                                                                                                                                                                   |
| `BotIdentity.remoteBotId`                              | `SessionResponse.service_user_id ?? session_id` | Prefer `service_user_id` (`service-user-...`) as stable Bot key across Recycle; fall back to `session_id` if null                                                                                                                                                                                                                                                       |
| `BotIdentity.name`                                     | Single-GET `bot_name` / list `title`            | `detail.bot_name ?? session.title ?? "Devin Bot"` (cache `bot_name` per `session_id` so polling only calls single-GET for newly seen Bots)                                                                                                                                                                                                                              |
| `BotIdentity.avatar`                                   | none on API                                     | `{ kind: "parametric", shape: "auto", color: "auto", seed: remoteBotId }`                                                                                                                                                                                                                                                                                               |
| `BotIdentity.defaultConversationId`                    | `SessionResponse.session_id`                    | Latest `agent:poke` session ID for that `service_user_id`                                                                                                                                                                                                                                                                                                               |
| `BotIdentity.status`                                   | Root + child `status` / `status_detail`         | Roll up highest-priority state across the Bot root and its `board` children (see status table below)                                                                                                                                                                                                                                                                    |
| `BotIdentity.officialAppUrl`                           | Automations `target_bot_id` / root `url`        | If an automation with matching `run_as.service_user_id` has `target_bot_id = "bot-<hex>"`, use `https://app.devin.ai/bots/<hex>`; else `session.url` (`https://app.devin.ai/sessions/<session_id>`)                                                                                                                                                                     |
| `BotIdentity.metadata`                                 | Derived                                         | `{ backingSessionId, targetBotId, childCount, activeChildCount, openPrCount, totalAcus, automationCount, memoryRefinementCount }`                                                                                                                                                                                                                                       |
| `BotConversation` (main chat)                          | Bot `agent:poke` session                        | `conversationId: session.session_id`, `botId: remoteBotId`, `kind: "direct"`, `parentConversationId: null`, `title: botName`, `lastActivityAt: isoFromSec(updated_at)`, `activityState`, `officialAppUrl`                                                                                                                                                               |
| `BotConversation` (delegated work)                     | Each `board` child session                      | `conversationId: child.session_id`, `botId: parentRemoteBotId`, `kind: "delegated-session"`, `parentConversationId: child.parent_session_id`, `title: child.title`, `lastActivityAt: isoFromSec(child.updated_at)`, `activityState`, `officialAppUrl: child.url`                                                                                                        |
| `BotMessage`                                           | `GET .../sessions/{id}/messages`                | `remoteId: m.event_id`, `role: m.source === "devin" ? "agent" : "user"`, `attribution`: `"agent"` for `devin`, `"user-via-other-client"` for `user` (with `origin: "web"`/`"slack"`/`"api"`), `markdown: m.message`, `parts: [{ type: "markdown", text: m.message }]`, `createdAt: isoFromSec(m.created_at)`, `seq: null`, `clientNonce: null`, `deliveryState: "sent"` |
| `BotArtifact`                                          | `SessionResponse.pull_requests[]`               | `{ id: pr.pr_url, kind: "pull-request", title: pr.pr_url, fallbackText: pr.pr_state, url: pr.pr_url }` (attached to conversation summary or latest synthetic artifact)                                                                                                                                                                                                  |
| `BotAttachment`                                        | `GET .../sessions/{id}/attachments`             | Proxy downloads through mattr's server route so clients never receive Devin bearer credentials                                                                                                                                                                                                                                                                          |

#### 4. Status vocabulary mapping (`status` + `status_detail` → `BotActivityState`)

| Devin `status`                                     | Devin `status_detail`                                                                         | `BotActivityState`                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `"running"`                                        | `"waiting_for_approval"`                                                                      | `"waiting_for_approval"`                                               |
| `"running"`                                        | `"waiting_for_user"`                                                                          | `"waiting_for_user"`                                                   |
| `"running"` / `"new"` / `"claimed"` / `"resuming"` | `"working"` or `null`                                                                         | `"working"`                                                            |
| `"running"` / `"exit"`                             | `"finished"`                                                                                  | `"finished"`                                                           |
| `"suspended"`                                      | `"inactivity"` / `"user_request"` / `null`                                                    | `"suspended"` (or `"idle"` on Bot roll-up when no children are active) |
| `"suspended"`                                      | `"out_of_quota"` / `"out_of_credits"` / `"usage_limit_exceeded"` / `"error"` / billing limits | `"error"` (expose exact `status_detail` in `metadata` for UI badge)    |
| `"error"`                                          | any                                                                                           | `"error"`                                                              |

Priority order when rolling up `BotIdentity.status` across root + children:
`waiting_for_approval` > `waiting_for_user` > `working` > `error` > `finished` > `suspended` > `idle`.

#### 5. `BotProviderAdapter` implementation sketch (`apps/server/src/bots/providers/devinBots/`)

- **Files (fork-only, minimal upstream merge surface):**
  - `apps/server/src/bots/providers/devinBots/DevinApiClient.ts` — pure Effect HTTP client for `GET /v3/self`, `GET /v3/organizations/{org}/sessions`, `GET .../sessions/{id}`, `GET .../sessions/{id}/messages`, `GET .../sessions/{id}/attachments`, `GET .../automations`. Handles `401`/`403` → `BotProviderError("auth_required")`, `429` → `BotProviderError("rate_limited")`.
  - `apps/server/src/bots/providers/devinBots/DevinBotsNormalization.ts` — pure functions mapping raw v3 DTOs → `BotIdentity[]`, `BotConversation[]`, `BotMessagesPage`, and diffing snapshots into `BotEvent[]` (`bots-changed`, `conversation-updated`, `activity`, `message-upserted`).
  - `apps/server/src/bots/providers/devinBots/DevinBotsAdapter.ts` — implements `BotProviderAdapter`:
    - `providerId: "devin-bots"`, `addonId: "devin-bots"`, `transport: "session-api-derived"`, `experimental: true`, `officialAppUrl: "https://app.devin.ai/bots"`.
    - `pollIntervals: { idleMs: 30_000, activeMs: 8_000 }` (BotsPlatformService already pauses polling automatically when no client subscribes to `/api/mattr/bots/events` and applies exponential backoff up to 5 min on errors).
    - `start(context)` resolves credentials (PAT from `ServerSecretStore` or local `credentials.toml`), calls `GET /v3/self` to verify auth & discover `org_id`, performs an initial snapshot fetch (`sessions?first=200` + `automations?first=50` + single-GET `bot_name` cache for `agent:poke` roots), and returns a `BotProviderSession` with `listBots`, `listConversations`, `getMessages`, and `poll` (omitting `sendMessage`, `respondToRequest`, and `cancel`).
  - Register `DevinBotsAdapter.make()` in `apps/server/src/bots/registeredProviders.ts` (one line).
  - Add a Settings card `apps/web/src/addons/DevinBotsAddonSettings.tsx` (auth source toggle: local Devin CLI vs PAT paste, optional org ID override, status pill, and "Open Devin Bots" button).

#### 6. Note on pagination & message ordering

`GET /v3/organizations/{org_id}/sessions/{id}/messages` returns messages **oldest-first** with forward cursor pagination (`after` → newer pages), whereas `BotMessagesPage` expects `olderCursor` (paging backward toward older messages). The adapter should either:

- Page forward on initial open (bounded, e.g. up to 5 pages = 1,000 messages) and slice the tail window locally with an opaque cursor into the cached page list, or
- Request recent pages and cache per-conversation `end_cursor` so incremental `poll` ticks fetch only new messages (`?after=<lastEndCursor>`) with minimal bandwidth and rate-limit usage.
