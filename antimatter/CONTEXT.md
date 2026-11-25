# mattr project context

Read this before any task in this repo. It is loaded for every agent through `AGENTS.md`, in the main checkout and in every worktree. Where it differs from upstream's docs, this file wins.

Keep it current: when a task changes a decision, a workflow or the fork's state, update this file in the same commit. Record decisions and rules, not task logs.

## What this is

mattr is Chris's personal fork of T3 Code nightly (`pingdotgg/t3code`). The repo is `current/mattr` (renamed from `current/t3code`; remote `origin`, branch `main`; upstream is remote `upstream`). The fork used to be called Antimatter, so internal names (`antimatter/`, the workflow file, data folders, app id) still say antimatter. The user-facing name is **mattr**, always lowercase.

Upstream's `AGENTS.md` and `docs/internals/` still apply to the code itself.

## Fork rules

- Keep fork changes small and in fork-only files (`antimatter/`) where possible. CI merges the newest upstream nightly at every build, so edits inside busy upstream files become merge conflicts.
- Don't merge upstream into `main` by hand unless a build opens an "Antimatter: merge conflict" issue.
- Commit and push finished work to `main` yourself; don't ask Chris first. Run `vp run check:changed` before pushing; land worktree branches as described under Working in parallel. Only the lead pushes; workers never do. Every push that changes more than Markdown builds and publishes a release.
- Never create a new repo named `current/t3code`: installed builds from before the rename find updates through GitHub's redirect from that name.
- Never write to `~/.antimatter/userdata`: it is the live app's database, and the chat you are running in lives there.

## Branding

