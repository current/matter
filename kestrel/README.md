# Kestrel

Kestrel is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code) that tracks its nightly channel.

## How updates work

`.github/workflows/kestrel-nightly.yml` checks for a new T3 Code nightly every 30 minutes, and also runs on every push to `main`. When either one has changed, it:

1. merges the newest upstream nightly tag into `main` (in CI only, nothing is pushed back);
2. builds the macOS arm64 app;
3. re-signs the app with the fork's self-signed certificate (`kestrel/sign-mac-release.mjs`);
4. publishes a prerelease with upstream's release notes. The app's update button reads these prereleases.

Kestrel versions are upstream's version with two extra digits on the run number. For example, upstream `0.1.12-nightly.20261124.5209` becomes `...520901`, and the next rebuild of the same upstream nightly becomes `...520902`.

If upstream changes conflict with yours, that build fails and the workflow opens an issue. To fix it, run `git fetch upstream --tags`, then `git merge <tag>`, resolve the conflicts and push.

## Making changes

Edit on `main` and push. Keep the changes small and in their own files where possible, so upstream merges stay clean.

Fork-only files:

- `kestrel/`
- `.github/workflows/kestrel-nightly.yml`
- the placeholder branding in `assets/nightly/*`, `scripts/build-desktop-artifact.ts` (`DESKTOP_APP_ID`, product name, artifact name), `apps/desktop/src/app/DesktopEnvironment.ts` (`APP_BASE_NAME`), `apps/web/src/branding.ts` and `apps/web/src/components/sidebar/SidebarChrome.tsx`.

## Signing

The certificate and its private key live in `~/.kestrel-signing` on the Mac that set this up. They are also stored as the repository secrets `KESTREL_SIGNING_P12` and `KESTREL_SIGNING_P12_PASSWORD`.

Keep the same certificate. The updater only accepts a new build if it is signed by the same certificate as the installed app. If the certificate changes, you have to reinstall the app by hand once.
