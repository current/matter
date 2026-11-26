# Persistent agent provider landscape (Phase 0)

Research only, as of 2026-11-25. This is spec §17: a brief, high-signal survey to guide the shared Bots Platform. Nothing here is a commitment to build. Grok Bot and Devin Bots have their own reports (sibling research branches). Muse is in [muse-integration.md](muse-integration.md).

Tiers: **[O]** official docs or source, **[C]** community, **[U]** unverified. Nothing was live-tested.

## Integration kinds (the distinction that matters)

| Kind | Meaning | Fit for "connect the agent the user already has" |
|---|---|---|
| **A. Existing personal agent** | The user's own long-lived agent: memory, history and tools live with the provider. We attach to it | Primary target |
| **B. API-managed agent** | Agents created and owned through an API. Persistent, but usually made *for* an app | Good when the user already created agents there |
| **C. Model API** | Stateless inference | Out of scope for Bots |
| **D. Coding session** | One-off task or session runs (Devin sessions, Muse Code, Codex) | Already covered by mattr's provider/thread model, not Bots |

## Summary

| Provider | Kind | Official surface | Feasibility |
|---|---|---|---|
| **OpenClaw** | A, self-hosted | Gateway WebSocket protocol (documented, typed schemas) | **High**: best-documented, built for third-party operator clients |
| **Hermes Agent** | A, self-hosted | TUI gateway JSON-RPC (WS), ACP, OpenAI-compatible API server | **High**: rich session protocol, approvals as server→client requests |
| **Zo Computer** | A, hosted | `POST /zo/ask` (+SSE), MCP server | **Medium**: send and stream only. No conversation list or history API |
| **Letta** | B (and A for Letta-app users) | REST + SDKs (agents, conversations, messages, streams) | **High** technically, but agents are usually app-created |
| **Manus** | A/B hybrid, hosted | REST v2 (tasks, agents, webhooks, OAuth2 Open Apps) | **Medium-high**: task-oriented, polling or webhooks, no streaming |
| **Muse** | A, hosted | Gadget Link API only (device channel) | **Low-medium**: see the Muse report |

## OpenClaw

