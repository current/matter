# Phase 0 Technical Feasibility Research: Bridging `/Applications/Devin.app` via Loopback CDP

**Date:** 2026-11-25  
**Scope:** Strictly read-only static inspection of the installed `/Applications/Devin.app` bundle + architecture and feasibility analysis for a loopback CDP `BotProviderAdapter` mirroring `apps/server/src/bots/providers/grokBot/`. No live process was launched, restarted, modified, or queried, and zero credentials, cookies, Keychain items, or tokens were read.

---

## Executive Summary

1. **Verdict: Technically feasible (conditional on a 15-minute live probe), with one major security caveat.**
   - Unlike the public v3 REST API and Devin MCP server — which expose **zero** Bot endpoints (documented in `matter/research/devin-bots-integration.md`) — the installed `/Applications/Devin.app` (v`3.14.30833`) **embeds the complete `app.devin.ai` React web application directly inside its Electron renderer workbench** (`out/vs/workbench/devin-webapp-host/`), including the full Devin Bots UI, the undocumented `/poke/*` Bot REST client, the `/{org_id}/boards/inbox` ("Needs you") client, and the `/acp/live` WebSocket session transport.
   - **Electron Fuses do not block CDP:** `EnableNodeCliInspectArguments` is **ENABLED** (`0x31`), and `out/mainImpl.js` explicitly allowlists `"remote-debugging-port"` in its Chromium switch parser. An opt-in launch (`open -a "Devin" --args --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1`) is supported without modifying the app bundle.
2. **Surprise architectural finding:** `/Applications/Devin.app` is **Windsurf Desktop (VS Code `1.141.2` fork, `com.exafunction.windsurf`) rebranded as Devin Desktop**, not a lightweight wrapper around `app.devin.ai`. Its code is shipped unpacked in `Contents/Resources/app/` (no `app.asar`), and it embeds the Rolldown-built Devin webapp as a workbench module (`mountDevinApp` / `installDevinHost`).
3. **Elevated security blast radius vs. Grok Bot:** Because `Devin.app` is a **full VS Code/Windsurf IDE** (with local terminal, filesystem, extension host, and `window.vscode` IPC access), opening `--remote-debugging-port` on `127.0.0.1` exposes a significantly larger local same-user attack surface than opening CDP on `Grok Bot.app`. Any implementation must stay strictly opt-in, `experimental: true`, loopback-only, and prominently disclose this trade-off in Settings.
4. **Recommended next step:** Run a **15-minute Phase 0.5 live CDP probe** (with explicit user consent to launch `Devin.app` once on `127.0.0.1:9223`) to verify React Fiber reachability of TanStack `QueryClient` + the authenticated `api` client on `.devin-app-root`, confirm behavior when switched to Editor Mode, and verify that sending a prompt to a Bot does not disrupt an open tab's `/acp/live` WebSocket subscription. If that probe passes, build `DevinBotAdapter` mirroring `GrokBotAdapter` (~5–7 days total across Phases 1–3).

---

## 1. Bundle & Electron Architecture of `/Applications/Devin.app`

All facts below were verified statically (read-only) from `/Applications/Devin.app` on this Mac (installed mtime `2026-11-20 15:34`; not running during inspection).

### Bundle Metadata & Runtime Stack

| Property                 | Verified Value                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App path                 | `/Applications/Devin.app`                                                                                                                                                                       |
| Display / bundle name    | `Devin` (`CFBundleExecutable: Devin`, `CFBundleIconName: devin-desktop-stable`)                                                                                                                 |
| Bundle identifier        | `com.exafunction.windsurf` (legacy Windsurf ID preserved in `Info.plist` & `product.json`)                                                                                                      |
| App version              | `3.14.30833` (`CFBundleShortVersionString` & `CFBundleVersion`)                                                                                                                                 |
| Upstream VS Code base    | `1.141.2` (`Contents/Resources/app/package.json`, `author: Exafunction, Inc.`)                                                                                                                  |
| Registered URL schemes   | `devin://` (`urlProtocol`), `windsurf://` (`oldUrlProtocol`)                                                                                                                                    |
| Minimum macOS            | `12.0` (`LSMinimumSystemVersion`), `NSPrincipalClass: AtomApplication`                                                                                                                          |
| Electron Framework       | `43.8.8` (`Contents/Frameworks/Electron Framework.framework/Resources/Info.plist`)                                                                                                              |
| Chromium                 | `150.0.7871.250` (extracted from `Electron Framework` binary)                                                                                                                                   |
| Bundled Node target      | `24.22.1` (`package.json` `engines.node`)                                                                                                                                                       |
| Helper apps / frameworks | `Devin Helper.app`, `Devin Helper (Renderer).app`, `Devin Helper (GPU).app`, `Devin Helper (Plugin).app`, `Squirrel.framework`, `Mantle.framework`, `ReactiveObjC.framework`                    |
| Codesign entitlements    | `com.apple.security.automation.apple-events`, `com.apple.security.cs.allow-jit`, `com.apple.security.device.audio-input`, `com.apple.security.device.camera` (no App Sandbox blocking loopback) |

