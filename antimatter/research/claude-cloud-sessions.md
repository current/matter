# Feasibility Probe: Native Claude Cloud Sessions in `mattr`

**Date:** 2026-11-25  
**Probe environment:** macOS arm64 · Installed CLI `/Users/christopher/.local/bin/claude` → `/opt/homebrew/bin/claude` (**v2.1.332**) · `@anthropic-ai/claude-agent-sdk` **v0.3.321** · `mattr` commit `94e059316b`  
**Scope:** Read-only CLI, SDK, codebase, and documentation feasibility probe. No production code changed; no cloud sessions or PRs created.

---

## Executive Verdict

**Feasible with a clear split between what works cleanly today vs. what is blocked by CLI/API limits.**

1. **Pulling a cloud session into a local `mattr` worktree (`--teleport`) is a clean, first-class fit.** Contrary to common assumption, `claude --teleport <id>` **does** accept `-p --input-format stream-json --output-format stream-json --verbose` on v2.1.332—the exact wire protocol `ClaudeAdapterV2` uses—and works identically for both default `~/.claude` and `claude-alt` (`CLAUDE_CONFIG_DIR`). Pairing it with `mattr`'s automatic clean worktree creation solves the dirty-tree blocker automatically.
2. **Creating and streaming a brand-new cloud session purely through `ClaudeAdapterV2` (`query()`) is NOT supported by the CLI today.** v2.1.332 explicitly rejects `claude --cloud -p` ("interactive only") and rejects `--output-format stream-json` on both `--cloud <id>` and `--environment <id>`. There is also **no** CLI subcommand or public SDK call to list cloud sessions or cloud environments.
3. **Two viable integration paths exist for `mattr`:**
   - **Recommended v1 (Official CLI, low risk, ~3–5 days):** Gate behind a `claude-cloud` add-on in `packages/contracts/src/mattrAddons.ts`. Support: (a) **"Send to Claude Cloud"** via a short-lived `node-pty` wrapper around `claude --cloud` that captures the `claude.ai/code/<id>` URL/session ID and tracks it in a local registry; (b) **"Send follow-up"** via `claude -p "<msg>" --cloud <id> --output-format json`; (c) **"Pull to local worktree (`--teleport`)"** converting any cloud session into a native `mattr` Claude thread.
   - **Optional v2 (Experimental, high reward, higher maintenance risk):** `@anthropic-ai/claude-agent-sdk/browser` (already bundled in `apps/server/node_modules`) ships a **zero-DOM** Node-compatible CCR v2 SSE transport (`GET .../v1/code/sessions/{id}/events/stream` + `POST .../v1/code/sessions/{id}/events`) that returns the exact `Query` / `SDKMessage` stream `ClaudeAdapterV2` already speaks. If a 1-day live spike confirms it attaches to Anthropic-managed cloud VMs using the local OAuth token, `mattr` could render full live cloud transcripts, approvals, and interrupts inline—at the cost of depending on an `@alpha`/internal API + local OAuth token extraction.

---

## 1. Verified CLI Capabilities (Observed on v2.1.332)

`/Users/christopher/.local/bin/claude` is a bash wrapper (`trajector` auto-enable + `--thinking-display summarized`) that `exec`s `/opt/homebrew/bin/claude` → `@anthropic-ai/claude-code/bin/claude.exe` (Mach-O arm64, `2.1.332 (Claude Code)`).

### 1.1 Auth & Multi-Instance (`claudeAgent` + `claude-alt`)

Both local Claude profiles authenticate as first-party `claude.ai` **Ultra (`max_20x`)** accounts and hit Anthropic's cloud sessions backend identically when isolated via `CLAUDE_CONFIG_DIR`:

| Profile | Command                                                     | `authMethod`               | `planTier`        | Account                   | `.credentials.json` on disk                 |
| ------- | ----------------------------------------------------------- | -------------------------- | ----------------- | ------------------------- | ------------------------------------------- |
| Default | `claude auth status --json`                                 | `claude.ai` (`firstParty`) | `max_20x` (Ultra) | `archlessowner@gmail.com` | Present (`~/.claude/.credentials.json`)     |
| Alt     | `CLAUDE_CONFIG_DIR=~/.claude-alt claude auth status --json` | `claude.ai` (`firstParty`) | `max_20x` (Ultra) | `hitogai.team@gmail.com`  | Present (`~/.claude-alt/.credentials.json`) |

