# Runbook

## Architecture

- **Extension** (`extension/`) is the actual product: sidebar (notes, web
  panels, bookmarks), quick paste (context menu + clipboard history), and
  the sync client. Implemented with the Manifest V3 `sidePanel`,
  `contextMenus`, `storage`, `clipboardRead`/`clipboardWrite`, and
  `bookmarks` APIs.
- **AppImage** (`appimage/`) is a thin wrapper: downloads an official
  Chromium linux64 build, force-loads the extension via managed policy,
  and packages it with branding (icon, `.desktop`, AppStream metadata)
  using a FUSE3-compatible `appimagetool` (go-appimage fork).
- **Sync server** is a separate project (Docker, VPS-hosted, zero-knowledge
  E2E encryption, passphrase-derived key, no server-side recovery).
- Update status lives as a badge on the extension's toolbar icon (not an
  OS-level overlay, since nothing can inject into Chromium's native
  browser chrome from outside).

## Built so far (2026-08-15)

- Extension: manifest, background service worker (quick-paste context
  menu + clipboard history, update badge on the toolbar icon, 5-minute
  sync poll), sidebar (notes, web panels, bookmarks, snippets manager,
  sync setup dialog), zero-knowledge crypto (`sync/crypto.js`, smoke
  tested: same passphrase re-derives the same key deterministically,
  different passphrase cannot decrypt another's data), sync client
  (`sync/syncClient.js`, register/login/pull/push with optimistic
  concurrency).
- Sync server: separate public repo
  [lightmorphic-sync](https://github.com/lightmorphic/lightmorphic-sync)
  (`sync-api` + `webstore-proxy`, GHCR images via CI). Smoke tested
  end-to-end locally: register, duplicate-register rejection, wrong-key
  login rejection, unauthenticated access rejection, put/get roundtrip,
  stale-version conflict detection all verified working.
- Deploy: private ops repo `lightmorphic-sync-deploy` on Forgejo
  (git.lightmorphic.co.uk), targeting lm101 — nginx vhosts for
  `sync.lightmorphic.co.uk` and `webstore-proxy.lightmorphic.co.uk`,
  compose file, deploy/update instructions. **Not yet actually deployed
  to lm101** (DNS not pointed there yet) — repo is ready to go.
- AppImage `build.sh`: fixed the version-string/build-number bug (was
  broken, now resolves via chromiumdash's `fetch_version`, verified the
  lookup works). Launcher flags wired to route extension installs through
  the Web Store proxy instead of Google directly.

## Not yet built / verified

- AppImage build has not been run end-to-end in CI since the fix (next
  scheduled/dispatched run will tell); no local Linux build attempted in
  this session.
- No UI testing of the sidebar/quick-paste in an actual browser yet
  (loaded and syntax-checked, not click-tested) — needs a built AppImage
  or `chrome://extensions` load-unpacked test.
- Extensions-list sync (only bookmarks/settings/snippets collections are
  wired into the UI so far; `extensions` collection exists server-side
  but nothing populates it yet).
- Passphrase change / account recovery UX (by design there is no
  recovery, but there's no "forget this device" or multi-device
  re-login flow built yet beyond the existing-account login path).

## Chromium version tracking

`.github/workflows/build.yml` polls the Chrome versionhistory API daily.
When the latest linux stable version differs from
`appimage/last-built-version.txt`, it rebuilds and publishes a new release.
Version-string-to-build-number resolution now goes through chromiumdash's
`fetch_version` endpoint (fixed 2026-08-15, verified the lookup itself
works; the full build hasn't been re-run in CI yet).