### Electron Fuses Audit

Inspected directly from `/Applications/Devin.app/Contents/Frameworks/Electron Framework.framework/Electron Framework` at sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX` (offset `152168112`, `FuseWireVersion = 1`, `FuseCount = 9`):

| Index | Fuse                                    | State              | Implication for Loopback CDP                                              |
| ----- | --------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `[0]` | `RunAsNode`                             | **ENABLED** (`1`)  | Required by `bin/devin-desktop` (`ELECTRON_RUN_AS_NODE=1`)                |
| `[1]` | `EnableCookieEncryption`                | **DISABLED** (`0`) | N/A (we never read cookies)                                               |
| `[2]` | `EnableNodeOptionsEnvironmentVariable`  | **ENABLED** (`1`)  | Allowed                                                                   |
| `[3]` | `EnableNodeCliInspectArguments`         | **ENABLED** (`1`)  | **Allows `--remote-debugging-port` and `--remote-debugging-pipe`**        |
| `[4]` | `EnableEmbeddedAsarIntegrityValidation` | **DISABLED** (`0`) | `Info.plist` only carries integrity hash for `Resources/default_app.asar` |
| `[5]` | `OnlyLoadAppFromAsar`                   | **DISABLED** (`0`) | App runs unpacked from `Resources/app/`                                   |
| `[6]` | `LoadBrowserProcessSpecificV8Snapshot`  | **DISABLED** (`0`) | Standard snapshot                                                         |
| `[7]` | `GrantFileProtocolExtraPrivileges`      | **ENABLED** (`1`)  | Standard VS Code file protocol                                            |
| `[8]` | Electron 43 Fuse #8                     | **ENABLED** (`1`)  | Not restrictive                                                           |

In addition, `out/mainImpl.js` (`Rae()`) explicitly includes `"remote-debugging-port"` in its allowlisted Chromium switches (alongside `"disable-hardware-acceleration"`, `"force-color-profile"`, `"disable-lcd-text"`, and `"proxy-bypass-list"`), and `out/vs/workbench/workbench.desktop.main.js` registers `"remote-debugging-port"` in the VS Code `argv.json` schema.

### App Layout & Entrypoints (Unpacked — No `app.asar`)

There is **no `Resources/app.asar`**. The entire desktop app ships unpacked under `/Applications/Devin.app/Contents/Resources/app/` (dependencies live in `node_modules.asar`, 187.5 MB, plus `node_modules.asar.unpacked/`):

- **Main process:** `out/main.js` (100 KB) → `out/mainImpl.js` (2.04 MB). Handles window management, protocol registration (`devin://` / `windsurf://`), CLI flags (`Rae()`), `WebContentsView` browser previews, and dynamic webapp preview pulls (`https://static.devin.ai/desktop-preview-062dcfee/v1/pull/<sha256>.json`).
- **CLI wrapper:** `bin/devin-desktop` invokes `ELECTRON_RUN_AS_NODE=1 "$ELECTRON" out/cli.js "$@"`.
- **Preload scripts:**
  - `out/vs/base/parts/sandbox/electron-browser/preload.js`: exposes `window.vscode` via `contextBridge.exposeInMainWorld` (`ipcRenderer` restricted to `vscode:*` channels, `ipcMessagePort`, `webFrame`, `webUtils`, `process`, `context`).
  - `out/vs/platform/devinPreview/electron-browser/preload-devinPreview.js`: exposes `window.devinPreviewHost` for `preview.devinapps.com` / `scfHost.html` iframes.
  - `out/vs/platform/browserView/electron-browser/preload-browserView.js`: preload for in-IDE `WebContentsView` browser tabs.
- **Renderer workbench:** `out/vs/code/electron-browser/workbench/workbench.html` → `out/vs/workbench/workbench.desktop.main.js` (23.7 MB). Directly imports and mounts the embedded Devin web application:
  - `out/vs/workbench/devin-webapp-host/index.js` (exports `DEVIN_APP_ROOT_CLASS`, `installDevinHost`, `mountDevinApp`, `mountDevinSessionPane`, `mountQuickInputPalette`, `observeSessions`, `parseCloudSessionId`, `requestArchiveSession`, `discardSessionPaneTab`).
  - `out/vs/workbench/devin-webapp-host/assets/` contains **3,853 files** (**1,982 JS chunks** compiled with Rolldown/Vite), covering the full `app.devin.ai` SPA including Bots, Inbox, Sessions, Settings, and 3D Bot avatars.