- **What:** open-source personal agent. A user-run **Gateway** (default `127.0.0.1:18789`) owns sessions, channels (chat apps), nodes (devices) and approvals. [O] [docs](https://docs.openclaw.ai/gateway/protocol), [repo](https://github.com/openclaw/openclaw)
- **API:** WebSocket text frames with JSON. The first frame is `connect`, which declares a role (`operator` | `node`) and scopes. Schemas are TypeBox in `packages/gateway-protocol/src/schema.ts`, with protocol version constants and an N-1 window. [O]
- **Discovery:** `sessions.list` / `sessions.subscribe` (snapshot plus `sessions.changed`), `sessions.describe/get/resolve/create/patch/reset/delete`. Agents exist as an `agentId` parameter and `agents.defaults.*` config. **No `agents.list` RPC documented** [O]. Multi-agent listing is [U].
- **History / messaging / streaming:** `chat.history` (with a `deltaCursor` catch-up), `chat.send` (attachments included), `chat.abort`, `chat.steerNow`. Live `session.message` events, and `session.approval` lifecycle events for exec approvals. Files go through `sessions.files.*`. [O]
- **Auth:** gateway token or password (`gateway.auth.mode`), then **device pairing** that returns a scoped `deviceToken` (rotate and revoke supported). One-paste setup links carry a single-use bootstrap token and a TLS pin. Tailscale identity is optional. [O] [auth](https://docs.openclaw.ai/gateway/protocol/auth), [pairing](https://docs.openclaw.ai/gateway/pairing), [tailscale](https://docs.openclaw.ai/gateway/tailscale)
- **Execution:** the user's machine or server. **Billing:** the user's own model keys or subscriptions. No OpenClaw billing.
- **Feasibility:** high. mattr would be an `operator` client. Matching remote modes (loopback, tailnet) mirror mattr's own. Main risk: a fast-moving protocol, so pin to the versioning window.

## Hermes Agent (Nous Research)

- **What:** open-source self-improving personal agent with a gateway for messaging platforms, profiles and subagents. [O] [docs](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- **API, three wire formats on one core:** (1) **ACP** over stdio (mattr already speaks ACP, but that is a session-per-process model). (2) **TUI gateway JSON-RPC** over stdio, its own WS, or the shared gateway `/api/ws` (`hermes-gateway-v1`). (3) **OpenAI-compatible API server** (`:8642/v1`: chat completions, responses, `/v1/runs` with events, approval and steer, `/api/sessions/{id}/chat/stream`). [O]
- **Discovery / history:** `session.list` (with stored scope, query and cursor), `session.resume` (multiple subscribers allowed), `session.history` / `session.transcript` (paged), `profiles.list`, `subagent.list`. `agents.list` is refused. [O]
- **Streaming / interaction:** `prompt.submit`, `session.steer/interrupt`, `prompt.cancel`. Events `message.delta/complete`, `tool.start/complete`, with `inflight` to rebuild on reconnect. **Approvals, clarify and secret requests come as server→client JSON-RPC requests** (opt-in via `client.capabilities {server_requests:true}`). Open requests are replayed on reconnect. [O]
- **Auth:** a single-use ticket per connection from `hermes gateway attach --json`. The API server uses a bearer key. [O]
- **Execution:** user host (Docker or bare metal; also runs on Zo [O](https://www.zo.computer/tutorials/how-to-run-hermes-agent-on-zo)). **Billing:** the user's model provider.
- **Feasibility:** high, and the richest interaction model (approvals, questions, steer, subagents). The best stress test for the platform's interaction capabilities.

## Zo Computer

- **What:** hosted personal cloud computer with an AI ("your Zo") that has files, integrations and personas. [O] [API](https://docs.zocomputer.com/api), [MCP](https://docs.zocomputer.com/mcp-server)
- **API:** `POST https://api.zo.computer/zo/ask` with `input`, optional `conversation_id`, `model_name` (or `auto`), `persona_id`, `output_format`, `stream`. SSE events are `FrontendModelResponse`, `End`, `Error`. The `x-conversation-id` header continues a thread. Also `GET /models/available` and `/personas/available`. [O]
- **Discovery / history:** **No conversation list or history endpoint documented** [O, absence]. Personas are the closest thing to "agents" (one Zo, several personas).
- **Auth:** a `zo_sk_` bearer key from Settings → Advanced, with **full account access**. [O]
- **Execution:** Zo's hosted server. **Billing:** the user's Zo plan [U on exact metering]. There is a user-set `/zo/ask` concurrency limit.
- **Feasibility:** medium. Send and stream into new or known conversations works. Showing existing Zo chats does not. Same registry pattern as Muse.

## Letta

- **What:** stateful agents platform (formerly MemGPT). Cloud (`api.letta.com/v1`) or self-hosted. Memory blocks are shared across an agent's conversations. [O] [conversations](https://docs.letta.com/guides/core-concepts/messages/conversations)
- **API / SDK:** REST, `@letta-ai/letta-client` (TS), `letta_client` (Py). [O]
- **Discovery / history:** list agents, `GET /v1/conversations` (per agent), `GET /v1/conversations/{id}/messages` (cursor paging; `"default"` is the agent's default conversation), `GET /v1/messages` across agents. [O] [list conversations](https://docs.letta.com/api/resources/conversations/methods/list)
- **Messaging / streaming:** `POST /v1/conversations/{id}/messages` and `/stream` (SSE). Runs API for run status and streams. [O]
- **Auth:** API key (cloud) or self-hosted server credentials. **Billing:** Letta Cloud plan or usage, or the user's own model keys when self-hosted [U on exact plans].
- **Feasibility:** high, with a clean agent → conversations model. But most Letta agents are app-created (kind B). Valuable mainly to users who already live in Letta's ADE or apps.

## Manus

- **What:** hosted autonomous agent, task-oriented, with custom agents, projects, skills, connectors and cloud browsers. [O] [API index](https://open.manus.ai/docs/llms.txt)
- **API:** REST v2 (v1 deprecated): `task.create/list/detail/sendMessage/listMessages/stop/confirmAction`, `agent.list/detail/update`, `project.*`, `file.upload`, `artifact.list`, `webhook.*`, `usage.*`. [O] [task.sendMessage](https://open.manus.ai/docs/v2/task.sendMessage)
- **Discovery / history:** `agent.list` (custom agents, with nickname and description), `task.list` (scope `agent_subtask` per `agent_id`), `task.listMessages` (event messages, cursor). Sending to an agent's own task (`agent-default-main_task`, per search summary) is [U]; `agent.detail` says each agent has an "associated task" [O].
- **Streaming:** **none**. Use polling of `task.listMessages` or signed webhooks (task created, stopped, ask). Questions arrive as `stop_reason: "ask"` and are answered with `task.sendMessage`. Action confirmations go through `task.confirmAction`. [O]
- **Auth:** API key (`x-manus-api-key`) or **OAuth2 Open Apps** acting for users. [O]
- **Billing:** the user's Manus credits (`usage.availableCredits` reports the plan balance) [O, metering per task U].
- **Feasibility:** medium-high. Discovery and history are real, OAuth exists, but it needs a poll/webhook transport and a task-shaped UI.

## Other emerging (not researched; mentioned only)

- OpenAI "Dots" and Anthropic "Duet" are always-on proactive agents named in [Devin Bots launch coverage](https://dataconomy.com/2026/11/18/cognition-launches-devin-bots-to-manage-ai-coding-teams/) [U]. Track them for public APIs.

## Takeaways for Phase 1

1. Self-hosted agents (OpenClaw, Hermes) have the **best official external protocols**. Hosted consumer agents (Muse, Grok Bot, Zo) have the weakest.
2. Conversation discovery is missing for Muse and Zo, so the platform needs a **local known-conversations registry**.
3. Streaming varies: WS events (OpenClaw, Hermes, Muse Link), SSE (Zo, Letta), poll/webhook only (Manus). The provider transport must normalize to one event stream with a polling fallback.
4. Approvals and questions are first-class in Hermes, OpenClaw and Manus. Design the interaction capability around server-initiated requests that survive reconnects.
5. None of these reuses mattr's coding-provider runtime. Keep Bots a separate platform. Coding sessions (kind D) stay as threads.
