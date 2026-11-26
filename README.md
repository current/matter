<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./matter/readme/matter-mark-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./matter/readme/matter-mark-light.svg" />
    <img src="./matter/readme/matter-mark-dark.svg" width="44" height="50" alt="Matter" />
  </picture>
</p>

<h1 align="center">Matter</h1>

<p align="center">
  a personal fork of t3 code, stripped of telemetry and rebuilt around native macOS craft, modular add-ons, and hands-free voice.
</p>

<p align="center">
  <a href="https://github.com/current/matter/releases">releases</a> ·
  <a href="https://github.com/pingdotgg/t3code">upstream</a> ·
  <a href="./docs/README.md">docs</a> ·
  <a href="./matter/CONTEXT.md">fork notes</a> ·
  <a href="./LICENSE">mit</a>
</p>

<p align="center">
  <img src="./matter/readme/hero-shell.png" width="100%" alt="Matter macOS shell with 38pt frameless topbar, liquid-glass material, Arc-style film grain, inset dark card, SF Symbols, and notch Dynamic Island" />
</p>

Matter tracks [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) nightly and runs your local coding agents (claude code, codex, cursor, opencode, grok build, antigravity, kiro, pi, muse code, fx, and any [ACP](./docs/user/providers-acp.md) agent) inside one fast, native-feeling workspace across desktop, web, and iOS.

## what's different from upstream

### macOS shell & customization

- **38pt frameless window** — browser-style outer frame with optically aligned macOS traffic lights, an inset dark page card directly below the topbar, and a transparent sidebar with zero seam.
- **shell materials, color & film grain** — native `NSGlassEffectView` `liquid-glass` (regular or clear), adjustable `blur`, `transparent`, and `solid` materials with a transparency slider, an arc-style shell color (presets or any custom color, fitted to light and dark), and monochrome svg film grain (`0–100%`) across the outer frame and sidebar.
- **solid icon packs** — filled SF Symbols by default (extracted on the build Mac via Swift, zero Apple glyphs committed), or switch live in settings → appearance to solar, phosphor, heroicons, remix, mingcute, fluent, ionicons, material, tabler, hugeicons or lucide.
- **streaming text animation** — pick how assistant replies arrive in settings → appearance: instant, blur reveal with a riding caret, soft fade, rise & settle, smooth pace, or rareui's burst reveal; each word animates once, and finished messages render exactly as upstream.
- **ai status** — settings → appearance → ai status swaps the working timer for an animated status that names what the agent is doing (thinking, searching, editing, running a command, writing, needs your input), adapted from rareui; it stops the moment the turn ends.
- **Matter sidebar** — project-grouped threads with nested subagent trees, a needs-you filter, crew, and live usage meters; spaces, timeline (threads by day with branch, pr and running subagents) and classic layouts stay one click away, and settings render in-card instead of a modal.
- **tasks** — a to-do list and kanban board (sidebar, command palette, `/tasks`) where tab hands a task to a real agent thread: pick provider, model, effort, project and local or worktree, press start, and the task follows the thread live.

### zero outbound telemetry

- PostHog (`ingest.t3.codes`), Axiom relay OTLP tracing, and mobile `expo-observe` crash reporting are hard-disabled across server, web, desktop, and mobile.
- `Matter connect` relay, local logs, resource monitoring, and any user-configured OTLP export remain intact.

### dynamic island & hands-free voice

- **macOS notch pill** — floating Dynamic Island for live thread state, quick approvals, and hands-free voice control.
- **Lilt GLSL Siri Wave** — 1:1 WebGL shaders across the notch pill, composer waveform, and in-thread voice mode.
- **low-latency voice pipeline** — Deepgram Flux streaming STT, ElevenLabs `eleven_v4_turbo` streaming sentence TTS with full voice tuning, and speech-verified barge-in.
- **workspace brain & in-thread voice mode** — server-hydrated workspace Q&A and codebase research, plus a ChatGPT-style in-thread voice mode on desktop and iOS.

### modular add-ons

every optional integration is **off by default** in settings → add-ons. disabled add-ons render no UI, run no background work, and add zero MCP tokens to agent context.