- **Bundled extensions & binaries:**
  - `extensions/windsurf/`: Windsurf IDE extension (`dist/extension.js` 6.56 MB), `bin/language_server_macos_arm` (146 MB), and `devin/bin/devin` (231 MB bundled Devin CLI; its `share/man/man1/` confirms `devin acp`, `devin auth`, and `devin cloud drs` subcommands, with **no Bot CLI commands**).
  - `extensions/windsurf-remote-devin/`: remote authority resolver for `devin-cloud` sessions.
  - `extensions/windsurf-auth/`: auth extension.
  - `out/vs/workbench/windsurf-chat-client/index.js`: Cascade/Windsurf IDE chat client.

---

## 2. Does `Devin.app` Host Devin Bots UI & API Calls?

**Yes — completely and natively inside the main Electron renderer.**

`Devin.app` does **not** load `https://app.devin.ai` in a separate `BrowserWindow` or `WebContentsView`. Instead, `workbench.desktop.main.js`:

1. Calls `installDevinHost(Jrs(...))`, injecting a rich desktop host object into the embedded webapp closure (`auth.getToken`, `auth.getOrgId`, `auth.getUserId`, `acp`, `sessionPersistence`, `workspaces`, `remoteHosts`, `terminals`, `commands`, `window`, `openExternal`, `urlProtocol`).
2. Calls `mountDevinApp(container, ...)` inside a React 19 root (`createRoot(e, { identifierPrefix: ... })`) mounted on a DOM container with class **`devin-app-root`** (`DEVIN_APP_ROOT_CLASS = "devin-app-root"`).

### Client-Side State & Transport Architecture

Verified across `out/vs/workbench/devin-webapp-host/assets/`:

- **Router:** TanStack Router, including Bot routes `/_user/bots`, `/_user/bots/$id`, `/_user/bots/$id/settings`, and `/sessions/$sessionId`.
- **Server state & caching:** TanStack React Query (`QueryClient` with `getQueryCache()`, `staleTime: Infinity` on paged event queries, `refetchOnWindowFocus: false`).
- **Client/realtime state:** Zustand (`createStore`) managing active ACP WebSocket connection state, session streams, and UI slices.
- **HTTP client:** `ky` wrapped with an OpenAPI-style typed client (`chunk-app-initial-dio5FMc_.js`). Its `beforeRequest` hook automatically calls `auth.getToken()` to set `Authorization: Bearer <token>` and sets `x-cog-org-id: <orgId>`, targeting `https://api.devin.ai` (or `https://api.beta.devin.ai` / `https://staging.itsdev.in` per `devin.environment`).

### Verified Internal Bot, Session & Inbox API Map

Devin Bots live under an internal **`/poke/*`** REST namespace (plus org-scoped `/{org_id}/bots` and `/{org_id}/boards/inbox`) that is absent from the public v3 OpenAPI spec:

