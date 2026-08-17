# Runbook

## Architecture

- **Extension** (`extension/`) is the actual product: sidebar (notes, web
  panels, bookmarks-in-sidebar), quick paste (context menu + clipboard
  history), and the sync client. Implemented with the Manifest V3
  `sidePanel`, `contextMenus`, `storage`, `tabs`,
  `clipboardRead`/`clipboardWrite`, and `bookmarks` APIs.
- **Theme** (`theme/`) is a separate package, not merged into the
  extension's own manifest — a `"theme"` key alongside full extension
  functionality in one manifest silently breaks the extension (see the
  2026-08-15 entry below). Loaded side by side with the extension via
  `--load-extension`'s comma-separated path list.
- **AppImage** (`appimage/`) is a thin wrapper: downloads an official
  open-source Chromium linux64 snapshot (not "Google Chrome" — already
  lacks Google's proprietary API keys/branding), loads the extension via
  `--load-extension` + `--disable-extensions-except`, applies our own
  privacy-hardening flags (see AppRun in `build.sh`), and packages it
  with branding (icon, `.desktop`, AppStream metadata) using a
  FUSE3-compatible `appimagetool` (go-appimage fork). Deliberately not
  built on a third-party de-googling project — see the 2026-08-15 entry
  below for why that was tried and reverted.
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

- **Real screen verification, extension-disable bug, and sidebar redesign**
  (2026-08-15). Used `Xephyr` (a nested X server, no root needed) to get a
  real isolated display for actual click-testing, rather than continuing
  to guess from headless/CDP output alone — deliberately not on Charlie's
  real desktop, since this environment's `DISPLAY=:0` turned out to be
  his live session with his own windows open.
  - **Found the actual root cause of "nothing there" on a relaunch**: an
    extension loaded via `--load-extension` survives the first launch but
    gets silently **disabled** on reload/relaunch ("Turn on developer
    mode to use this extension") unless Developer Mode is already on.
    Watched it happen live (toggle flips off, warning banner appears).
    Fixed by pre-seeding `extensions.ui.developer_mode: true` in the
    profile's `Preferences` file on first run.
  - Gave the extension a fixed `key` in its manifest so its ID is stable
    (`hokpgjhmbdcggofdeaaobeknogcmlbfa`) across builds instead of derived
    from the load path — verified the ID computation against a real load,
    not just calculated.
  - Attempted to pre-pin the toolbar icon via `pinned_extensions`
    (confirmed as the correct **top-level** Preferences key, not nested
    under `extensions` as first guessed — found by manually pinning via
    the UI and diffing the file). Pre-seeding it before first launch does
    not reliably paint the icon on first render in testing, even though
    the value is objectively correct and persists once set. Kept in
    `build.sh` since it's harmless and correct, but a user may still need
    one manual pin click the first time — not the zero-click result
    originally wanted, worth revisiting.
  - Confirmed the extension's real icon (not a placeholder) renders
    correctly in `chrome://extensions` via a swap-to-solid-red test.
  - **Sidebar redesigned**: Vivaldi-style icon rail (Notes / Panels /
    Bookmarks / Snippets / Settings, inline SVGs) replacing the old
    top text-tab bar; Settings is now a real panel with the sync form
    inline, not a `<dialog>` modal. Verified by actually opening the side
    panel via the extension's toolbar action and clicking through each
    rail icon on the nested display — confirmed switching works and the
    Settings panel renders the sync form correctly.

- **Reverted ungoogled-chromium back to vanilla Chromium + our own privacy
  flags** (2026-08-15, same day it was adopted). Charlie's concern: tying
  the project's release cadence to a third-party de-googling project's
  continued maintenance is a real risk if that project stalls or
  disappears. A full from-source Chromium rebuild (the only way to be
  "more" de-googled than this) isn't realistic for a wrapper-AppImage
  project — 100GB+ disk, many hours per build, specialized
  infrastructure. So: back to official open-source Chromium snapshots
  (already lack Google's proprietary API keys/branding — confirmed live,
  the browser shows its own "Google API keys are missing" infobar) with
  our own flags on top, all real documented Chromium switches, not
  guessed preference keys: `--disable-background-networking`,
  `--disable-sync`, `--disable-domain-reliability`,
  `--disable-client-side-phishing-detection`,
  `--disable-features=Translate,OptimizationHints,AutofillServerCommunication`.
  **Known gap, documented rather than silently left broken**: the default
  search engine is still Google in the prepopulated engine list — that's
  baked into the source, not policy-removable without either a verified
  Preferences key (not attempted — didn't want to repeat the
  `pinned_extensions` guessing detour on something this central) or a
  manual one-time change by the user.
- **Verified `chrome.sidePanel.open()` cannot be called outside a direct
  user gesture** — tried wiring it to `chrome.windows.onCreated` to
  auto-open the sidebar in every new window (as close to Vivaldi's
  permanent rail as an extension can get), confirmed via a real headful
  test that it silently does nothing (no error logged, panel just never
  appears) when called from that event. Removed the dead code rather than
  ship a false claim. Click-to-open via the toolbar action remains the
  real mechanism — verified working, and the panel does stay open across
  tab switches within a window once opened.
- **"Pin this page" quick-add** (Vivaldi-style): the Panels view now has
  a prominent button that grabs the active tab's URL via `chrome.tabs`
  and pins it in one click, with manual URL entry moved to a collapsed
  "Or pin a specific URL" fallback. Verified end-to-end on a real
  display: opened the panel on `example.com`, clicked "Pin this page",
  confirmed the URL appeared in the pinned list and rendered live in the
  panel's iframe.

- **Deep dive on browser UX trends, DuckDuckGo default (verified), native
  theme, bookmarks-in-sidebar** (2026-08-15). Web research (not just
  priors) on what people actually want from a browser in 2026 confirmed
  two things already underway: vertical/sidebar tab and panel layouts are
  a real, broad trend (Chrome and Firefox both adding them), and the
  `chrome.sidePanel.open()` gesture restriction is a hard, documented
  Chromium security restriction with no workaround — external sources
  agree with what testing had already shown, so that item moves from
  "worth revisiting" to genuinely closed; a permanent Vivaldi-style rail
  needs real browser-chrome UI, not reachable from any extension.
  - **Default search engine fixed for real**: seeded
    `default_search_provider_data` (DuckDuckGo) in the first-run
    `Preferences` file. Verified two ways, not assumed: the omnibox
    placeholder read "Search DuckDuckGo or type a URL", and an actual
    typed query navigated to `duckduckgo.com/?q=...`, not Google. No
    Google default search left in the shipped browser. (There is no
    extension mechanism for this on Linux at all —
    `chrome_settings_overrides.search_provider` is Windows/Mac only per
    Chrome's own docs, confirmed by research — so this Preferences seed
    is the only lever, and it only works pre-first-run.)
  - **Native Lightmorphic browser theme** added (navy frame/toolbar,
    yellow accent) using Chrome's `"theme"` manifest key. First attempt
    merged it into the main extension's manifest — this silently broke
    the *entire* extension (loaded, but vanished from
    `chrome://extensions` with no error) despite the theme itself
    visibly applying. Not something the initial research surfaced; found
    only by actually launching the built AppImage on a real display.
    Fixed by splitting into two separate packages (`extension/`,
    `theme/`) loaded side by side via `--load-extension`'s
    comma-separated path list — verified both load correctly together
    (extension enabled with real icon + service worker; theme applies,
    "Installed theme" banner names it correctly).
  - **Bookmarks now open inside the sidebar**, not a new tab — same
    pattern as pinned web panels. Added a "Bookmark this page" quick-add
    button (mirrors "Pin this page"). Verified end-to-end: bookmarked
    example.com from the sidebar, confirmed it appeared in the tree, and
    confirmed clicking it loaded inline in the panel's own frame rather
    than opening a tab.
  - Settings panel gained a "Search engine" section: static status
    (DuckDuckGo, not Google) plus a "Change search engine…" button that
    opens `chrome://settings/searchEngines` — the honest fallback, since
    there's no way for an extension to change the default while the
    browser is already running, only before first launch.

## Not yet built / verified

- Zero-click toolbar pinning — still correct-but-unreliable pre-seeded
  state (`pinned_extensions` is right, confirmed by diffing a manual
  pin, but doesn't reliably paint on first render). One manual pin click
  may still be needed the first time.
- Extensions-list sync (only bookmarks/settings/snippets collections are
  wired into the UI so far; `extensions` collection exists server-side
  but nothing populates it yet).
- Passphrase change / account recovery UX (by design there is no
  recovery, but there's no "forget this device" or multi-device
  re-login flow built yet beyond the existing-account login path).

## Chromium version tracking

`.github/workflows/build.yml` polls the Chrome versionhistory API daily.
When the latest linux stable version differs from
`appimage/last-built-version.txt`, it rebuilds and publishes a new
release. Confirmed working end-to-end in CI (both before and after the
ungoogled-chromium detour, same underlying mechanism).