**Auth hard rules verified by probe:**

- **`ANTHROPIC_API_KEY` breaks cloud sessions:** Running with `ANTHROPIC_API_KEY` set fails immediately:
  > `Error: Cloud sessions aren't available: api.anthropic.com didn't accept this session's credentials when Claude Code asked for your organization's policy. Cloud sessions use your claude.ai login. ANTHROPIC_API_KEY is set, so this session is using API-key auth — unset it (or run in a shell without it) to use cloud sessions.`
- **`--bare` breaks cloud sessions** (skips OAuth/keychain):
  > `{"ok":false,"session_id":"cse_...","error":"Cloud sessions need a claude.ai sign-in. Run \`claude auth login\` (or /login in a local session), then try again."}`

### 1.2 Exact Flag Probe Matrix (`v2.1.332`)

All probes were run in isolated temp directories (non-git and dummy git repos with a fake GitHub remote `nonexistent-probe-org-000/nonexistent-probe-repo-000`) with invalid/fake IDs so no real cloud sessions or repos were touched.

| Command / Flag Combination                                                                                           | Exit    | Observed Output / Behavior                                                                                                                                                                                                                                                                       | Verdict                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `claude --cloud -p --output-format=stream-json --verbose "hello"`                                                    | `1`     | `Error: --cloud cannot be combined with --print. Starting a new cloud session with --cloud is interactive only: drop --print, or drop --cloud to run locally. To message an existing cloud session instead, pass its ID: claude -p "message" --cloud <session-id> (find IDs at claude.ai/code).` | **Blocked** — creating a new cloud session requires interactive mode (TTY/PTY).                                                       |
| `claude --cloud --bg "hello"`                                                                                        | `1`     | `--bg and --cloud can't be combined. Use claude --cloud '<task>' directly to start a cloud session.`                                                                                                                                                                                             | **Blocked** — cannot background-launch cloud creation via `--bg`.                                                                     |
| `claude -p "hi" --cloud cse_0111... --output-format stream-json --verbose`                                           | `1`     | `Error: --cloud <session_id> does not support --output-format stream-json`                                                                                                                                                                                                                       | **Blocked** — no `stream-json` output (and therefore no `--input-format stream-json`).                                                |
| `claude -p "hi" --cloud cse_0111... --output-format json`                                                            | `1`     | `{"ok":false,"session_id":"cse_0111...","error":"Session not found: cse_0111..."}`                                                                                                                                                                                                               | **Works** — hits Anthropic cloud API, returns machine-readable JSON. Identical under `CLAUDE_CONFIG_DIR=~/.claude-alt`.               |
| `claude -p "hi" --cloud "https://claude.ai/code/session_0111..." --output-format json`                               | `1`     | `{"ok":false,"session_id":"session_0111...","error":"Session not found: session_0111..."}`                                                                                                                                                                                                       | **Works** — CLI parses `claude.ai/code/` URLs automatically; supports both `cse_…` (CCR v2) and `session_…` (CCR v1) IDs.             |
| `claude -p "" --cloud cse_0111... --output-format json`                                                              | `1`     | `Error: non-interactive --cloud <session_id> requires a prompt (positional or stdin).`                                                                                                                                                                                                           | **Limitation** — cannot be used as a read-only status/transcript poll.                                                                |
| `claude --cloud cse_0111...` (no `-p`, non-TTY, untrusted dir)                                                       | timeout | Renders interactive workspace trust TUI (`Quick safety check: ... Yes, I trust this folder`).                                                                                                                                                                                                    | **Gotcha** — interactive `--cloud` requires a trusted cwd + TTY/PTY.                                                                  |
| `claude --environment env_0111... -p --output-format json "hi"`                                                      | `1`     | `Error: --environment expects a self-hosted environment id (ccpool_...), got "env_0111..."`                                                                                                                                                                                                      | **Clarification** — `--environment` is strictly for org **self-hosted runner pools (`ccpool_...`)**, NOT Anthropic-managed cloud VMs. |
| `claude --environment ccpool_0111... -p --output-format stream-json --verbose "hi"`                                  | `1`     | `Error: --environment does not support --output-format stream-json`                                                                                                                                                                                                                              | **Blocked** for SDK `stream-json`.                                                                                                    |
| `claude --environment ccpool_0111... -p --output-format json "hi"` (no GitHub remote)                                | `1`     | `Error: The selected environment "ccpool_..." requires a git source, but no GitHub remote was detected. Check that git remote get-url origin returns a GitHub URL.`                                                                                                                              | Requires GitHub `origin` remote.                                                                                                      |
| `claude --environment ccpool_0111... -p --output-format json "hi"` (with GitHub remote)                              | `1`     | `Error: self-hosted runners are disabled by your organization's policy` + `{"ok":false,"error":"..."}`                                                                                                                                                                                           | **Unavailable on personal Ultra/Max accounts.**                                                                                       |
| `claude --teleport -p "hi"`                                                                                          | `1`     | `No session ID provided for teleport`                                                                                                                                                                                                                                                            | Requires explicit `cse_…` or `session_…` ID under `-p`.                                                                               |
| `claude --teleport cse_0111... -p --output-format json "hi"` (dirty git tree)                                        | `1`     | `You have uncommitted changes. Commit or stash them before using --teleport.`                                                                                                                                                                                                                    | Clean working tree check runs **before** cloud fetch.                                                                                 |
| `claude --teleport cse_0111... -p --output-format stream-json --input-format stream-json --verbose` (clean git tree) | `1`     | Hits cloud API, emits valid NDJSON `{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Session not found: cse_0111..."],...}`                                                                                                                                        | **Works!** Full bidirectional `stream-json` accepted for both `cse_…` and `session_…`, on both default and `claude-alt`!              |
| `claude agents --json --all`                                                                                         | `0`     | Lists only local `background` (`--bg`) and `interactive` sessions (`id`, `cwd`, `sessionId`, `name`, `state`).                                                                                                                                                                                   | **Local only** — does not list cloud sessions.                                                                                        |
| `claude {sessions,cloud,environments,env,teleport} --help`                                                           | `0`     | Falls through to root `claude --help`.                                                                                                                                                                                                                                                           | **None of these subcommands exist.**                                                                                                  |

