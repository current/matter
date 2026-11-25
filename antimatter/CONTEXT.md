# mattr project context

Read this before any task in this repo. It is loaded for every agent through `AGENTS.md`, in the main checkout and in every worktree. Where it differs from upstream's docs, this file wins.

Keep it current: when a task changes a decision, a workflow or the fork's state, update this file in the same commit. Record decisions and rules, not task logs.

## What this is

mattr is Chris's personal fork of T3 Code nightly (`pingdotgg/t3code`). The repo is `current/mattr` (renamed from `current/t3code`; remote `origin`, branch `main`; upstream is remote `upstream`). The fork used to be called Antimatter, so internal names (`antimatter/`, the workflow file, data folders, app id) still say antimatter. The user-facing name is **mattr**, always lowercase.

Upstream's `AGENTS.md` and `docs/internals/` still apply to the code itself.

## Fork rules

- Keep fork changes small and in fork-only files (`antimatter/`) where possible. CI merges the newest upstream nightly at every build, so edits inside busy upstream files become merge conflicts.
- Don't merge upstream into `main` by hand unless a build opens an "Antimatter: merge conflict" issue.
- Commit and push finished work to `main` yourself; don't ask Chris first. Run `vp run check:changed` before pushing. Only the lead pushes; workers never do. Every push that changes more than Markdown builds and publishes a release.
- Never create a new repo named `current/t3code`: installed builds from before the rename find updates through GitHub's redirect from that name.
- Never write to `~/.antimatter/userdata`: it is the live app's database, and the chat you are running in lives there.

## Branding

- Copy: `antimatter/rebrand.ts` rewrites "T3 Code" → "mattr" and "T3 Connect" → "mattr Connect" at build time in the web bundle (`apps/web/src`, `packages/*/src`) and in the desktop app's `msg()` dialog copy. Don't hand-edit upstream strings; extend the plugin instead. Tests skip it (`VITEST`), so tests keep asserting upstream English.
- Name constants: `apps/web/src/branding.ts`, `apps/desktop/src/app/DesktopEnvironment.ts`, sidebar wordmark in `apps/web/src/components/sidebar/SidebarChrome.tsx`, product/artifact name in `scripts/build-desktop-artifact.ts`, DMG name in `antimatter/sign-mac-release.mjs`.
- The "star T3 Code on GitHub" prompt is off (`apps/web/src/components/GitHubStarPrompt.tsx`).
- Logo: `apps/web/src/components/T3Wordmark.tsx` renders the mattr logo. App icon: `assets/nightly/app-icon.icon`.
- Keep as is (renaming breaks data, updates or interop): app id `com.current.antimatter`, `~/.antimatter` and `~/Library/Application Support/antimatter`, the signing certificate, the `t3` CLI, `t3code://`, `t3.codes` URLs, the "T3 Code for GitHub" app name.
- Project file: `mattr.json` (`T3_PROJECT_FILE_NAME` in `packages/contracts/src/t3ProjectFile.ts`). A project without one still uses upstream's `t3.json`: server reads go through `apps/server/src/project/MattrProjectFile.ts`, and the rebrand plugin renames it in UI copy. Read new project-file call sites through those helpers.

## Releases

Push to `main` → `.github/workflows/antimatter-nightly.yml` merges upstream, builds macOS arm64, re-signs with the fork's certificate and publishes a prerelease → Chris clicks Update in the app. Updating or quitting the live app interrupts any running chat (history is kept), so Chris updates when idle. Never restart or replace the live app yourself.

## Testing UI changes

Test in the separate **mattr (Dev)** desktop window, not the browser or the in-app preview panel:

- Start it from your own shell in the checkout you changed: `vp run dev:desktop` (if `vp` is not on PATH: `mise exec node@26.13.1 -- node_modules/.bin/vp run dev:desktop`). It runs beside the live app with its own data (`~/.antimatter/dev` in the main checkout, `<worktree>/.t3/userdata` in a linked worktree) and hot-reloads web changes.
- Tell Chris it is open and what to look at. Stop it (your harness's stop, never `pkill`) before handing back, unless Chris asks to keep it running; then give the port, PID and stop command.
- Once Chris approves, commit and push; the release replaces the live app on his next update.

## Proposing UI options

When Chris asks for UI changes with options or prototypes, show a side-by-side comparison in the chat before building anything:

- One self-contained HTML page rendered inline with `html_preview` then `html_render` (theme CSS variables, no page background).
- **Current** as the baseline next to each option (A, B, …), at the same scale with the same real copy and data.
- Toggles for whatever changes the verdict: widths, states (idle / working / error), light and dark, empty vs. full.
- Under each option: one line on what it changes, and small chips with the measurable trade-offs (space saved, clicks, items removed).
- End with a recommendation. Build only the option Chris picks.

## Working in parallel

- One task per thread. Independent tasks get their own thread in their own worktree (new thread → worktree; `Setup Worktree` runs `vp i`). Each worktree gets its own dev data and ports, so several dev windows can run at once.
- Inside one task, the lead plans, splits the work into packages that touch different files, and hands them out, following the account order in Chris's global instructions (Claude main subagents first, then `codex`, `codex-alt`, `claude-alt-2`; never `claude-alt` unless it is under pace). Workers get absolute paths and a separate worktree (`isolation: "worktree"`), and never push.
- The lead reviews each piece, merges into one branch, does one integrated pass in the dev window, then pushes.
- UI options parallelize well: one worker per option mockup, the lead assembles the comparison page.
- Don't parallelize work that edits the same files, or that is a handful of tool calls.