- Copy: `antimatter/rebrand.ts` rewrites "T3 Code" → "mattr", "T3 Connect" → "mattr Connect", standalone app-level "T3" phrases ("T3 thread(s)", "T3 server", "T3 desktop", "T3 home", "T3 process", "T3 tool", "T3%20Code", etc., keeping external third-party names like "T3 Code for GitHub" and "T3 Chat" intact), and thread lifecycle terminology (upstream's thread "Archive" → "Hide"/"Hidden", upstream's "Settle" → "Archive"/"Archived", leaving ZIP and project archives intact) at build time in the web bundle (`apps/web/src`, `packages/*/src`) and in the desktop app's `msg()` dialog copy and i18n catalogs, plus runtime server error strings via `packages/client-runtime/src/errors/translatable.ts`. Don't hand-edit upstream strings; extend the plugin instead. Tests skip it (`VITEST`), so tests keep asserting upstream English.
- Archive/Hidden icons: Archive (formerly Settle) uses `ArchiveIcon` (`archivebox`) / `"archive"` in `SidebarThreadRow.tsx`, `useThreadLifecycle.tsx`, and `threadActionMenu.logic.ts` (Unarchive uses `Undo2Icon` / `"undo"`). Hidden (formerly Archive) uses `EyeOffIcon` / `EyeIcon` / `"eye-off"` in `threadActionMenu.logic.ts`, `SettingsSidebarNav.tsx`, and `ArchivedThreadsPanel.tsx`.
- Name constants: `apps/web/src/branding.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`, sidebar wordmark in `apps/web/src/components/sidebar/SidebarChrome.tsx`, product/artifact name in `scripts/build-desktop-artifact.ts`, DMG name in `antimatter/sign-mac-release.mjs`.
- The "star T3 Code on GitHub" prompt is off (`apps/web/src/components/GitHubStarPrompt.tsx`).
- Logo & favicons: `apps/web/src/components/T3Wordmark.tsx` renders the mattr logo. App icon: `assets/nightly/app-icon.icon` and `assets/nightly/nightly-web-*`. Web public favicons (`apps/web/public/{favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png,icon-192x192.png,icon-512x512.png}`) and standalone server HTML pages (`apps/server/src/cloud/cliAuthHtml.ts`, `apps/server/src/auth/mcpOAuthHtml.ts`, `apps/server/src/httpResponseErrorGuard.ts`) all use the mattr icon.
- Keep as is (renaming breaks data, updates or interop): app id `com.current.antimatter`, `~/.antimatter` and `~/Library/Application Support/antimatter`, the signing certificate, the `t3` CLI, `t3code://`, `t3.codes` URLs, the "T3 Code for GitHub" app name.
- Shell: the window is a browser-style frame. Its 38pt top row holds the traffic lights (moved 1pt optically below center in `apps/desktop/src/window/DesktopWindow.ts` and `preload.ts`, matched by `translate: 0 1px` on topbar items in `antimatter/shell.css`, so the visible gaps below macOS's 1pt top rim and above the dark card match), the sidebar's titlebar row (toggle, wordmark, back/forward) whether the sidebar is open or closed, and the active page's header (`No project / New thread`, etc.) plus the right-side panel controls (`details`, `terminal`, `preview`); the rounded inset page card sits directly below that 38pt shell topbar, and the sidebar only takes space from the left, sliding open and closed whatever upstream's panel animation setting says. The top row shows no environment artwork. Settings → Appearance exposes **Shell material** (`solid`, `transparent`, `blur`, `liquid-glass` via native macOS `NSGlassEffectView` / `setVibrancy` in `apps/desktop/src/window/MattrShellMaterial.ts`) and **Shell grain** (`0–100%` monochrome Arc-style SVG film grain baked into the outer shell background via `apps/web/src/mattrShellAppearance.ts`). Styles live in `antimatter/shell.css` (loaded by `antimatter/shell.ts`); settings UI lives in `apps/web/src/components/settings/MattrShellAppearanceSettings.tsx`; the closed-sidebar row is `apps/web/src/components/sidebar/MattrCollapsedSidebarHeader.tsx`, mounted with one line in `AppSidebarLayout.tsx` before `SidebarControl` (Electron applies drag regions in DOM order, so it must come first or the toggle stops working).
- Icons: SF Symbols replace lucide-react at build time (`antimatter/icons/`). The Vite plugin renders the mapped symbols from the build Mac with Swift (`extract-sf-symbols.swift`), caches them in Vite's cache dir, and serves a stand-in `lucide-react` module to app code. Apple's glyphs are never committed. Off macOS or without Swift, the app keeps lucide. Change the mapping in `sf-symbol-map.ts`; the project-icon picker (`lucideIconByName.ts`) stays lucide on purpose.
- Project file: `mattr.json` (`T3_PROJECT_FILE_NAME` in `packages/contracts/src/t3ProjectFile.ts`). A project without one still uses upstream's `t3.json`: server reads go through `apps/server/src/project/MattrProjectFile.ts`, and the rebrand plugin renames it in UI copy. Read new project-file call sites through those helpers.
- Mobile: `apps/mobile` is rebranded by `antimatter/mobile-config.ts` (hooked at the end of `app.config.ts`: "mattr" / "mattr Dev" / "mattr Preview" names, mattr icons, `t3code*` URL schemes kept, locked-screen playback and recording on for Voice Mode) and `antimatter/mobile-rebrand-babel.cjs` (Metro-time "T3 Code"/"T3 Connect" copy rewrite, wired in `babel.config.js`; skipped under `VITEST`; rewritten `msg()`/`gt()` sources lose their non-English catalog entries, as on web). Free Apple ID builds: `T3CODE_IOS_PERSONAL_TEAM=1` defaults the bundle id to `com.current.antimatter.mobile[.dev|.preview]` (override `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID`), signs with Chris's Personal Team `RMAD3349Z8` (override `T3CODE_IOS_APPLE_TEAM_ID`), drops associated domains and OTA updates, and moves `withoutIosPersonalTeamCapabilities.cjs` to the front of the plugin list: mods run in reverse order, so only there does it strip `aps-environment` after expo-notifications adds it. Check with `T3CODE_IOS_PERSONAL_TEAM=1 expo config --type introspect`: the only entitlement left should be `keychain-access-groups`.
- mattr Island, Voice Assistant & Voice Mode: fork-only floating notch pill, question/approval responder, smart-routed Voice Assistant, and hands-free conversational Voice Mode (VAD + barge-in + proactive spoken briefings + pluggable OpenAI/macOS/browser TTS) live in `antimatter/island/`, `antimatter/voice-assistant/`, `apps/desktop/src/island/`, `apps/server/src/voiceAssistant/` (`/api/mattr/voice-assistant/*`), and `apps/web/src/island/`. Voice visuals across Island, Voice Mode modal, and composer (`VoiceWaveform`) use Lilt's 1:1 GLSL Siri Wave shaders (`antimatter/island/siriWaveShaders.ts`, `SiriWave.tsx`). Settings persist in `localStorage` (`mattr:island:settings:v1`) and appear in Settings → General (with Voice Mode accessible on both desktop and mobile PWA via sidebar, Command Palette, and Island).
- Phone remote control & PWA: Tailscale HTTPS pairing links default directly to `https://<mac>.<tailnet>.ts.net/pair#token=...` (serving mattr's own bundled web UI & installable iOS/Android PWA with mattr icons) unless `VITE_HOSTED_APP_URL` is explicitly configured; Settings → Sharing & access probes and enables Tailscale HTTPS directly without requiring LAN `0.0.0.0` exposure. `apps/web/vercel.ts` defaults to the `nightly` asset channel to preserve mattr icons on self-hosted Vercel deployments.

## Releases

Two paths, same result:

- **Local (fast, the default when Chris wants the change now):** commit to `main`, then `node antimatter/ship-local.mjs --install`. It merges the newest upstream nightly into `main` in the reusable build checkout `../mattr-ship` (never in your checkout), builds, signs with `~/.antimatter-signing`, then quits mattr, moves the old app to the Trash, installs `/Applications/mattr.app` and reopens it. Without `--install` it only builds. It reuses the newest published version number, so the next CI release still shows up as an update.
- **CI (for the update button):** push to `main` → `.github/workflows/antimatter-nightly.yml` merges upstream, builds, signs and publishes a prerelease → Chris clicks Update. Pushes that change only Markdown don't build.

Installing or quitting the live app interrupts every running chat (history is kept). Run `--install` only when Chris asks for it, after checking no other thread is running, and send your final reply before the quit delay ends.

## Live UI

For web-only changes Chris can skip installs: with the installed mattr open, `node antimatter/live-ui.mjs` (from the checkout being edited) serves its web UI with hot reload, and reloading mattr (Cmd+R) switches the window to it. Running chats are untouched because they live in the app's backend process, not the window. Stopping the script and reloading goes back to the bundled UI.

- How: the script runs Vite on 127.0.0.1:5799 pinned to the installed app's version and writes `~/.antimatter/live-ui.json` while it runs. `antimatter/liveUi.ts`, hooked once into `apps/desktop/src/electron/ElectronProtocol.ts`, checks that file and the server on every page load and proxies `t3code://app` to it, otherwise serves the bundled files.
- Only renderer code reloads (`apps/web`, `packages/*` UI, `antimatter/` web code). Electron main, preload, Island windows and server changes still need `ship-local --install`, as do UI changes that depend on a newer server than the installed one.
- Agents don't start it unasked: reloading the live window is Chris's call. Agents test in the dev window below.

## Testing UI changes

Test in the separate **mattr (Dev)** desktop window, not the browser or the in-app preview panel:

- Start it from your own shell in the checkout you changed: `vp run dev:desktop` (if `vp` is not on PATH: `mise exec node@26.13.1 -- node_modules/.bin/vp run dev:desktop`). It runs beside the live app with its own data (`~/.antimatter/dev` in the main checkout, `<worktree>/.t3/userdata` in a linked worktree) and hot-reloads web changes.
- Real chats: with the dev window stopped, `node apps/server/scripts/migrate-dev-db.ts --source ~/.antimatter/userdata/statev2.sqlite --base-dir <tmp>` makes a read-only, pruned copy of the live app's data (stopped threads only; running ones are skipped); copy `<tmp>/userdata/statev2.sqlite` over the dev data's `statev2.sqlite` (removing its `-wal`/`-shm`). Never point the dev window at `~/.antimatter/userdata` itself.
- Tell Chris it is open and what to look at. Stop it (your harness's stop, never `pkill`) before handing back, unless Chris asks to keep it running; then give the port, PID and stop command.
- Once Chris approves, commit and push, then install it with the local path under Releases if he wants it now.

## Proposing UI options

When Chris asks for UI changes with options or prototypes, show a side-by-side comparison in the chat before building anything:

- One self-contained HTML page rendered inline with `html_preview` then `html_render` (theme CSS variables, no page background).
- **Current** as the baseline next to each option (A, B, …), at the same scale with the same real copy and data.
- Toggles for whatever changes the verdict: widths, states (idle / working / error), light and dark, empty vs. full.
- Under each option: one line on what it changes, and small chips with the measurable trade-offs (space saved, clicks, items removed).
- End with a recommendation. Build only the option Chris picks.

## Working in parallel

Our workflow is built for speed: parallelize with subagents whenever it gets the work done faster.

- Every new thread sizes its task before starting. If it splits into two or more independent pieces (different files, or research beside implementation), the thread acts as the orchestrator: it plans, starts the pieces as subagents in parallel (several `Agent` calls in one message), works its own piece meanwhile, then reviews and integrates. Use subagents for broad searches and exploration too, so the lead's context stays small.
- One task per thread, one checkout per thread. `mattr.json` sets `defaultThreadEnvMode: "worktree"`, so new threads (composer, `t3_thread_launch`, scheduled tasks) start in their own worktree and branch beside the repo; `Setup Worktree` runs `vp i`, and each worktree gets its own dev data and ports. Threads sharing one checkout see each other's half-done edits: `check:changed` fails on files they didn't touch and commits pick up other work. Don't work in the main checkout (first line of `git worktree list`); it stays clean on `main` for landing and `ship-local`. Choose Local in the composer only for a few-line fix.
- Found someone else's uncommitted changes in your checkout? Leave them alone: commit only your own paths (`git commit -- <paths>`) and judge `check:changed` by your own files.
- Landing a worktree branch: commit, `git rebase main` (worktrees share the repo's branches), `vp run check:changed`, then `git -C <main checkout> merge --ff-only <branch>` and `git -C <main checkout> push origin main`. If the fast-forward fails, `main` moved: rebase and retry.
- Inside one task, the lead plans, splits the work into packages that touch different files, and hands them out, following the account order in Chris's global instructions (Claude main subagents first, then `codex`, `codex-alt`, `claude-alt-2`; never `claude-alt` unless it is under pace — or whatever provider balance Chris asks for in the thread). Workers get absolute paths and a separate worktree (`isolation: "worktree"`), and never push.
- **Always use `delegate_task` for Antigravity subagents** (never Antigravity's internal `invoke_subagent`), so every child runs as a native T3 child thread with live streaming and worktree isolation.
- **Always use Opus (`claude-opus-5-5`) for Claude coding subagents** — never Sonnet for coding work (Sonnet only for tiny, menial non-coding chores).
- The lead reviews each piece, merges into one branch, does one integrated pass in the dev window, then pushes.
- UI options parallelize well: one worker per option mockup, the lead assembles the comparison page.
- Work alone only when the task is a handful of tool calls or the pieces would edit the same files.