Other relevant CLI flags observed in `claude --help`:

- `-n, --name <name>`: _"Set a display name for this session ... Also names a new cloud session."_
- `claude remote-control`: Explicit help contrast — _"Claude and its commands run on this computer; claude.ai and the app only show the session. Keep this computer awake and this command running, or the session stops. (A Cloud session is the opposite: Claude runs in the cloud and this computer can be off.)"_

---

## 2. Verified SDK Capabilities (`@anthropic-ai/claude-agent-sdk` v0.3.321)

Inspected directly in `apps/server/node_modules/@anthropic-ai/claude-agent-sdk` (referenced as `"^0.3.321"` in `apps/server/package.json`):

### 2.1 Main Export (`.` → `sdk.d.ts` / `sdk.mjs`)

- `Options` (80 fields) has **no** `cloud`, `environment`, or `teleport` fields.
- `sdk.mjs` **unconditionally** launches the child CLI with:
  ```js
  ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
  ```
- Consequently, passing `extraArgs: { cloud: ... }` or `extraArgs: { environment: ... }` into `query()` will **always fail** at CLI arg validation.
- Passing `extraArgs: { teleport: "<cse_id>" }` **does** pass CLI validation, though live interaction with `sessionId` / `resume` passed by `ClaudeAdapterV2` still requires a live test (see §3.3).
- Exported session functions (`listSessions`, `getSessionInfo`, `getSessionMessages`, `forkSession`, `renameSession`, `tagSession`, `deleteSession`) operate on local `~/.claude/projects/` (or a caller-provided `SessionStore`), **not** Anthropic's cloud sessions service.

### 2.2 Browser Export (`./browser` → `browser-sdk.d.ts` / `browser-sdk.js`) — Notable Finding

