# Runbook

## Architecture

- **Extension** (`extension/`) is the actual product: sidebar (notes, web
  panels, bookmarks), quick paste (context menu + clipboard history), and
  the sync client. Implemented with the Manifest V3 `sidePanel`,
  `contextMenus`, `storage`, `clipboardRead`/`clipboardWrite`, and
  `bookmarks` APIs.
- **AppImage** (`appimage/`) is a thin wrapper: downloads an
  [ungoogled-chromium-portablelinux](https://github.com/ungoogled-software/ungoogled-chromium-portablelinux)
  build (Chromium with Google's integration patches stripped at the
  source level — not stock Chromium with flags on top), loads the
  extension via `--load-extension` + `--disable-extensions-except`, and
  packages it with branding (icon, `.desktop`, AppStream metadata) using
  a FUSE3-compatible `appimagetool` (go-appimage fork).
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
  (git.lightmorphic.co.uk), running on lm101. **Live since 2026-08-15**
  at https://sync.lightmorphic.co.uk and
  https://webstore-proxy.lightmorphic.co.uk, TLS via certbot, verified
  with a full register/login/put/get/delete cycle over the real domain
  — this is exactly the `DEFAULT_SERVER` already hardcoded in
  `extension/sync/syncClient.js` and the `--apps-gallery-*` URLs in
  `appimage/build.sh`'s launcher, so no code changes were needed once
  DNS was in place.
- AppImage `build.sh`: fully working, verified with a real local build
  and confirmed again in CI. Three separate real bugs were found and
  fixed by actually running the pipeline instead of trusting it:
  1. Chromium snapshot archive doesn't have a build for every position;
     added a bounded existence probe (avoided the GCS listing API, which
     sorts positions lexicographically and silently misorders different
     digit lengths).
  2. go-appimage's `appimagetool` release asset filename embeds a
     changing build number (`appimagetool-947-x86_64.AppImage`) —
     resolved dynamically via the GitHub API instead of a hardcoded URL.
  3. That appimagetool version's CLI takes only the AppDir path (no
     output-path arg — silently no-ops otherwise) and runs AppStream
     validation as a hard failure requiring the metadata file, its `<id>`,
     and the `.desktop` file to all agree on one reverse-DNS name
     (`co.lightmorphic.browser`).
  4. The CI "commit last-built version" step's `git push || echo
     "nothing to push"` was silently swallowing a real permissions
     failure (missing `contents: write` on the job) — reported "success"
     while doing nothing. Fixed both the permission and the swallowed
     error.
  Launcher flags wired to route extension installs through the Web Store
  proxy instead of Google directly.
- **First real release published**: `v151.0.7922.137`, a working 188MB
  AppImage, built and released fully through CI (not just locally) —
  confirmed via the GitHub releases API.
- **Switched from stock Chromium to ungoogled-chromium** (2026-08-15,
  per explicit instruction: no Google involvement at all, not just
  policy flags on top of stock Chromium). Two real bugs found in the
  first ungoogled build and fixed:
  1. The very first AppImage (stock Chromium, `--load-extension` only)
     showed no visible extension at all when actually run — Charlie
     reported "it just looks like Chromium, nothing there." Root cause:
     recent Chromium shows a "extensions loaded via command line will be
     removed unless Developer Mode is on" infobar and can silently drop
     the extension. Fixed by adding `--disable-extensions-except`
     alongside `--load-extension` (the same combination
     Selenium/Puppeteer use for this exact reason). Verified via
     `--headless=new --remote-debugging-port` + `/json` that the
     extension's background service worker is actually present as a
     live devtools target — confirmed on both the stock-Chromium build
     and the ungoogled-chromium rebuild.
  2. The build previously resolved a Chromium version string to a
     snapshot archive build position via chromiumdash, then probed for
     the nearest existing snapshot. ungoogled-chromium-portablelinux
     publishes releases indexed directly by version string (as a
     `<chromium-version>-<patchset-revision>` tag), which removed that
     whole resolution step — `build.sh` and the CI version-check both
     got simpler, not just switched.
  - `last-built-version.txt` now tracks the full release tag (not the
    bare Chromium version), since ungoogled-chromium can ship a new
    patch-set revision for the same underlying Chromium version and
    that's a real update worth rebuilding for.
  - The old "managed policy" file (`policies/managed/lightmorphic.json`)
    was deleted rather than carried over: it was never actually being
    read (Chromium loads managed policy from OS system paths, not a
    path relative to the binary — this had been silently inert since it
    was first written) and is moot now anyway since ungoogled-chromium
    strips sign-in/sync at the source level.

## Not yet built / verified

- The ungoogled-chromium build has not yet been run through a real
  screen/display — verified via headless + CDP that Chromium launches
  and the extension's service worker loads, not via clicking through
  the UI.
- Extensions-list sync (only bookmarks/settings/snippets collections are
  wired into the UI so far; `extensions` collection exists server-side
  but nothing populates it yet).
- Passphrase change / account recovery UX (by design there is no
  recovery, but there's no "forget this device" or multi-device
  re-login flow built yet beyond the existing-account login path).

## Chromium (ungoogled) version tracking

`.github/workflows/build.yml` polls
ungoogled-chromium-portablelinux's own GitHub releases daily. When the
latest release tag differs from `appimage/last-built-version.txt`, it
rebuilds and publishes a new release. The stock-Chromium version of this
pipeline was confirmed working end-to-end in CI on 2026-08-15; the
ungoogled-chromium version has been verified with a real local build but
not yet run through CI (next scheduled/dispatched run will confirm).