<p align="center">
  <img src="./matter/readme/addons-voice.png" width="100%" alt="Matter modular off-by-default add-ons alongside the in-thread voice mode with Lilt GLSL Siri Wave" />
</p>

| add-on            | transport / runtime        | what it adds                                                                      |
| ----------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `grok bot`        | loopback CDP (`:9222`)     | chat with local Grok Bot teammates in the sidebar with character silhouettes      |
| `devin bot`       | loopback CDP (`:9223`)     | v3 messages and "needs you" inbox tickets surfaced as pending requests            |
| `claude cloud`    | `claude` CLI + opt-in MCP  | offload heavy work to Claude Cloud VMs, send follow-ups, and `--teleport` locally |
| `voice assistant` | local server + notch / web | hands-free summaries, agent steering, workspace Q&A, and in-thread voice mode     |

### fork extras

- **account fallback with exclusions** — automatically switches to another account with usage left when one runs out, with per-account exclusions (`fallbackExcludedInstanceIds`).
- **multi-provider delegation** — when you ask for subagents or parallel work, agents spread the children across every signed-in subscription, favoring whichever has the most usage left; on by default, with a delegation pool you can trim in settings → threads.
- **redesigned composer** — the prompt card sits in a shelf with the project, workspace and branch underneath; permissions on the left, a red send circle on the right.
- **in-chat replies** — reply directly to any user or assistant message from its hover bar; an in-card reply banner shows who you are replying to (esc cancels when empty), and sent replies render a clickable reference header that jumps back and highlights the original message.
- **questions & plan overview cards** — agent questions arrive as a lettered card (press a–i or 1–9, type "something else" inline, step back and forth), and proposed plans as an overview with a to-do list, view plan and one-click approve, with an opt-in 30s auto-approve.
- **composer predictions** — after each turn, the empty composer offers your likely next message in your own voice, for every provider; tab or → fills it in.
- **stalled turn flags** — flags running turns with no agent activity for 10 minutes.
- **multi-project delegation** — delegate tasks across local projects from one thread.
- **phone pairing & iOS sideloading** — Tailscale HTTPS pairing links serve Matter's bundled web UI and installable PWA directly; free Apple ID iOS builds work out of the box via `T3CODE_IOS_PERSONAL_TEAM=1`.
- **automatic upstream nightly merges** — CI merges the newest upstream nightly tag into every macOS arm64 prerelease and re-signs with the fork's certificate.
- **`matter.json` project config** — reads `matter.json` first and falls back to upstream's `t3.json`.

## install & build

### prebuilt macOS releases

download the latest signed macOS arm64 build from [GitHub Releases](https://github.com/current/matter/releases). installed builds pick up new CI prereleases through the in-app updater.

### local development

```bash
vp i
vp run dev:desktop
```

runs a separate **Matter (Dev)** window beside any installed app with isolated dev state (`~/.antimatter/dev`) and hot-reloading web UI.

### local signed build & install

```bash
node matter/ship-local.mjs --install
```

merges the newest upstream nightly in a separate build checkout (`../matter-ship`), builds and signs with `~/.antimatter-signing`, replaces `/Applications/Matter.app`, and reopens it. omit `--install` to build without replacing the running app.

### live UI hot-reload

```bash
node matter/live-ui.mjs
```

serves renderer changes on `127.0.0.1:5799` so pressing `Cmd+R` in the installed Matter window reloads the UI without interrupting running chats in the backend process.

### iOS personal-team sideloading

```bash
T3CODE_IOS_PERSONAL_TEAM=1 vp run mobile:install ios
```

defaults the bundle id to `com.current.antimatter.mobile`, strips paid-only entitlements (`aps-environment`, associated domains, OTA updates), and signs with a free Apple ID personal team (override `T3CODE_IOS_APPLE_TEAM_ID` and `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID` as needed).

## credits & license

Matter is an unofficial personal fork built on [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). it is not affiliated with or endorsed by T3 Tools, Inc.

source code is licensed under the [MIT License](./LICENSE). T3 Tools, Inc.'s trademarks and branding are not covered by the MIT license — see [TRADEMARK.md](./TRADEMARK.md).