- Despite the package subpath name, static inspection of `browser-sdk.js` shows **zero browser DOM dependencies** (`window.`: 0, `document.`: 0, `EventSource`: 0; uses standard `fetch()` and `WebSocket`, both native in Node 26).
- Exposes `query({ prompt: AsyncIterable<SDKUserMessage>, sse: SSEOptions, canUseTool, hooks, onElicitation, onUserDialog, ... }): Query` returning the **exact same `Query` / `SDKMessage` interface** `ClaudeAdapterV2` consumes.
- `SSEOptions` targets the CCR v2 endpoints directly:
  - `streamUrl`: `.../v1/code/sessions/{id}/events/stream`
  - `sendUrl`: `.../v1/code/sessions/{id}/events`
  - `sessionId`, `headers` (`Authorization`, `anthropic-client-platform`), `fromSequenceNum`, `onCatchUpTruncated`, `onDeliveryUpdate` (`DELIVERY_STATUS_RECEIVED` / `PROCESSING` / `PROCESSED`)
  - Helper functions: `getSseLastSequenceNum(q)`, `getCcrEvent(q, msg)`, `suspendSseStream(q)`, `resumeSseStream(q)`.
- **Caveat:** Internal/preview client surface (notes `ccr_v2_subscribe_sse_web` enablement gate) and requires the caller to supply an OAuth bearer token directly.

### 2.3 Bridge Export (`./bridge` → `bridge.d.ts` / `bridge.mjs`) — Do NOT Conflate with Cloud VMs

- Marked `@alpha` (_"separate versioning universe... breaking changes here do NOT bump the package major"_).
- `createCodeSession()` posts `POST /v1/code/sessions` with `{ title, bridge: {}, config: { cwd, model, sources, outcomes, reuse_outcome_branches } }`.
- This is the **worker-side Remote Control bridge** (local machine executes turns and streams to `claude.ai/code` via `attachBridgeSession` + `fetchRemoteCredentials`), **not** an Anthropic-managed cloud VM runner.

---

## 3. Official Docs Capabilities vs. Unverified / Unsupported Gaps

### 3.1 Verified Official Capabilities (Docs + CLI)

- **Billing & quota:** Included with Claude Pro, Max, Ultra, Team, and Enterprise subscriptions. **Zero separate VM/VPS compute fees**; token usage draws from standard Claude subscription limits.
- **Execution model:** Isolated, Anthropic-managed Linux VM clones the target GitHub repository and branch, runs tests/edits while your Mac is closed/offline, and pushes branches or opens PRs via the Claude GitHub App.
- **Environment customization (web-managed):** In `claude.ai/code`, users configure cloud environments with network access tiers (none / limited package-registry allowlist / full / custom allowlist), setup scripts, and environment variables.
- **Teleport prerequisites (docs + CLI verified):**
  1. Clean git working tree (no uncommitted changes).
  2. Local checkout of the **same GitHub repository** (not a fork or different repo).
  3. Remote branch pushed / reachable so local git can check out the session's branch.
  4. Active `claude.ai` subscription sign-in (never API key / Bedrock / Vertex).
- **Permissions & approvals in cloud sandboxes:** Cloud VMs run inside Anthropic-managed isolated sandboxes (keeping local signing keys/git creds off the VM). Tool approvals and interrupts/steering work natively in `claude.ai/code` and the Claude mobile/desktop apps.

### 3.2 Hard Unsupported Gaps Today

1. **No official non-interactive CLI or SDK API to create a new Anthropic-managed cloud VM.** (`claude --cloud -p` is explicitly forbidden; `--environment` is self-hosted `ccpool_...` only.)
2. **No official CLI or SDK API to list existing cloud sessions or cloud environments** for a `claude.ai` subscription account.
3. **No official CLI streaming/observation mode for cloud sessions.** `claude -p --cloud <id>` requires sending a new user message and forbids `--output-format stream-json`, so CLI alone cannot stream live tool activity, diff updates, or permission prompts from a running cloud session.
4. **No official CLI command to interrupt/cancel a running cloud session** (unlike local `--bg` sessions which have `claude stop <id>` and `claude logs <id>`).
5. **macOS OAuth token access for direct HTTP/SSE is intentionally avoided upstream:** `apps/server/src/provider/claudeResetCredits.ts:197` skips `darwin` when reading `.credentials.json` because macOS logins live primarily in Keychain (though both `~/.claude/.credentials.json` and `~/.claude-alt/.credentials.json` currently exist on this Mac). Calling undocumented `/v1/code/sessions` endpoints with a scraped OAuth token would be an unofficial/experimental transport.