| Domain                            | Endpoints Verified in `devin-webapp-host`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Source Chunk                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discover Bots**                 | `GET /poke/bots?include_shared=true` (`&archived=true`, `&pinned_bot_id=...`), `GET /{org_id}/bots?include_shared=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `chunk-app-initial-CCR4iQLq.js`                                                                                                             |
| **Bot CRUD & metadata**           | `GET /poke/bots/{bot_id}`, `POST /poke/{org_id}/bots`, `PATCH /poke/bots/{bot_id}`, `PUT /poke/bots/{bot_id}/archived`, `DELETE /poke/bots/{bot_id}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `chunk-app-initial-C0oM2bog.js`                                                                                                             |
| **Bot backing session**           | `GET /poke/bots/{bot_id}/session` (resolves active `devin_id`), `POST /poke/bots/{bot_id}/session` (`{ initial_message, kickoff, devin_id, suggested_language }` — starts/recycles session)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `chunk-app-initial-C0oM2bog.js`                                                                                                             |
| **Bot status & preview**          | `GET /poke/bots/{bot_id}/session/latest-message` (404 → `{ latest_message: null }`), `GET /poke/bots/{bot_id}/session/working-summary`, `GET /poke/bots/{bot_id}/artifacts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `chunk-app-initial-C0oM2bog.js`, `chunk-app-initial-CCR4iQLq.js`                                                                            |
| **Bot chat history**              | `GET events/all/{devin_id}?cursor=...` (returns `{ result: Event[], next_cursor }`; cached in React Query under `["session-all-events-paged", devin_id]`; event types include `initial_user_message`, `user_message`, `agent_message`, `user_question`, `autorespond_update`, `child_session_settled`)                                                                                                                                                                                                                                                                                                                                                                                                      | `chunk-requests-ZkgSFHjW.js`, `chunk-allEventsQuery-DV2KugM7.js`, `chunk-app-initial--FIXco28.js`                                           |
| **Send message & live streaming** | **ACP over WebSocket** at `${wsBase}/acp/live?token=...&org_id=...`: JSON-RPC `session/prompt` (`params: { sessionId, prompt, _meta: { "cognition.ai/clientMessageId", "cognition.ai/replyThread" } }`), `session/cancel`, `session/load`, `session/resume`; server pushes `session/update` and `ext/notification` (`_cognition.ai/session_update_batch`). Pause/sleep via `POST sessions/{devin_id}/sleep`.                                                                                                                                                                                                                                                                                                | `chunk-app-initial-BDwdgn6V.js`, `chunk-app-initial-DCLV34dl.js`, `chunk-app-initial-Cy-vZy6L.js`                                           |
| **Bot identity & avatars**        | `bot_id`, `org_id`, `created_by`, `avatar_url` (custom upload or catalog URL), `slack_icon_url`; `GET /poke/bots/avatar-catalog?schema_version=1`. Webapp renders either custom `avatar_url`, preset PNGs (`bot-*.png`), or a custom 3D canvas renderer (`Bot3dCogFace`, palette tokens `rose`, `magenta`, `indigo`, `azure`, `emerald`, `tan`, `amber`, `tangerine`, `vermilion`, `silver`, `charcoal`).                                                                                                                                                                                                                                                                                                   | `chunk-app-initial-BfRwNhwm.js`, `chunk-Bot3dCogFace-fNrJS6VL.js`, `chunk-BotAvatarPicker-BK4ZCWa7.js`, `chunk-bots-Dk3g3Tm9.js`            |
| **"Needs you" inbox & approvals** | `GET /{org_id}/boards/inbox`, `GET /{org_id}/boards/inbox/summaries`, `GET /{org_id}/boards/{board_id}/inbox/item-sessions`; actions: `POST /{org_id}/boards/{board_id}/tickets/{ticket_id}/inbox-{engage\|opened\|resolve\|park\|snooze-until\|reopen\|restore\|rename}`. In-chat Bot cards & grants: `POST /poke/bots/{bot_id}/options/pick`, `POST /poke/bots/{bot_id}/cards/{card}/answered`, `POST /poke/bots/{bot_id}/setup-cards/{card}/answered`, `POST /poke/bots/{bot_id}/connect-card`, `GET /poke/bots/{bot_id}/access-requests`, `POST /poke/bots/{bot_id}/access-requests/{id}/grant`, `DELETE /poke/bots/{bot_id}/access-requests/{id}`, `POST /sessions/{devin_id}/user-question-answered`. | `chunk-app-initial-CDcBD1lH.js`, `chunk-BotInboxInsetCard-BO7ozyao.js`, `chunk-needs-you-card-B_xrpYhh.js`, `chunk-app-initial-C0oM2bog.js` |
| **Child sessions linkage**        | `GET /sessions/{devin_id}` returns `child_session_ids`, `child_session_count`, `descendant_sessions`, `acu_used_including_child_sessions`, `overage_dollars_including_child_sessions`; live stream emits `child_session_settled` / `session_settle_subscribed`; adoption/move via `POST /poke/{org_id}/bots/{bot_id}/takeover` and `POST /poke/bots/{bot_id}/move-session`.                                                                                                                                                                                                                                                                                                                                 | `chunk-SessionPanes-CvNXG9Et.js`, `chunk-app-initial-C0oM2bog.js`, `chunk-app-initial--FIXco28.js`                                          |
| **Budget / usage caps**           | `GET /poke/bots/{bot_id}/own-limit`, `PUT /poke/bots/{bot_id}/budget`, `PUT /poke/bots/{bot_id}/budget/on-demand-cap`, `POST /poke/bots/{bot_id}/budget/request`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `chunk-app-initial-C0oM2bog.js`                                                                                                             |

### Deep Links, Local Servers & Preload Surfaces

- **Deep links (`devin://` and `windsurf://`):** Registered in `workbench.desktop.main.js` (`workbench.contrib.devinSessionUrl`, `Uhc()`):
  - `devin://session/<hex-id>` (or `devin://session/devin-<hex-id>`) → opens that cloud session in a new Devin tab.
  - `devin://app/open/<base64url-path>` and `devin://app/return/<base64url-path>` → navigates the embedded webapp to any relative `/` path (validated `!startsWith("//") && !includes("\\")`). Encoding `/bots/<bot_id>` as base64url opens that exact Bot directly inside `Devin.app`, giving us a native desktop deep link alongside `https://app.devin.ai/bots/<bot_id>`.
