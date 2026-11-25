# Devin Bots integration research (Phase 0)

Status: research only. Nothing here is implemented. Researched 2026-11-25 against docs.devin.ai (v3 OpenAPI `3.0.0`, 192 paths), devin.ai, and GitHub. Nothing was tested against a live Devin account.

## Bottom line

Devin Bots (launched 2026-11-17) have **no public API, SDK, MCP tool or webhook**. The v3 OpenAPI spec has no Bot paths, and the official Devin MCP server has no Bot tools. A Bot can be reached only through the Devin web app, its own Slack app, or iMessage.

The documented **Sessions API** covers the coding sessions a Bot starts. Each session carries `parent_session_id`, `child_session_ids`, `status_detail` and `origin`, and you can read its messages and attachments and send it messages. A Bot's own chat also appears to be backed by a session (the docs' **Recycle** action "terminates the Bot's current session"). Whether that session is visible to the API, and how to tell it apart from other sessions, is **unverified**.

**Recommendation:** don't build a Devin Bots provider yet. If we need something before Cognition ships a Bots API, the only defensible option is a read-mostly **"Bot as session tree" observer** behind an experimental flag, fed by the Sessions API, with a link-out to the Bot's web chat. Step 1 below is a 1–2 hour live probe that decides whether even that works.

## Bots vs. sessions (don't conflate)

| | Devin Bot | Devin session |
| - | - | - |
| Lifetime | Persistent; one chat for everything it owns; keeps memory across sessions | One task; ends or sleeps |
| Identity | Name, avatar (Gallery view), optional own Slack app/handle, PR signature banner | Title, tags, `user_id`/`service_user_id` |
| Access | Holds its own grants (MCP sign-ins, secrets, sessions, other Bots); shared with Can use / Can configure / Can share | Runs as its creator / service user |
| Work | Starts and monitors child sessions ("managed Devins"), runs automations, keeps a "Needs you" inbox | Does the work itself; can start managed child sessions |
| API | **None** | Full v3 REST + MCP + TS/Python SDK |