### 3.3 Unverified Items (Require a 1-Day Live Spike Before Implementation)

Deliberately not executed during this read-only probe to avoid creating throwaway cloud sessions or touching real GitHub repos:

1. **PTY output of `claude --cloud -n "<title>" "<prompt>"`:** When spawned in a PTY (`node-pty`) inside a trusted GitHub-backed repo, does `claude --cloud "<task>"` print the `https://claude.ai/code/<id>` URL and exit immediately, or stay attached in an interactive TUI waiting for Ctrl+C?
2. **Blocking vs. fire-and-forget semantics of `claude -p "<msg>" --cloud <real_id> --output-format json`:** Does it return immediately upon enqueueing (`{"ok":true,"session_id":"..."}`), or block until the remote turn finishes and return the assistant reply?
3. **Live `--teleport <real_id>` with `stream-json`:** When `claude --teleport <real_id> -p --output-format stream-json --input-format stream-json --verbose` runs in a clean `mattr` worktree:
   - Does it automatically `git fetch` and switch to the cloud session's branch without interactive confirmation?
   - Does it write a standard local `.jsonl` transcript under `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl` and emit a local UUID `session_id` that `ClaudeAdapterV2` can immediately `--resume` on subsequent turns?
   - Does it conflict with `--session-id` (which `makeClaudeQueryOptions` passes on non-resume turns in `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:2591`)?
4. **`@anthropic-ai/claude-agent-sdk/browser` live SSE attach:** Can `query({ sse: { streamUrl, sendUrl, sessionId, headers } })` attach to a live Anthropic-managed cloud session (`cse_…`) from Node using a `~/.claude` OAuth token, and what `anthropic-client-platform` / `anthropic-beta` headers are required?

---

## 4. `mattr` Codebase Integration Points

Relevant architecture checked in this repo:

