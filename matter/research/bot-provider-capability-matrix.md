# Bot provider capability matrix (initial)

As of 2026-11-25. This guides the Phase 1 shared Bots Platform design (spec §5). Grok Bot and Devin Bots columns are **provisional**: their detailed research lives on the sibling branches `t3/research-grok-bot-integration` and `t3/research-devin-bots`. Where those reports disagree, they win. Other sources: [muse-integration.md](muse-integration.md), [bot-provider-landscape.md](bot-provider-landscape.md).

Legend: ✓ official/documented · ~ partial or workaround · C community or unofficial only · ✗ not available · ? unverified. Nothing was live-tested.

## Identity model

|                                | Grok Bot                                         | Devin Bots                                | Muse                             | OpenClaw                | Hermes               | Zo                 | Letta                             | Manus              |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------- | -------------------------------- | ----------------------- | -------------------- | ------------------ | --------------------------------- | ------------------ |
| Integration kind               | A (existing)                                     | A (existing)                              | A                                | A (self-hosted)         | A (self-hosted)      | A                  | B (A for app users)               | A/B                |
| Agents per account             | Many named Bots (≤50 incl. group chats)          | Many Bots, each with a goal               | **1** (named, avatar)            | Gateway with `agentId`s | Profiles + subagents | 1 Zo, N personas   | Many                              | Many custom agents |
| Agent ↔ conversation           | Bot DMs + group chats (2–6 Bots)                 | Bot ↔ Slack threads; Bot → Devin sessions | 1 agent → main chat + side chats | Agent → sessions        | Profile → sessions   | Zo → conversations | Agent → conversations (+ default) | Agent → tasks      |
| Multi-agent conversations      | ✓ group chats                                    | ~ (Bot leads sessions)                    | ✗                                | ?                       | ~ subagents/groups   | ✗                  | ~ groups                          | ✗                  |
| Client-minted conversation IDs | ?                                                | ?                                         | ✓                                | ✓ `sessions.create`     | ✓ `session.create`   | ~ (omit id)        | ✓ create                          | ✓ `task.create`    |
| Execution                      | xAI cloud computer (shared across a user's Bots) | Cognition cloud                           | Meta per-user VM                 | User host               | User host            | Zo cloud server    | Letta cloud / self-host           | Manus cloud        |

## Operations

| Capability             | Grok Bot                               | Devin Bots                   | Muse                           | OpenClaw             | Hermes                  | Zo               | Letta        | Manus                 |
| ---------------------- | -------------------------------------- | ---------------------------- | ------------------------------ | -------------------- | ----------------------- | ---------------- | ------------ | --------------------- |
| Official external API  | ✗ (app only; C via desktop-app bridge) | ? (session API ✓; Bot API ?) | ~ Gadget Link (device)         | ✓ WS protocol        | ✓ JSON-RPC / ACP / HTTP | ✓ `/zo/ask`, MCP | ✓ REST/SDK   | ✓ REST v2             |
| Agent discovery        | C                                      | ?                            | ✓ (single)                     | ? (`agentId` config) | ✓ `profiles.list`       | ✓ personas       | ✓            | ✓ `agent.list`        |
| Avatar metadata        | C                                      | ? (Slack profile)            | ~ experimental                 | ✗                    | ✗                       | ✗                | ✗            | ✗                     |
| Conversation discovery | C                                      | ? (Slack)                    | ✗ official / C                 | ✓ `sessions.list`    | ✓ `session.list`        | ✗                | ✓            | ✓ `task.list`         |
| History                | C                                      | ?                            | ~ recent only                  | ✓ `chat.history`     | ✓ paged                 | ✗                | ✓ paged      | ✓ `task.listMessages` |
| Send message           | C                                      | ? (Slack ✓)                  | ✓                              | ✓                    | ✓                       | ✓                | ✓            | ✓                     |
| Streaming text         | C                                      | ?                            | ✓ NDJSON                       | ✓ WS                 | ✓ WS/SSE                | ✓ SSE            | ✓ SSE        | ✗ (poll/webhook)      |
| Live activity events   | C                                      | ?                            | ✓ `agent.status`/`task.status` | ✓                    | ✓ tool events           | ✗                | ~ runs       | ~ webhooks            |
| Attachments in         | C                                      | ?                            | ✓ image, WAV                   | ✓ via `chat.send`    | ?                       | ✗                | ?            | ✓ `file.upload`       |
| Artifacts out          | C                                      | ?                            | ✓ presentations, `/fs/read`    | ✓ `sessions.files.*` | ?                       | ✗                | ✗            | ✓ `artifact.list`     |
| Cancel / interrupt     | C                                      | ?                            | ✗                              | ✓ `chat.abort`       | ✓                       | ✗                | ~            | ✓ `task.stop`         |
| Interactive questions  | ?                                      | ✓ (Slack asks)               | ✗ (C widgets)                  | ?                    | ✓ `clarify`             | ✗                | ✗            | ✓ `ask`               |
| Approval requests      | ?                                      | ?                            | ✗ (C `egress.approvals`)       | ✓ `session.approval` | ✓ `approval`            | ✗                | ~ tool rules | ✓ `confirmAction`     |
| Agent create / manage  | C                                      | ?                            | ✗                              | ~ config             | ✓ `profiles.create`     | ✗                | ✓            | ~ (nickname/desc)     |
| Routines / scheduled   | C                                      | ✓ (goals)                    | C (goals, feed)                | ?                    | ✓ jobs                  | ?                | ✗            | ✗                     |
| Computer activity      | ?                                      | ✓ (Devin sessions)           | ~ `browser_task`               | ✓ nodes              | ~ tools                 | ✗                | ✗            | ✓ cloud browser       |
| Voice                  | ✓ (Team Bots in calls)                 | ✗                            | ✓ TTS, realtime                | ✓ (nodes) ?          | ?                       | ✗                | ✗            | ✗                     |

## Auth, billing, transport

|                         | Grok Bot                                           | Devin Bots                    | Muse                                     | OpenClaw                                | Hermes                         | Zo                         | Letta                 | Manus                     |
| ----------------------- | -------------------------------------------------- | ----------------------------- | ---------------------------------------- | --------------------------------------- | ------------------------------ | -------------------------- | --------------------- | ------------------------- |
| Auth                    | Desktop app session (C, debug port)                | Devin API key / Slack OAuth ? | Device pairing (BLE + phone) + SDK token | Gateway token/password + device pairing | Per-connection ticket / bearer | `zo_sk_` key (full access) | API key               | API key / OAuth2 Open App |
| Billing                 | Subscription (SuperGrok, $200/mo, teams $120/seat) | Devin plan ?                  | Muse plan                                | User's model keys                       | User's model keys              | Zo plan                    | Letta plan / own keys | Manus credits             |
| Transport               | Local app IPC (C)                                  | HTTPS + Slack ?               | Noise WS (sidecar)                       | WS JSON                                 | WS JSON-RPC / HTTP+SSE         | HTTPS + SSE                | HTTPS + SSE           | HTTPS + poll/webhook      |
| Distributable in Matter | ✗ (needs a reviewed bridge)                        | ?                             | ✗ (personal only)                        | ✓                                       | ✓                              | ✓ (user key)               | ✓                     | ✓                         |

## Design requirements this implies (Phase 1)

1. **Separate `Agent` from `Conversation`.** Cardinality varies: 1→N (Muse, Zo), N→N with group chats (Grok), agent→tasks (Manus). The sidebar groups conversations under agents and must handle single-agent providers without fake Bots.
2. **Capabilities declared per provider and account**, at the granularity of the rows above. Some are tiered, e.g. `history: none | recent(limit) | paged` and `create: minted | api`. The UI renders only the declared capabilities.
3. **A local known-conversations registry** for providers without discovery (Muse, Zo), keyed `(providerId, accountId, remoteConversationId)`.
4. **One normalized event stream** (message start, delta, done, status, tool/activity, question, approval, error) with per-transport adapters: WS push, SSE, poll/webhook. Reconcile through history after reconnect, since most providers have no replay cursor (Hermes `inflight` and OpenClaw `deltaCursor` are the exceptions).
5. **Server-initiated interactions** (questions, approvals) as durable pending requests that survive reconnects, answered through a provider method.
6. **Message attribution**: `user via Matter`, `user via other client`, `agent`, `other agent` (Grok group chats), `device` (Muse).
7. **Rich outputs** as typed items with a text fallback (Muse presentations, Manus artifacts, OpenClaw files).
8. **Credentials stay on the server** with per-account isolation. Clients never get provider tokens, which preserves remote, relay and tunnel modes.
9. **Experimental transports** (Grok desktop bridge, Muse web gateway) carry an explicit `unsupported/experimental` flag and live in removable modules, separate from official ones.
10. Coding sessions (Devin sessions, Muse Code) stay as Matter provider **threads**. Bots may _link_ to them (Devin Bot → sessions), not absorb them.