- **Local IPC / HTTP / WS servers:** **None for Bots.**
  - `openCdpServer` in `out/mainImpl.js` is only VS Code's on-demand `ExtensionHostDebugBroadcastChannel` (`attachToCurrentWindowRenderer`) for extension debugging — it is not listening by default.
  - `extensions/windsurf/bin/language_server_macos_arm` serves Windsurf IDE / Cascade features, not Devin Bots.
  - `extensions/windsurf/devin/bin/devin` (Devin CLI) supports `devin acp` for local/cloud coding sessions, not persistent Bots.
- **Electron preload APIs:** `window.vscode` only proxies `vscode:*` IPC channels and does not expose Bot data directly; the Devin host contract (`Jrs()`) is passed purely inside the renderer JS module graph to `installDevinHost(...)`.

---

## 3. Loopback CDP Bridge Feasibility vs. `GrokBotAdapter.ts` & Official Sessions API

### Direct Comparison with `GrokBotAdapter.ts`

| Dimension                        | `GrokBotAdapter` (`apps/server/src/bots/providers/grokBot/`)                                  | Proposed `DevinBotAdapter` (Loopback CDP)                                                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Target app**                   | `/Applications/Grok Bot.app` (`com.anysphere.sand`) — dedicated chat app                      | `/Applications/Devin.app` (`com.exafunction.windsurf`) — full VS Code/Windsurf IDE hosting embedded Devin webapp                                                                                                              |
| **Opt-in CDP launch**            | `open -a "Grok Bot" --args --remote-debugging-port=9222` (default `9222`)                     | `open -a "Devin" --args --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1` (must use distinct default port **`9223`** to coexist with Grok Bot)                                                               |
| **Electron fuses**               | Permits `--remote-debugging-port`                                                             | Verified: `EnableNodeCliInspectArguments = ENABLED`; `mainImpl.js` allowlists `remote-debugging-port`                                                                                                                         |
| **CDP target selection**         | Single `page` target matching `grok` / `sand` / `file://`                                     | Must filter VS Code workbench `page` targets (`vscode-file://vscode-app/.../workbench.html`), ignoring `devtools://`, `vscode-webview://`, and `WebContentsView` previews, and select a window with `.devin-app-root` mounted |
| **In-renderer bridge mechanism** | Walks React Fiber from `.sand-agent-item` to in-memory `roster` & `transcript` context stores | Walks React Fiber from `.devin-app-root` to TanStack `QueryClient`, authenticated `api` (`ky`) client, and active `orgId` (plus ACP WebSocket store for sending/cancel)                                                       |
| **Multi-conversation / tree**    | 1:1 direct chat (`botId === conversationId`)                                                  | 1 Bot → 1 persistent chat (`kind: "direct"`, backed by `devin_id`) + N child sessions (`kind: "delegated-session"`, `parentConversationId` set)                                                                               |
| **Cost guardrail**               | `creditSpendWarning: false`                                                                   | **`creditSpendWarning: true`** (mandatory: sending wakes the Bot's cloud session and bills ACUs/credits; `matterBots.ts` already enforces `confirmUsage`)                                                                     |
| **Approvals / Inbox**            | `approvals: false`, `questions: false`                                                        | Full support achievable via `/{org_id}/boards/inbox`, `inbox-resolve`, `/poke/bots/{bot_id}/options/pick`, `/poke/bots/{bot_id}/access-requests/{id}/grant`                                                                   |
| **Asset provenance**             | Clean-room parametric SVG + sanitized user `avatarDataUrl`                                    | Sanitized `avatar_url` (proxied/resized thumbnail) or clean-room icon fallback; **never copy** proprietary `Bot3dCogFace` canvas engine, `devin-persona` keyframes, or `bot-*.png` assets                                     |
| **Local CDP blast radius**       | Medium-High (exposes chat app renderer to same-user local processes)                          | **High** (exposes a full IDE renderer with `window.vscode` IPC, local terminals, and workspace file access to same-user local processes)                                                                                      |

### Capability Comparison: Loopback CDP Bridge vs. Official Sessions API Observer

| Capability                                 | Loopback CDP Bridge (`Devin.app`)                                                                              | Official v3 Sessions API Observer (`devin-bots-integration.md`)                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Discover Bots (`agentDiscovery`)           | **Yes** (`GET /poke/bots?include_shared=true`)                                                                 | **No** (no `/bots` path in v3 OpenAPI)                                                |
| Bot identity & avatars (`avatarMetadata`)  | **Yes** (`avatar_url`, catalog, `working-summary`)                                                             | **No**                                                                                |
| Read Bot chat history (`history: "paged"`) | **Yes** (`GET /poke/bots/{bot_id}/session` → `GET events/all/{devin_id}`)                                      | **Unverified / fragile** (unclear if backing session is listed or survives Recycle)   |
| Send messages to Bot (`sendMessage`)       | **Yes** (subject to live probe of `/acp/live` socket contention)                                               | **No** (unsupported)                                                                  |
| Stream / poll replies                      | **Yes** (bounded poll of `latest-message` + `events/all/{devin_id}`; push/streaming possible later via ACP WS) | Sessions only (beta `@cognition-ai/sdk` or polling)                                   |
| Observe child sessions                     | **Yes** (`GET /sessions/{devin_id}` `descendant_sessions` / `child_session_ids`)                               | **Yes** (if root session ID can be discovered)                                        |
| Answer "Needs you" approvals/cards         | **Yes** (`/{org_id}/boards/inbox` + `/poke/bots/{bot_id}/options/pick` + `access-requests/*/grant`)            | **No**                                                                                |
| Headless / remote / Linux / no Desktop app | **No** (requires `Devin.app` running locally on host Mac; remote PWA works only via Mac `Matter` server)       | **Yes** (direct HTTPS with `cog_` PAT, except Enterprise orgs where PATs default off) |
| Official support / stability               | **Unofficial / experimental** (breaks if Cognition renames `/poke/*` or refactors React contexts)              | **Officially supported** (for sessions; Bots still absent)                            |

### Risks & Open Technical Unknowns (Must Verify in Phase 0.5 Live Probe)

1. **Security — IDE-wide CDP exposure (highest risk):** Any same-user local process on the Mac can connect to `http://127.0.0.1:9223` and execute JS inside `Devin.app`'s renderer, which has access to `window.vscode` (local IDE commands/terminals/files) and the in-memory Devin auth closure.
   - **Mitigations:** Bind strictly to `127.0.0.1` (`--remote-debugging-address=127.0.0.1`); validate loopback host & exact port on both HTTP `/json` and WebSocket `webSocketDebuggerUrl` (`redirect: "error"`); recommend ephemeral terminal launch rather than persistent `~/.devin/argv.json`; never auto-launch or restart `Devin.app`; never read, serialize, or log `auth.getToken()`, cookies, or Keychain items inside `Runtime.evaluate`; display an explicit security notice in Settings.
2. **ToS & unofficial endpoints:** Invoking internal `/poke/*` and `/boards/inbox` endpoints via local CDP automation is undocumented and not sanctioned by Cognition. Keep strictly behind `experimental: true` and `defaultEnabled: false` for personal-fork use only.
3. **Single-socket contention on `/acp/live` (Unverified live):** In `chunk-app-initial-BDwdgn6V.js`, `connectSocket` tracks a single `currentSessionId` per store instance (`acp_websocket_session_change` fires on session switch). Sending a `session/prompt` to a background Bot via the active tab's Zustand store could disconnect the session the user is currently viewing in `Devin.app`. **Live probe must verify** whether the webapp creates per-pane stores, whether an isolated transient ACP WebSocket can be opened in-renderer without disturbing UI state, or whether a REST message-post endpoint exists for cloud sessions.
4. **Editor Mode & multi-window lifecycle (Unverified live):** When the user switches `Devin.app` into pure Editor Mode or has multiple workspace windows open, `.devin-app-root` may be hidden or unmounted in some windows. Target selection must scan all workbench `page` targets for an active `.devin-app-root` and report a clean `disconnected` / actionable status if none is mounted.
5. **Dynamic bundle drift (`static.devin.ai`):** `Devin.app` can hot-download updated `devin-webapp-host` bundles from `static.devin.ai/desktop-preview-062dcfee/v1/`. CDP `Runtime.evaluate` scripts **must never reference minified symbol names** — only stable runtime shapes (`.devin-app-root`, React Fiber context values duck-typed by `getQueryCache` / `fetchQuery`, `ky` client `.get`/`.post`, and stable URL paths).
6. **Billing & prompt-injection blast radius:** Messaging a Devin Bot wakes its session and may spawn child sessions billed to the creator; shared Bots also hold org-level grants. Enforce `creditSpendWarning: true` (`confirmUsage`) on send and render all Bot/inbox output as untrusted markdown.

---

## 4. Concrete Implementation Blueprint

### Phase 0.5 — Mandatory 15-Minute Live Compatibility Probe (Gate)

Before writing production adapter code, obtain explicit user consent to launch `/Applications/Devin.app` once with:

```bash
open -a "Devin" --args --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1
```

Verify four concrete facts via read-only CDP `Runtime.evaluate` (zero token/cookie reads):

1. `GET http://127.0.0.1:9223/json` lists the workbench `page` target (`vscode-file://vscode-app/.../workbench.html`), and `.devin-app-root` is present (also check behavior after toggling Editor Mode).
2. Walking `__reactFiber$` from `.devin-app-root` reliably locates:
   - TanStack `QueryClient` (`typeof v.getQueryCache === "function" && typeof v.fetchQuery === "function"`),
   - the authenticated `ky` API client (`typeof v.get === "function" && typeof v.post === "function"`) or its OpenAPI wrapper, and
   - the active `orgId`.
3. Exact response schemas of `GET /poke/bots?include_shared=true`, `GET /poke/bots/{bot_id}/session`, `GET /poke/bots/{bot_id}/session/latest-message`, `GET events/all/{devin_id}`, and `GET /{org_id}/boards/inbox`.
4. Safe message-send path (`session/prompt` via an isolated ACP WS vs. store method vs. `POST /poke/bots/{bot_id}/session`) that does **not** disrupt the user's currently open tab in `Devin.app`.

### Target Module Architecture (Mirroring `grokBot`)

1. **Contracts (`packages/contracts/src/matterAddons.ts`)**
   - Add `"devin-bot"` to `KnownAddonId` and register its manifest in `MATTER_ADDON_MANIFESTS` (`category: "bots"`, `defaultEnabled: false`, `experimental: true`, `platformRequirements: { surfaces: ["desktop", "web", "mobile"], hostOs: ["darwin"], requiresLocalApp: "Devin" }`, `settingsRoute: "/settings/addons#addon-devin-bot"`).
   - Export `DEVIN_BOT_CDP_PORT_CONFIG_KEY = "cdpPort"`, `DEVIN_BOT_DEFAULT_CDP_PORT = 9223`, `devinBotCdpPortFromConfig(config)`, and `devinBotLaunchCommand(port)`:
     ```ts
     open -a "Devin" --args --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1
     ```
2. **Server Provider (`apps/server/src/bots/providers/devinBot/`)**
   - `devinBotDeepLinks.ts`: Constants (`DEVIN_APP_PATH = "/Applications/Devin.app"`, `DEVIN_BUNDLE_ID = "com.exafunction.windsurf"`, `DEVIN_URL_SCHEME = "devin"`) + safe deep-link builders (`devin://app/open/<base64url("/bots/<botId>")>`, `devin://session/<devinId>`, and web fallback `https://app.devin.ai/bots/<botId>`).
   - `DevinBotTransport.ts`: Effect service tag + tagged errors (`DevinBotAppUnavailableError`, `DevinBotLoopbackViolationError`, `DevinBotCdpConnectionError`, `DevinBotCdpProtocolError`, `DevinBotBridgeError`).
   - `devinBotStoreNormalization.ts`: Loopback endpoint/WebSocket validation, `Info.plist` parsing, workbench `page` target scoring (filtering out `devtools://`, `vscode-webview://`, and `WebContentsView` previews), self-contained `Runtime.evaluate` expression builders (duck-typed Fiber lookup; **never** accesses `getToken()` or `window.vscode`), event-to-`BotMessage` normalization, child-session mapping, and inbox-to-`BotPendingRequest` normalization.
   - `DevinBotCdpTransport.ts`: Effect layer mirroring `GrokBotCdpTransport.ts` (reusing `safeWebSocketConstructorLayer`, `redirect: "error"`, single-flight `Semaphore`, exponential reconnect backoff, and `Effect.scope`-bound cleanup). Extract shared low-level CDP socket/JSON-RPC plumbing with `GrokBotCdpTransport` into `apps/server/src/bots/cdp/` if desired.
   - `DevinBotProvider.ts` & `DevinBotAdapter.ts`: Implements `BotProviderAdapter` (`providerId: "devin-bot"`, `addonId: "devin-bot"`, `transport: "local-app-bridge"`, `experimental: true`, `accountScopeId` derived from `orgId` — honoring multi-org isolation):
     - Maps each Devin Bot → `BotIdentity` (`defaultConversationId = bot_id`, sanitized `avatar` or clean-room icon fallback, `officialAppUrl = devin://app/open/...`).
     - Maps Bot's main chat → `BotConversation` (`kind: "direct"`, `conversationId = bot_id`) and its child sessions → `BotConversation` (`kind: "delegated-session"`, `conversationId = "session:" + devin_id`, `parentConversationId = bot_id`).
     - Maps `events/all/{devin_id}` → `BotMessagesPage` (deduplicated by `event_id` & `cognition.ai/clientMessageId` client nonce).
     - Maps `/{org_id}/boards/inbox` + pending access requests → `BotPendingRequest[]` and implements `respondToRequest` (`inbox-resolve`, `/poke/bots/{bot_id}/options/pick`, `/poke/bots/{bot_id}/access-requests/{id}/grant`).
     - Registers in `apps/server/src/bots/registeredProviders.ts`.
3. **Web Settings Card (`apps/web/src/addons/DevinBotAddonSettings.tsx`)**
   - Mirrors `GrokBotAddonSettings.tsx`: debug port input (default `9223`), copyable Terminal launch command, "Test connection" button calling `/api/mattr/addons/reconnect`, explicit notice that `Matter` never quits/launches/restarts `Devin.app`, and a clear **security warning** explaining the local IDE CDP exposure so users opt in intentionally (and prefer ephemeral launch flags over persistent `argv.json`).

### Capability Flags Rollout

| Capability Flag           |     Phase 1 (Read + Tree)     | Phase 2 (+ Bidirectional Chat) | Phase 3 (+ Needs You Inbox) |
| ------------------------- | :---------------------------: | :----------------------------: | :-------------------------: |
| `agentDiscovery`          |            `true`             |             `true`             |           `true`            |
| `avatarMetadata`          |            `true`             |             `true`             |           `true`            |
| `conversationDiscovery`   | `true` (Bot + child sessions) |             `true`             |           `true`            |
| `history`                 |           `"paged"`           |           `"paged"`            |          `"paged"`          |
| `sync` / `activityEvents` |       `"poll"` / `true`       |       `"poll"` / `true`        |      `"poll"` / `true`      |
| `officialAppDeepLink`     |            `true`             |             `true`             |           `true`            |
| `sendMessage` / `cancel`  |       `false` / `false`       |        `true` / `true`         |       `true` / `true`       |
| `creditSpendWarning`      |            `true`             |             `true`             |           `true`            |
| `questions` / `approvals` |       `false` / `false`       |       `false` / `false`        |       `true` / `true`       |
| `streaming`               |            `false`            |  `false` (upgradeable later)   |           `false`           |

### Non-Negotiable Safety Guardrails

1. **Zero process manipulation:** Never kill, quit, launch, or restart `/Applications/Devin.app` or edit `~/.devin/argv.json`.
2. **Zero credential handling:** Never read, serialize, return, store, or log `auth.getToken()`, cookies, Keychain entries, or `window.vscode` secrets in CDP expressions or logs.
3. **Strict loopback enforcement:** Reject any non-`127.0.0.1` host or mismatched WebSocket port; set `redirect: "error"` on HTTP `/json` fetches.
4. **Usage/cost confirmation:** Keep `creditSpendWarning: true` so every `sendMessage` requires explicit `confirmUsage` before waking cloud work.
5. **Untrusted content & asset hygiene:** Sanitize all Bot/inbox markdown and avatar images (strict MIME + size caps); never extract or bundle Devin's proprietary `Bot3dCogFace` code, `devin-persona` CSS/SVG keyframes, or `bot-*.png` artwork.
6. **Clean disable lifecycle:** Closing the adapter scope tears down every WebSocket, fiber, and timer immediately with zero residual overhead and without cancelling remote Devin work.

### Effort Estimate

| Phase         | Scope                                                                                                                                                               | Estimate                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Phase 0.5** | Live 15-min CDP probe on `127.0.0.1:9223` (Fiber reachability, payloads, Editor Mode, ACP WS send safety)                                                           | **XS (1–2 hours)**        |
| **Phase 1**   | Contracts, `DevinBotCdpTransport` (or shared CDP helper), Bot discovery, paged chat history, child sessions tree, avatars, deep links, `DevinBotAddonSettings` card | **M (2–3 days)**          |
| **Phase 2**   | Bidirectional `sendMessage` + `creditSpendWarning` + `cancel`/`sleep` + deduplication by `clientMessageId`                                                          | **S–M (1–2 days)**        |
| **Phase 3**   | "Needs you" inbox polling (`listPendingRequests`) + interactive `respondToRequest` (resolve, pick option, grant access)                                             | **M (2 days)**            |
| **Total**     | Full bidirectional Devin Bots bridge                                                                                                                                | **~5–7 engineering days** |

---

## Evidence Classification

- **Verified (Static Read-Only Inspection of `/Applications/Devin.app` v`3.14.30833`):** `Info.plist`, codesign entitlements, Electron `43.8.8` / Chromium `150.0.7871.250`, all 9 Electron Fuses (`EnableNodeCliInspectArguments = ENABLED`), `mainImpl.js` `"remote-debugging-port"` allowlist, unpacked `Resources/app/` layout, embedded `out/vs/workbench/devin-webapp-host/` (1,982 JS chunks mounted in `.devin-app-root`), complete `/poke/*`, `events/all/{devin_id}`, `/{org_id}/boards/inbox`, and `/acp/live` WebSocket architecture, `devin://` deep-link handler (`Uhc()`), and absence of Bot commands in bundled Devin CLI (`devin/bin/devin`).
- **Unverified (Requires Phase 0.5 Live Probe):** Runtime React Fiber property layout on `.devin-app-root`, behavior when `Devin.app` is switched to Editor Mode, exact live JSON schemas of `/poke/bots` and `/boards/inbox`, and whether sending `session/prompt` over `/acp/live` for a background Bot can run without disrupting an active tab's WebSocket subscription.