- **Claude execution & multi-instance isolation:**
  - `apps/server/src/provider/Drivers/ClaudeDriver.ts` (`supportsMultipleInstances: true`, `driverKind: "claudeAgent"`)
  - `apps/server/src/provider/Drivers/ClaudeHome.ts` (`makeClaudeEnvironment` sets `CLAUDE_CONFIG_DIR` without mutating `HOME`, preserving macOS Keychain logins; `mergeClaudeProcessEnvironment` strips inherited `CLAUDECODE` / `CLAUDE_CODE_*` host vars)
  - `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (`makeClaudeQueryOptions` builds `ClaudeAgentSdkQueryOptions`, supports `extraArgs` and `resume: nativeThreadId`)
  - `apps/server/package.json` already depends on `node-pty` (`^1.2.0-beta.15`) and `@anthropic-ai/claude-agent-sdk` (`^0.3.321`).
- **Workspace modes (`local` vs. `worktree`):**
  - `packages/contracts/src/environment.ts:56` defines `ThreadEnvMode = Schema.Literals(["local", "worktree"])` and `packages/contracts/src/orchestrationV2.ts:782` defines `OrchestrationV2ThreadLaunchWorkspaceStrategy` (`root | existing_worktree | worktree`).
  - `ThreadEnvMode` is wired through ~15 busy upstream files (`settings.ts`, `project.ts`, `t3ProjectFile.ts`, `BranchToolbar.tsx`, `useComposerSelection.ts`, `useComposerSend.ts`, `ProjectDefaultsSettings.tsx`, `ThreadLaunchService.ts`).
  - **Fork-discipline takeaway (`antimatter/CONTEXT.md`):** Do **NOT** add `"cloud"` to upstream `ThreadEnvMode` in v1. It would create high-frequency nightly merge conflicts and leak a Claude-only concept into every provider (Codex, Cursor, Antigravity, Grok, etc.).
- **Add-on Registry (`packages/contracts/src/mattrAddons.ts` + `apps/server/src/bots/AddonConfigService.ts` + `apps/web/src/addons/`):**
  - Already provides persisted off-by-default enablement (`<stateDir>/mattr-addons.json`), non-secret config validation (`ADDON_SECRET_CONFIG_KEY_PATTERN`), runtime status reporting, Settings → Add-ons UI, and `useIsAddonEnabled` gating.
  - Note: Coding sessions remain `mattr` **threads**, not Bots (consistent with `antimatter/research/bot-provider-capability-matrix.md` §10). The Add-on Registry is the right gating/config container without turning Claude Cloud into a Bot provider.

---

## 5. Recommended Minimal v1 Architecture for `mattr`

### 5.1 Design Principle: Start with Clean Fork-Isolated CLI Integration, Expand Only After Live Spike

Gate the entire feature behind a new add-on manifest **`claude-cloud`** in `packages/contracts/src/mattrAddons.ts` (`defaultEnabled: false`, `experimental: true` initially, `contributions: ["settings", "commands", "network"]`, `surfaces: ["desktop", "web", "mobile"]`). When off: zero UI, zero background probes, zero upstream conflicts.

### 5.2 UX Entry Points (All Gated by `useIsAddonEnabled("claude-cloud")`)

1. **Pull from Cloud (`--teleport`) — Flagship v1 Feature:**
   - **Command Palette** (`Teleport Claude Cloud session…`) + **Project header / New thread menu** action.
   - Modal accepts a `claude.ai/code/...` URL or `cse_…` / `session_…` ID + lets user pick which `claude.ai`-authenticated Claude instance (`Claude`, `Claude Alt`) owns the session.
   - Server spins up a fresh clean worktree via `mattr`'s existing `TaskFolders` / `GitWorkflowService.createWorktree`, runs the teleport import, and opens a **normal `mattr` Claude thread** bound to that worktree and imported session ID.
   - From that point on, every `mattr` surface works natively: streaming timeline, diffs, PR panel, approvals, terminal, Voice Mode, Island, mobile/Tailscale PWA.
2. **Send to Claude Cloud (`--cloud`) — Lightweight Offload:**
   - Composer action / Command Palette (`Send to Claude Cloud…`) shown only when:
     - `claude-cloud` add-on is enabled
     - Active provider is a `claudeAgent` instance whose `auth.status === "authenticated"` and `auth.type !== "apiKey"` (verified `claude.ai` subscription)
     - Project has a GitHub `origin` remote.
   - **Pre-flight guardrails:** Checks `git status` / ahead-of-remote commits; warns if local commits are unpushed (with a one-click **"Push branch & launch in Cloud"** option).
   - Launches via `ClaudeCloudService`, stores a lightweight entry in `<stateDir>/claude-cloud-sessions.json` (non-secret metadata: `cloudSessionId`, `url`, `title`, `projectId`, `instanceId`, `branch`, `createdAt`, `lastMessageAt`, `teleportedThreadId?`).
   - Shows a compact **Cloud Session Drawer / Card** (and linked badge on any thread created from it) with:
     - Deep link to open in `claude.ai/code/<id>` (or Claude Desktop/mobile)
     - **Send follow-up** input (executes `claude -p "<msg>" --cloud <id> --output-format json`)
     - **Pull to local worktree (`--teleport`)** one-click button (promotes to a full local `mattr` worktree thread).
3. **Settings → Add-ons → Claude Cloud:**
   - Shows readiness per configured `claudeAgent` instance (`claudeAgent` / `claude-alt`) using `claude auth status --json` (`planTier`, `email`, warning if `ANTHROPIC_API_KEY` is set in instance env).
   - Non-secret config: default Claude instance ID for cloud sessions, auto-push prompt preference.

### 5.3 Server Design (`apps/server/src/cloud/ClaudeCloudService.ts`)

Build as a standard Effect service (`Effect.fn("ClaudeCloudService.*")`) with thin RPC/HTTP handlers (and optional MCP tools `t3_claude_cloud_launch` / `t3_claude_cloud_teleport` so agents can offload or pull cloud sessions too):

- **Environment hygiene (critical):**
  - Build spawn env via `ClaudeHome.makeClaudeEnvironment` + `ClaudeHome.mergeClaudeProcessEnvironment` for the chosen `ProviderInstanceId` (`claudeAgent` or `claude-alt`).
  - **Explicitly delete `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`** from the child env so cloud commands always authenticate via the instance's `claude.ai` OAuth subscription.
  - Set `TRAJECTOR_AUTO_ENABLE=0` (or invoke resolved binary directly) if needed to avoid wrapper side effects during short-lived helper calls.
- **Methods:**
  - `checkEligibility(instanceId, projectCwd)`: verifies `claude.ai` auth + GitHub `origin` remote + unpushed commit count.
  - `launchCloudSession({ instanceId, projectId, cwd, title, prompt })`: spawns `claude --cloud -n <title> <prompt>` via `node-pty` (only after verifying folder trust or handling the launch lifecycle confirmed in the Phase 0 spike), parses the emitted `https://claude.ai/code/<id>` URL / `cse_…` ID, persists to `<stateDir>/claude-cloud-sessions.json`, and terminates the local PTY cleanly once the remote session is created.
  - `sendCloudFollowUp({ instanceId, cloudSessionId, prompt })`: runs `claude -p <prompt> --cloud <cloudSessionId> --output-format json` (no PTY needed), parses JSON response, updates `lastMessageAt`.
  - `teleportToWorktree({ instanceId, projectId, cloudSessionId, initialPrompt? })`:
    1. Creates a clean `mattr` worktree via `GitWorkflowService.createWorktree` (avoiding any dirty working tree on the main checkout).
    2. Runs the teleport step in that clean worktree using the chosen instance's `CLAUDE_CONFIG_DIR` (exact invocation finalized after Phase 0 spike: either one-shot `claude --teleport <id> -p --output-format stream-json` to pull branch + local `.jsonl` session UUID, then creating a `mattr` thread whose `nativeThreadId` resumes that UUID; or handing off directly to `ClaudeAdapterV2`).
    3. Records `teleportedThreadId` in the local registry so there is a clear two-way link (reverse state / visibility).
  - `listTrackedSessions(projectId?)` / `forgetTrackedSession(cloudSessionId)`: manages `<stateDir>/claude-cloud-sessions.json`.