Source: [Bots docs](https://docs.devin.ai/work-with-devin/bots), [Access and security](https://docs.devin.ai/work-with-devin/bots/access-and-security.md), [Advanced capabilities: Managed Devins](https://docs.devin.ai/work-with-devin/advanced-capabilities.md).

## Capability findings

Legend: **V** = verified in official docs/spec · **C** = shown by a community project · **U** = unverified assumption · **X** = unsupported / confirmed absent. **Live-tested: none.**

| Capability (spec §15) | Status | Evidence / route |
| - | - | - |
| Discover existing Bots | **X** (API) | No `bots` path in [v3 OpenAPI](https://docs.devin.ai/v3-openapi.yaml). Web UI only: All Bots page (Personal / Team's Bots / Archived). C: `/v3/organizations/{org}/bots` → 404; `/v1/bots`, `/v3/bots` → 401 with both `cog_` and `apk_` keys ([devin-android#25](https://github.com/Blazikener/devin-android/pull/25)). |
| Bot identity, name, avatar | **X** (API) | Name and avatar shown in the web Gallery view. C: Bot URL format `app.devin.ai/bots/<32-hex id>` (seen in PR banners). No documented avatar asset. |
| Discover conversations | **X** for Bot chat; **V** for sessions | A Bot has exactly **one** chat (V). Sessions: `GET /v3/organizations/{org}/sessions` with filters `parent_session_id`, `origins`, `tags`, `playbook_id`, `is_archived`. |
| Load Bot chat history | **U** | Messages flow between web, Slack and iMessage (V). If the Bot's backing session is listed, `GET …/sessions/{id}/messages` (cursor-paged; `source: devin \| user`, `origin`, `username`) might return it. Not tested. |
| Send message directly to a Bot | **X** (API); **U** via session | Official paths: web chat, Bot Slack app (DM / @-mention), iMessage. Sending `POST …/sessions/{id}/messages` to the Bot's backing session is unsupported and untested; it could also hit a session that **Recycle** has since replaced. |
| Streaming responses | **X** for Bots; **V** for sessions (SDK) | `@cognition-ai/sdk` streams typed `SessionEvent`s (message, thought, tool call, plan) for cloud sessions ([streaming guide](https://docs.devin.ai/sdk/guides/streaming-events.md)). The SDK is beta, published as `0.0.x`, pinned per release. REST has no SSE/WebSocket; the PAT docs mention an "ACP live WebSocket" without publishing its contract. |
| Activity events | **V** (sessions, poll) | `status` + `status_detail` (`working`, `waiting_for_user`, `waiting_for_approval`, `finished`, suspend reasons); MCP `devin_session_events` / `devin_session_gather`. No outbound webhooks/callbacks (X). The only push is Automations' **Email notification** action. |
| Observe delegated sessions | **V** (sessions); **U** (Bot linkage) | `parent_session_id` / `child_session_ids` / `pull_requests` / `acus_consumed` on every session. No `bot_id` field. Linking Bot → children depends on the Bot's backing session ID being visible (U). |
| Approvals / interactive questions | **X** for "Needs you" items | Decisions, PR review/merge, permission requests and grant cards exist only in the web UI and Slack buttons. Sessions expose `waiting_for_user` / `waiting_for_approval` but no approve endpoint; answering means sending a message. |
| Attachments / artifacts | **V** (sessions) | `GET …/sessions/{id}/attachments`, `POST/GET …/attachments`; PRs on the session object. |
| Bot configuration (instructions, memory, connections, sharing, Slack, usage limit, automations) | **X** (API) | Web settings only. Automations the Bot creates are org automations and may appear in `/automations` (U). |
| Create / archive / delete Bots | **X** (API) | Web UI only. |
| Auth with existing Devin account | **V** for sessions | `cog_` PAT (acts as you; enterprise policy may disable PATs) or service user (RBAC; needs `ViewOrgSessions`, plus `ManageOrgSessions`-type permissions to message). No OAuth / "Sign in with Devin" for third parties (X). Web-cookie reuse is unsupported (C: the WebView fallback in devin-android#25 rendered blank at `/auth/login`). |
| Voice / phone calls | **X** (API) | The marketing page says "call them". No developer surface. |

## Alternative paths evaluated

1. **Bot's own Slack app (official, bidirectional for humans).** Each Bot can get its own Slack app and handle. It replies in-thread; "Who can message" ranges from *People with access* to *Anyone in Slack*. The docs show no other Slack bot/app messaging a Bot, and Slack bot-to-bot messages are usually filtered. A mattr bridge would therefore need a **user** Slack token posting as the human, plus Events API / RTM reading of the Bot's replies. That is Slack-ToS sensitive, fragile, depends on a Slack workspace, and is out of character for mattr. **Not recommended** except as a manual link-out ("Open in Slack"). [Slack docs](https://docs.devin.ai/work-with-devin/bots/slack.md)
2. **iMessage.** One Bot per linked number; not on Enterprise. No integration surface. X.
3. **Devin MCP server** (`https://mcp.devin.ai/mcp`, Streamable HTTP, `cog_` bearer + `X-Org-Id`): sessions, playbooks, knowledge, schedules, automations, users. **No Bot tools.** Useful as a session observer for agents, not for Bots. [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp.md)
4. **Webhooks / Automations.** Inbound only. A webhook trigger can **start a session** or **message an existing session**. Bots create automations from chat. Whether an automation can target a Bot's chat is not documented (U). No outbound event webhooks (X).
5. **Desktop / CLI / ACP.** Devin Desktop's Agent Command Center and `devin acp` run local agents and cloud *sessions*. Neither mentions Bots. Note that Orca's "Devin bots" ([orca#46878](https://github.com/stablyai/orca/pull/46878)) are **Orca's own bots running on the Devin CLI over ACP**, not Devin Bots. mattr could ship the same thing as an ordinary Devin *provider*, which is a separate decision from Devin Bots.
6. **Session API as complement.** This works well for the hierarchy *under* a Bot, if we can find the root. See the probe below.

## Community resources

| Project | What it shows | Bot access? |
| - | - | - |
| [Blazikener/devin-android#25](https://github.com/Blazikener/devin-android/pull/25) (open, parked, 2026-11-18) | Probed for Bot endpoints: none usable with API keys; WebView fallback fails at login | Confirms absence |
| [Till3005/built-with-devin](https://github.com/Till3005/built-with-devin) | Registry of Bot deployments and Devin tooling | No Bot client listed |
| [stablyai/orca#46878](https://github.com/stablyai/orca/pull/46878) (merged 2026-11-22) | Devin CLI as an ACP agent in a third-party chat UI; Devin ignores session `mcpServers` | Not Devin Bots |
| [wgtechlabs/devin-discord-bot](https://github.com/wgtechlabs/devin-discord-bot), [devin-telegram-bot](https://github.com/wgtechlabs/devin-telegram-bot), [openabdev/openab](https://github.com/openabdev/openab) | Chat bridges to Devin sessions / `devin acp` | Sessions only |
| [simstudioai/sim `tools/devin`](https://github.com/simstudioai/sim/tree/main/apps/sim/tools/devin), [jsklan/devin-api-mcp](https://github.com/jsklan/devin-api-mcp), [gassara-kys/go-devin](https://github.com/gassara-kys/go-devin) | v1/v3 session clients | Sessions only |
| Official: [`@cognition-ai/sdk`](https://docs.devin.ai/sdk) (beta), Python `devinai`, [terraform-provider-devin](https://github.com/CognitionAI/terraform-provider-devin) | Session create, stream, manage | No Bot resources |

No community project has direct, programmatic access to persistent Bots.

## Auth, plans and cost

- **Plans** ([pricing](https://devin.ai/pricing), [self-serve](https://docs.devin.ai/admin/billing/self-serve.md)): Bots are on **Max ($200/mo), Teams ($80/mo flat, shared on-demand credits), Enterprise**. They are not listed on Free or Pro.
- **Billing** ([usage limits](https://docs.devin.ai/work-with-devin/bots/usage-limits.md)): a Bot's chat **plus every session it starts** bills to the **creator** (Max: quota, then on-demand; Teams: creator quota, then team credits, with an optional per-Bot $ cap; Enterprise: creator's ACU/$ limit, or a separate one).
- **Extra cost from mattr:** reading via the API (list/get/messages) has no documented charge. **Sending a message wakes the session** ("automatically resumed if suspended"), and that consumes ACUs or credits. Polling has no listed price but is rate-limited (`429`). Any mattr write path needs explicit user intent and a cost warning.
- **Auth:** PAT (`cog_`, user-scoped, names the org per request) is the right fit for a personal client. Enterprise PAT policy defaults to **Disabled**. Store it like other provider secrets. Never use web cookies.

## Conversation sync and real-time feasibility

- **Bot chat ↔ mattr:** not feasible on a supported path. At most read-only, conditional on the probe.
- **Child sessions ↔ mattr:** feasible. Poll `GET /sessions?parent_session_id=…` and `/sessions/{id}/messages` with a cursor; use the SDK's event stream for any session the user opens live (beta, version-pinned). Poll adaptively (e.g. 15–60 s idle, faster while a session is `working`), only while the Bots add-on is enabled and visible.
- **"Needs you" inbox:** not syncable. The nearest proxy is child sessions whose `status_detail ∈ {waiting_for_user, waiting_for_approval}`, which misses Bot-level decisions and permission cards.

## Security and authorization concerns

- **Access passes through a Bot.** Anyone who can use a Bot can use every grant it holds (sign-ins, secrets, other Bots). A mattr UI that lets a user message a shared Bot inherits that blast radius.
- **Prompt injection.** Bots can accept messages from untrusted Slack users. Treat all Bot/session text as untrusted in mattr (no auto-actions, no tool execution from Bot output, sanitized markdown).
- **Credential scope.** A PAT acts as the user across **every** org they belong to. Prefer a service user with view-only permissions for observer mode. Never request Manage Bots / Impersonate permissions.
- **Reverse-engineered endpoints** (`/v1/bots` etc. returned 401) are off-limits: unsupported, likely ToS-violating, and they break remote-mode guarantees.
- Respect the per-Bot privacy model. A private Bot's sessions may be visible to an org admin via the API with `ViewOrgSessions` even though the Bot itself is private. Filter to the token owner's `user_id` by default.

## Recommended approach and complexity

1. **Live probe (S, ~1–2 h, needs a Max/Teams account and a PAT; nobody has done this yet).** With one Bot that has run work:
   - `GET /v3/organizations/{org}/sessions?first=200`: does a session appear for the Bot's chat? Which `origin`? Do its children's `parent_session_id` point to it? Is the 32-hex Bot ID related to any session ID?
   - `GET …/sessions/{botSession}/messages`: does it return the Bot chat (including Slack/iMessage-originated turns)?
   - Does **Recycle** change the backing session ID? Do old children keep the old parent?
   - Do Bot-created automations show in `GET /automations`, and with what target?
   - Record results here, marked "Live-tested".
2. **If the probe succeeds: experimental read-only "Devin Bots (observer)" provider (M, ~3–5 days).** Bot list derived from root sessions; a session tree per Bot; status animation from `status_detail`; PR/attachment chips; "Open Bot in Devin" deep link for chat and approvals. Write capability off.
3. **If the probe fails:** ship nothing Bot-specific. Optionally offer an ordinary **Devin sessions** provider (Sessions API / `devin acp`) as a separate decision. Revisit when Cognition publishes a Bots API (watch [release notes](https://docs.devin.ai/release-notes/overview.md) and the [v3 spec](https://docs.devin.ai/v3-openapi.yaml) for `bots` paths).
4. **Full bidirectional Bot chat (L).** Blocked on Cognition; not estimable.

## Unresolved blockers

1. No Bots API (list, identity, chat, inbox, config). **Blocking for acceptance criteria 6–10 analogues.**
2. Unknown whether a Bot's backing session is API-visible and stable across Recycle.
3. No push events. Polling only, except via the beta SDK stream per session.
4. No approve/decide endpoint for "Needs you" items or grant cards.
5. No avatar or Bot metadata endpoint, so character identity can't be preserved beyond a name we can't fetch.
6. Enterprise PAT policy is disabled by default, so many enterprise users can't authenticate at all.

## Architectural requirements for the shared Bots platform

These come from Devin's model and should hold for any provider (spec §5):

- **Agent ≠ conversation ≠ work unit.** Model `Agent` (persistent identity) → `Conversation` (Devin: exactly one, possibly unreadable) → `WorkItem` tree (delegated sessions with their own status, PRs and cost). Grok-style "one agent, many chats" and Devin-style "one agent, one chat, many sessions" must both fit without empty placeholders.
- **Recursive delegation.** Work items have `parentId`, and agents can delegate to other agents (Bot → Bot grants). The activity UI must render a tree or roll-up, not a flat list.
- **Capability flags per agent *and* per surface**, at least: `agent.discover`, `agent.identity.avatar`, `conversation.read`, `conversation.send`, `conversation.stream`, `workItems.read`, `workItems.message`, `workItems.stream`, `inbox.read`, `inbox.respond`, `config.manage`, `externalLink` (deep link to the official app for anything unsupported). Devin today: `workItems.read` + `externalLink` only (pending the probe).
- **Transport kinds as metadata:** `direct-api`, `session-api-derived`, `chat-bridge` (Slack), `link-out`. Bridged transports stay behind the experimental flag (§24.22).
- **Status vocabulary** that maps Devin's `working / waiting_for_user / waiting_for_approval / finished / suspended(reason)`, so character animations reflect real states and never invented ones.
- **Cost awareness.** Actions that wake remote work carry a `costsUsage` hint, so the UI can confirm before sending.
- **Account isolation.** Provider account = (provider, org, principal). Devin PATs span orgs, so the org is part of the identity.
- **Polling scheduler owned by the platform** (shared backoff, paused while hidden or disabled), so the add-on adds no background load when off (§24.2, §24.21).
- **Untrusted-content boundary.** Remote agent text is rendered, never executed. Cross-feature actions (voice ↔ Bot) go through the shared action layer with explicit permission.

## Sources

Official (accessed 2026-11-25): [devin.ai/bots](https://devin.ai/bots) · [Introducing Devin Bots (2026-11-17)](https://devin.ai/blog/introducing-devin-bots) · [Bots docs](https://docs.devin.ai/work-with-devin/bots) · [All Bots](https://docs.devin.ai/work-with-devin/bots/all-bots.md) · [Access & security](https://docs.devin.ai/work-with-devin/bots/access-and-security.md) · [Connections](https://docs.devin.ai/work-with-devin/bots/connections.md) · [Slack](https://docs.devin.ai/work-with-devin/bots/slack.md) · [iMessage](https://docs.devin.ai/work-with-devin/bots/imessage.md) · [Usage limits](https://docs.devin.ai/work-with-devin/bots/usage-limits.md) · [API overview](https://docs.devin.ai/api-reference/overview) · [v3 OpenAPI](https://docs.devin.ai/v3-openapi.yaml) · [List sessions](https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions.md) · [Session messages](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages.md) · [PATs](https://docs.devin.ai/api-reference/personal-access-tokens.md) · [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp.md) · [Automations](https://docs.devin.ai/product-guides/automations.md) · [SDK](https://docs.devin.ai/sdk) · [Release notes 2026](https://docs.devin.ai/release-notes/2026.md) · [Pricing](https://devin.ai/pricing) · [docs index](https://docs.devin.ai/llms.txt).
Press: [Fortune, 2026-11-17](https://fortune.com/2026/11/17/exclusive-cognition-bets-on-devin-bots-coding-agents-in-challenge-to-anthropics-duet-and-openais-dots/).