### 5.4 Security, Quota & Remote-Surface Notes

- **Credentials stay server-side:** Web, Desktop, and Mobile/Tailscale PWA clients call `mattr` RPC/HTTP endpoints; OAuth tokens and `CLAUDE_CONFIG_DIR` never leave the server.
- **Zero extra compute cost; multi-account quota spread:** Cloud VM compute is free under the user's existing Claude Ultra (`max_20x`) plans; letting the user choose `claudeAgent` vs. `claude-alt` per cloud launch spreads token quota across both subscriptions cleanly.
- **No secret leakage into `mattr-addons.json`:** Add-on config holds only `defaultInstanceId` and booleans; session metadata holds only public session IDs/URLs/titles.
- **No accidental API-key billing:** Stripping `ANTHROPIC_API_KEY` prevents both cloud auth failure and accidental pay-as-you-go billing on fallback.

### 5.5 Phased Roadmap & Effort Estimate

| Phase                              | Scope                                                                                                                                                                                                                                                                                      | Risk                                                              | Est. Effort   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------- |
| **Phase 0 (Spike)**                | Run the 4 live checks in §3.3 against one private throwaway test repo (no real PRs): PTY output of `claude --cloud`, JSON reply of `claude -p --cloud <id>`, live `--teleport` + `stream-json` branch/transcript behavior, and whether `browser-sdk` SSE attaches to a live `cse_` VM.     | Low                                                               | **0.5–1 day** |
| **Phase 1 (Minimal v1)**           | `claude-cloud` add-on manifest, `ClaudeCloudService` (eligibility + PTY launch + JSON follow-up + clean-worktree `--teleport`), local session registry, Settings card, Command Palette + minimal composer trigger.                                                                         | Low–Med (PTY output parsing for `--cloud` creation)               | **3–5 days**  |
| **Phase 2 (Optional Live Stream)** | Experimental inline cloud session timeline using `@anthropic-ai/claude-agent-sdk/browser` SSE (`v1/code/sessions/{id}/events/stream`) feeding `ClaudeAdapterV2`'s existing `SDKMessage` mapper, with in-app approvals & interrupts. Only build if Phase 0 proves OAuth SSE works reliably. | High (alpha/internal API + macOS Keychain/OAuth token extraction) | **4–7 days**  |
