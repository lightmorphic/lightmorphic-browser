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

- **AI Mode / "Ask Google" suppression, real update-dot system**
  (2026-08-17). Charlie reported the omnibox showing "AI Mode" and "Ask
  Google about this page" — confirmed live against the actual shipped
  151.x version (an older local test build didn't have it; this isn't
  gated behind Google API keys the way some things are, it's built into
  vanilla open-source Chromium's UI now). Fixed with
  `--disable-features=AiMode,LensOverlay,LensStandalone,ComposeUI,LinkedServicesSetting,PageContentAnnotations,GeminiInChromeSidePanel,GlicIntegration,Glic,TabOrganization,HistoryEmbeddings`
  — verified by actually launching with the flags and confirming the
  button/chip are gone, not by assuming the flag names work.
  - **Real update-dot system** added to the sidebar's Settings panel
    (house style: green/yellow/spinning-ring/blue/red), replacing the
    toolbar-badge-only version. Caught and fixed a real bug while
    building it: the original check compared the *extension's own*
    manifest version against the GitHub release tag, which would never
    match (`v0.1.0` vs `v151.0.7922.137`) and would have shown "update
    available" permanently even when fully current. Fixed with
    `version.json`, written by `build.sh` with the actual release tag
    each AppImage was built from, and background.js compares against
    that instead. Verified both states for real: built matching the
    current release tag → confirmed "Up to date" (green, no rail dot);
    the click-to-download path uses `chrome.downloads` for a real file
    download. Honest limit, stated in the UI itself rather than
    overclaimed: an extension can't safely replace the running AppImage
    from inside the sandbox (no filesystem access beyond Downloads, no
    exec permission) — download is real, the "ready" state tells the
    user to swap the file and relaunch rather than claiming a silent
    self-update that isn't actually built.
- **Confirmed a hard branding ceiling** — Charlie pointed out the profile
  menu says "Your Chromium" / "Add Chromium profile" / "Manage Chromium
  profiles", and "Google services settings" is a native menu item.
  Verified live: this is real, and it's not fixable by any flag, policy,
  or Preferences seed. These strings come from Chromium's own compiled
  `.grd` resource files (`IDS_PRODUCT_NAME` etc.) — changing them needs
  editing those source files and a full rebuild, the same "100GB+ disk,
  many hours, specialized infrastructure" ceiling already ruled out for
  this project (see the ungoogled-chromium revert entry above). This
  applies equally to the other standing ask — a permanently pinned,
  un-unpinnable toolbar icon "that looks like it's part of the browser" —
  toolbar pin state is user-controlled by Chromium design with no
  extension-level override; a forced pin needs either root-owned
  enterprise policy (`ExtensionSettings.toolbar_pin`, requires writing to
  `/etc/.../policies/managed`, which this project has deliberately
  avoided since it would need sudo on every install) or, again, a real
  source-level fork. **Not attempted further this round** — flagged to
  Charlie as a scope decision rather than silently worked around.

- **Rebranding without a fork, alpha versioning, new-tab update widget,
  sign-in removal, single-profile mode** (2026-08-18). The fork-level
  branding ceiling turned out to have a large escape hatch: all
  user-visible product strings ("Your Chromium", "Add Chromium profile",
  window titles, settings/infobar text) live in `locales/*.pak` — a
  simple documented archive format — NOT compiled into the binary.
  `appimage/patch-pak.py` parses and rewrites them at package time
  (Chromium→Lightmorphic Browser, plus targeted whole-phrase Google
  replacements like "Google services settings"→"Account services
  settings"; deliberately no blanket Google replace, which would
  manufacture false statements). The Chromium binary stays byte-identical
  to upstream, so automatic updates keep working. Verified live: profile
  menu reads "Your Lightmorphic Browser / Manage Lightmorphic Browser
  profiles", infobars rebranded, browser boots and runs normally on
  repacked files (228 locales, ~50k strings patched).
  - Browser now has its own alpha version (`VERSION` file, v0.01);
    releases tag as `v<browser>-<chromium>` so auto Chromium-update
    rebuilds don't collide. AppImage named
    `Lightmorphic-Browser-0.01-x86_64.AppImage`.
  - New-tab page override: Lightmorphic wordmark, DuckDuckGo search box,
    and the house update-widget (name + version beside a coloured circle,
    bottom-left; green/yellow/ring/blue/red states, click-to-act).
    Verified live. Known quirk: the very first tab at startup shows the
    stock NTP (extension loads a beat too late); every tab after that
    gets the override.
  - Sign-in surfaces disabled (`signin.allowed[_on_next_startup]:false`)
    and single-profile mode: `profile.add_person_enabled` and
    `browser_guest_enabled` false in a seeded Local State — verified
    live that "Add profile" and "Open guest profile" are gone from the
    profile menu. "Manage profiles" has no pref-level switch and remains.
  - Debugging note for future test scripts: `pkill -f <pattern>` kills
    the invoking shell itself when the pattern appears in the same
    command line (e.g. in profile paths passed to rm) — this silently
    ate several test runs before being spotted. Kill by pgrep pid or use
    patterns that can't appear in your own command.

- **v0.02: rail pinned-site icons + "+", LMB naming, rail on the right**
  (2026-08-18). Pinned sites now render as favicon buttons in the icon
  rail itself (Vivaldi-style) with a "+" button underneath that pins the
  current page — verified live (pinned example.com via the +, icon
  appeared with dot-fallback for its missing favicon, site opened
  in-panel). Favicons via DuckDuckGo's icon service, consistent with the
  no-Google stance. Naming: short form "LMB" on every user-visible
  surface (pak rebrand, toolbar, panel header, new tab, update widget);
  long form "LMB (Lightmorphic Browser)" only on explanatory surfaces
  (launcher entry, AppStream, extension description). Rail moved to the
  right edge of the panel (the outermost window edge, since Chromium
  docks the side panel right). "Always visible" remains bounded by the
  verified gesture restriction: the panel persists across tab switches
  once opened, but nothing extension-side can force it open at launch.

- **v0.03: permanent update footer, cross-origin framing fix** (2026-08-18).
  - Charlie's point: the update widget lived only on the new-tab page,
    which is replaceable, so the update system could vanish. Moved it to
    a **dedicated always-visible footer at the bottom of the side panel**
    (name + version beside the house coloured circle, same
    green/yellow/ring/blue/red states, click-to-act). The new-tab widget
    stays too, but the panel footer is now the durable home. Verified
    live: footer shows "LMB v0.02" with a green dot on the built AppImage.
  - **Fixed "BBC refuses to connect" in the panel** — the real cause was
    `X-Frame-Options` / CSP `frame-ancestors` response headers that
    forbid a site being iframed. `loadInFrame()` now adds a **per-host**
    session `declarativeNetRequest` rule that strips those headers only
    for the exact host the user pinned/opened (`requestDomains: [host]`,
    `resourceTypes: ["sub_frame"]`), so clickjacking protection stays
    intact for every other site — the tradeoff is scoped to sites the
    user explicitly chose to embed. Verified live: navigated the main tab
    to bbc.com, hit the rail "+", and BBC's full homepage (cookie banner,
    headlines, images) rendered inside the panel instead of "refused to
    connect". DNR can only remove a whole header, not edit within CSP, so
    the pinned host's entire CSP is dropped for its framed load —
    documented, host-scoped.
  - Cleanup: `appimage/AppDir/` was partially tracked in git from an
    early commit; now fully gitignored and untracked.

- **v0.04 logo redesign + v0.05 Linux icon fix** (2026-08-18). Logo
  rebuilt as a full navy rounded-square with the yellow motif centred and
  the white edge removed (transparent rounded corners, verified alpha=0).
  Then Charlie reported the Linux menu/taskbar icon still showed
  Chromium. Diagnosed empirically on the nested display, two distinct
  causes:
  - The running window's `_NET_WM_ICON` is a **128px icon compiled into
    resources.pak**, NOT the on-disk `product_logo_48.png` (confirmed by
    swapping product_logo for red and reading the live property — window
    icon was unaffected). So DEs that read `_NET_WM_ICON` directly can't
    be fixed without a pak-image patch (not done).
  - But Cinnamon/GNOME/KDE resolve the taskbar/menu icon by matching the
    window's `WM_CLASS` to a `.desktop` file's `Icon=`. Chromium's
    default WM_CLASS is `chrome`/`Chrome`, so they matched the system
    Chromium. Fixed with `--class=lightmorphic-browser` (verified the
    WM_CLASS second field is now `lightmorphic-browser`, matching our
    `StartupWMClass`) plus installing the icon into the hicolor theme
    (`usr/share/icons/hicolor/*/apps/lightmorphic-browser.png`) so
    `Icon=lightmorphic-browser` actually resolves — it wasn't themed
    before, which is why menus fell back. The `.DirIcon` was already our
    logo. Honest edge: bare WMs that ignore `.desktop` mapping still see
    the compiled Chromium `_NET_WM_ICON`; mainstream DEs (incl. Charlie's
    Cinnamon/LMDE) now show ours.
- **Un-removable / un-pinnable extension: confirmed not achievable in the
  wrapper.** Making the extension force-installed (no Remove button) and
  force-pinned (unpinnable) requires a Chromium **enterprise managed
  policy** (`ExtensionSettings` `installation_mode: force_installed` +
  `toolbar_pin: force_pinned`). On Linux that policy must live in
  `/etc/.../policies/managed/`, which needs **root at install time** — an
  AppImage runs as the user and can't write there — and force_installed
  targets webstore/update_url extensions, not `--load-extension` unpacked
  ones anyway. Truly enforcing it needs the source-fork/component-extension
  route already ruled out. Per Charlie's own steer ("if not, we'll use
  that as a selling point that it can be totally removed"), removability
  is kept and framed as a privacy virtue — the opposite of Chrome's
  un-removable Google integration.

- **v0.07: working "install & restart" self-updater, custom tooltips**
  (2026-08-18). The blue "downloaded, ready" update state did nothing on
  click -- there was no handler for it. Built a real self-updater: an
  extension can't replace the running AppImage or restart the browser
  from its sandbox, so a **native-messaging host** (`appimage/lmb-updater`,
  pure bash) bridges to native code. AppRun registers the host manifest
  (into `<user-data-dir>/NativeMessagingHosts` + the chromium/chrome
  config dirs, belt-and-suspenders) and records the running AppImage path
  (`$APPIMAGE`) on each launch. Blue click -> background `connectNative`
  -> host copies the downloaded AppImage over the running one, SIGTERMs
  the browser (clean shutdown, tabs restored by "continue where you left
  off"), and a detached relauncher starts the new binary. **Verified
  end-to-end via CDP** on a directly-run AppImage: the host launched, the
  target file's sha changed to the staged update's sha (swap confirmed),
  the browser was SIGTERM'd, and a new instance relaunched. Fallback: if
  the native host isn't reachable (e.g. unpacked-extension dev run), blue
  reveals the downloaded file instead, so it never silently does nothing.
  - Custom house-style tooltips on the rail buttons (replacing native
    `title=`): dark bubble + arrow on light mode, reversed (light bubble)
    on dark mode, 400ms hover delay, positioned left of the right-edge
    rail. CSS-only via `data-tip`; a clean live screenshot didn't come
    through this session (display flakiness) but the CSS is standard and
    syntax-checked -- worth an eyeball on the next real run.

- **v0.08: update footer reformatted, whole-browser light/dark, update
  removed from new tab** (2026-08-18).
  - Update footer: now bottom-left, just the version number then the
    status circle (no "LMB" name), in its own footer bar. Verified live.
  - Removed the update widget from the new-tab page entirely (a
    replaceable page is the wrong home for it -- the sidebar footer is
    the durable one).
  - **Whole-browser light/dark** (previously the toggle only themed the
    sidebar panel). The browser chrome colour comes from whichever theme
    package the launcher loads, so added a light theme package
    (`theme-light/`); AppRun reads a `theme-mode` file and loads light or
    dark accordingly. The rail toggle flips the sidebar instantly (CSS)
    AND messages the native host, which writes `theme-mode` and restarts
    the browser (same relaunch path as the updater, already verified) so
    the whole chrome switches. Verified live: launching with
    `theme-mode=light` gives a fully light browser (light frame, white
    toolbar, dark text) -- the mechanism works. Honest cost, stated to
    the user: flipping light/dark restarts the browser to apply to the
    chrome (tabs restored). Sidebar theme (chrome.storage) and browser
    theme (theme-mode file) are set together by the toggle so they stay
    in sync.

- **v0.09: fix v0.08 "totally broken" regression** (2026-08-18). v0.08's
  light/dark toggle force-restarted the whole browser (to re-theme the
  chrome), and the relaunched browser came up black/broken -- reproduced
  live: clicking the toggle killed the browser and it never re-rendered.
  That was the "complete mess". Two fixes:
  1. The theme toggle no longer restarts. It recolours the sidebar
     instantly (CSS) and persists the mode (native host writes the
     `theme-mode` file, no restart); the browser chrome picks it up on the
     next normal launch. Verified live: clicking the toggle now leaves the
     browser up and working, sidebar switches to light immediately.
  2. Hardened the restart path (still used by the self-updater's install):
     it now SIGTERMs only OUR browser (matched by exact `--user-data-dir`,
     not a broad `chromium/chrome` match that could have hit Brave / other
     Chromium apps), and the relauncher clears the stale single-instance
     lock (`Singleton*`) before starting, which was the likely cause of
     the black relaunch.
  Lesson logged: don't force a full browser restart for a cosmetic change;
  and a fresh-profile smoke test isn't enough -- the regression only
  showed when actually exercising the new control.
  - Also fixed the "search page gone" report: the new-tab override only
    applies to tabs opened AFTER the unpacked extension registers, so the
    very first startup tab showed the stock Chromium NTP. background.js
    now redirects any stock-NTP tab to the LMB page from an AWAITED loop
    in onInstalled/onStartup (keeps the MV3 worker alive across retries;
    a bare setTimeout got killed when the worker suspended), plus a
    tabs.onUpdated catch. Verified the LMB search page shows on startup.
  - Dark is the default (fresh profile -> dark chrome + dark sidebar). A
    user who lands in light did so via the toggle; toggling back to dark
    now works without crashing.
  - Pinning the toolbar icon by default: still not reliable from the
    `pinned_extensions` seed (the unpacked extension registers after the
    toolbar model initialises). The extension is always ACTIVE (loaded
    every launch); the icon just may need a one-time manual pin
    (puzzle-piece menu -> pin), which then sticks. True force-pin needs
    enterprise policy (root) or a source fork -- out of scope, as noted
    earlier.

- **v0.10: removed light/dark entirely** (2026-08-18). An instant
  whole-browser light/dark toggle is genuinely impossible from an
  extension: Chromium has no runtime API to repaint the browser chrome
  (tabs/toolbar/menus) -- the theme is fixed at launch by the loaded theme
  package, and the only way to change it is a full restart (which was the
  crash source). A toggle that only recolours the sidebar panel is
  pointless, so per Charlie's instruction ("if it's not possible at all,
  then remove light and dark") it was removed: no rail toggle, sidebar
  always dark to match the branded dark chrome. Stripped the theme-light
  package, the AppRun theme-mode selection, the native host set-theme
  action, and the background set-theme handler. The native host now does
  one job (install updates). Verified the browser opens clean, dark, and
  consistent with no toggle. This closes the light/dark thread -- it is
  not a "not yet built" item, it's confirmed not achievable in a wrapper.

- **v0.12: pinned-site add/edit flow reworked** (2026-08-18). Per
  feedback the in-panel "Pin this page" / manual-URL controls were
  redundant. Now: the rail "+" grabs the current tab's URL and opens a
  dialog to edit it before saving (verified: dialog pre-fills
  `https://example.com/`, editable, Save). Saving adds it as a favicon in
  the rail and opens it in the panel (verified). Right-clicking a rail
  favicon shows a small Edit-URL / Remove menu. Fixed the reported
  off-screen popup: the menu now opens LEFTWARD from the cursor (the rail
  is on the right edge) and clamps to the panel viewport so it's always
  visible -- confirmed the menu renders on-screen after the fix. The
  Panels section is now just the display iframe plus an empty-state hint.

- **v0.13: back/forward/reload for pinned-site panels** (2026-08-18).
  Pinned sites load in a cross-origin iframe, and an extension CANNOT
  touch a cross-origin frame's history from outside (`contentWindow.history`
  throws) -- so naive back/forward buttons would silently do nothing.
  Solved it the right way: the content script (now `all_frames: true`, so
  it runs INSIDE the pinned page, same-origin to it) listens for a
  postMessage from the sidebar and runs `history.back()/forward()/
  location.reload()` there. The nav bar (back / forward / reload + host
  label) shows above an open pinned site. Verified end-to-end on a real
  display: navigated Cat -> Talk:Cat inside the panel, Back returned to
  Cat, Forward returned to Talk:Cat. Reload uses the same path so it
  keeps the in-frame position instead of jumping to the pinned URL.
  Origin-checked (only messages from our extension origin are honoured).

- **v0.14: LMB Shield -- built-in ad/tracker blocking** (2026-08-18).
  The user asked for "your own version of uBlock Origin ... that will block
  everything, same as Brave Shields or uBO," specifically the MV2 version.
  Investigated MV2 empirically on the bundled Chromium 151 and it's a hard
  dead end: sideloaded MV2 extensions are rejected outright ("Cannot install
  extension because it uses an unsupported manifest version"), even with
  `--allow-legacy-extension-manifests` AND the deprecation features disabled.
  The only MV2 re-enable is an enterprise managed policy in
  `/etc/chromium/policies/managed/` (root, per-machine) and Google is deleting
  it on the 2025 timeline anyway -- so building the blocker on MV2 would break
  the moment a user updates Chromium, violating the project's core
  "stays easily updatable" rule. Also found in the binary:
  "webRequestBlocking is only allowed for extensions ... installed using
  ExtensionInstallForcelist" -- another MV2 nail in the coffin.

  So Shield is built the future-proof way, folded into LMB's OWN extension
  (the user chose "build it into LMB itself" over bundling uBO Lite):
  - `tools/build-shield-rules.py` fetches EasyList + EasyPrivacy (GPLv3, the
    same lists uBO uses, from easylist.to -- never Google) and compiles their
    *network* filters into Chromium's native declarativeNetRequest static
    rulesets. DNR's `urlFilter` grammar was deliberately modelled on Adblock
    syntax (`||domain^`, `$third-party`, `$domain=`, `@@` exceptions), so the
    translation is faithful. ~106k rules compiled (49,868 block + 548 allow
    from EasyList; 54,974 + 833 from EasyPrivacy). Cosmetic `##` filters are
    skipped -- they don't map to DNR (element-hiding is a possible follow-up).
  - Rulesets declared `enabled:true` in `extension/manifest.json`
    (`declarative_net_request.rule_resources`), so blocking is ON from first
    launch with zero runtime cost -- the engine is native C++, not a JS add-on.
  - Verified on the real Chromium 151 + the REAL LMB manifest (which uses
    `declarativeNetRequestWithHostAccess`, not plain `declarativeNetRequest` --
    tested that static block rulesets still enable under it): no manifest/
    ruleset load errors; both rulesets enabled; and real ad/tracker requests
    (googlesyndication, doubleclick, google-analytics, googletagmanager,
    scorecardresearch) all matched block rules via getMatchedRules. All 106k
    rules fit -- `getAvailableStaticRuleCount` reported 223,777 remaining, so
    the static ceiling is ~330k with headroom to add uBO's own lists later.
  - Sidebar Settings has an "LMB Shield" on/off toggle (`shieldToggle`).
    `background.js` `setShield()` persists the choice and
    `applyShieldState()` re-applies it on every startup via
    `updateEnabledRulesets` (the manifest would otherwise re-enable). Verified
    the full cycle incl. a simulated restart: off persists and survives,
    on re-enables.
  - Auto-update: rulesets recompile on every build (`build.sh` runs the
    converter before bundling), so each LMB release ships fresh filters and
    rides the existing self-updater. The generated JSON (~11MB) is gitignored;
    a fresh clone must run the converter (build does this automatically). If
    the lists are briefly unreachable at build time, build.sh falls back to
    any rulesets already present rather than shipping an unblocked browser.

- **v0.14: removed "Gemini in Chrome" component extension** (2026-08-18).
  Chromium 151 ships Google Gemini as a built-in *component* extension
  (id `admccjkmockfdflocgggjfgdacdodkdf`) with a background service worker.
  It loads even with the `Glic`/`GlicIntegration`/`GeminiInChromeSidePanel`
  feature flags off (verified: still present). `--disable-component-extensions-
  with-background-pages` removes it. Checked it's surgical, not a blanket
  break: the built-in PDF viewer (also a component extension) still renders a
  test PDF with the switch on. Added to AppRun launch flags. Directly serves
  the "Google must be completely stripped" requirement.

- **v0.15: FIX -- v0.14 shield rulesets bricked the whole extension in the
  real AppImage** (2026-08-18). v0.14 loaded fine in every headless test but
  failed on the user's actual install: *"Failed to load extension from:
  /tmp/.mount_lmb_.../extension. easylist.json: Internal error while parsing
  rules."* -- and because a bad static ruleset fails the ENTIRE extension
  load, the whole sidebar went with it. Root cause: Chromium indexes DNR
  static rulesets into `<extension>/_metadata/generated_indexed_rulesets/`
  the first time the extension loads, but the AppImage's files sit on a
  read-only squashfs mount, so that write fails and the load aborts. Every
  test had used a writable temp dir via `--load-extension`, so it never
  surfaced. Reproduced deterministically by loading the extension from a
  `chmod a-w` directory -> exact same error. Fix: AppRun now copies the
  extension + theme into `$USER_DATA_DIR/runtime/` (writable) and loads from
  there, re-copying only when the bundled version changes. Verified: with a
  read-only source, loading from the writable copy has NO parse error, both
  rulesets enable, blocking works, and the indexed rulesets land in the
  copy's `_metadata/` while the source stays clean. The fixed manifest "key"
  keeps the extension ID stable across the path change, so pinned state /
  native-host origin / DNR session rules all still line up.
  NOTE: v0.14's in-app updater is dead (its background.js never loads), so
  affected users must MANUALLY download v0.15 -- the green-circle update
  can't rescue them.
  GAP to close: CI never load-tested the packaged extension, which is how a
  broken build shipped. Worth adding a headless "does the extension load
  from a read-only copy" smoke test to build.sh/CI.

- **v0.16: one-click update, sidebar auto-open, pinned toolbar icon, text
  expander, rail cleanup** (2026-08-18). All verified on the locally-built
  AppImage on an ISOLATED Xephyr + isolated $HOME (see testing rule below).
  - *One-click update.* Two real defects found and fixed. (1) The download
    id lived in a service-worker module variable; a 180MB download outlives
    the SW's ~30s idle kill, so the completion event compared against null
    and was ignored -- stuck on "downloading" forever ("it downloads, but
    that's about it"). Id now persisted in updateStatus. (2) The flow needed
    a second click after download (yellow->download, then blue->install)
    which nobody realises. Now autoInstall:true is set when the download
    starts and the completion handler calls installUpdate() itself.
    Verified live: ONE click on the yellow footer dot -> downloaded ->
    native host swapped the AppImage (md5 confirmed) -> browser restarted
    itself -> tabs restored -> sidebar auto-opened again.
  - *Sidebar auto-open on startup.* sidePanel.open() hard-requires a user
    gesture (verified: gestureless call throws) and Chromium never restores
    the panel across restarts (verified: opened panel, clean quit, relaunch
    -> gone; no Preferences key records it). Solution: manifest command
    Ctrl+Shift+L (_execute_action -> action.onClicked -> sidePanel.open),
    plus AppRun bundles xdotool + libxdo and presses the shortcut (XTEST =
    genuine gesture) once the window appears, twice 2.5s apart for the
    late-registration race. X11-only; graceful no-op on pure Wayland.
    Verified: fresh profile launch -> panel open with zero clicks; also
    reopens after the self-update relaunch.
  - *Toolbar icon pinned by default.* The seeded pref was WRONG: the real
    key on 151 is extensions.pinned_extensions (nested), not top-level
    pinned_extensions. Re-verified by pinning via the UI on a clean profile
    and diffing Preferences (the only change). Icon now pinned from first
    run.
  - *Rail cleanup.* Removed the redundant "Panels" tab (the pinned-site
    favicons ARE the panels UI); favicon click activates the panel view
    directly and the active favicon gets the highlight. Also fixed: the
    static rail-click binding used to include the "+" button (no
    data-panel), so clicking + deactivated every view.
  - *Text expander.* Snippets have an optional abbreviation ("ab#"); the
    content script expands it the moment it's typed in any input/textarea/
    contenteditable on any page (word-boundary guarded, longest-first,
    e.isTrusted-guarded against loops, storage.onChanged keeps the map
    fresh). Verified with real synthetic-keystroke typing: "ab#" ->
    full address, mid-sentence, in a page textarea.

- **TESTING RULE (learned the hard way): NEVER run QA browsers against the
  real profile.** AppRun uses $HOME/.config/lightmorphic-browser, so a test
  launch with the user's $HOME writes into their real profile -- a
  Wikipedia pin from v0.13 testing leaked into the user's browser this way.
  Always: `HOME=/tmp/<qa-dir> DISPLAY=:99 <appimage>` so profile, native
  host registration, Downloads, everything stays sandboxed.

- **v0.17: guaranteed search page at startup, leaked-pin auto-cleanup,
  expander discoverability** (2026-08-18). All three of the user's
  follow-up complaints, verified on the built AppImage in an isolated env.
  - *Search page at startup.* The stock-NTP redirect only helps when
    startup PRODUCES an NTP -- a session-restore launch (which every
    self-update restart is, and any "Restore pages?" launch) reopens the
    previous tabs and nothing else, so there was no LMB search page at
    the start. New ensureSearchPageTab() runs after the redirect pass on
    onStartup/onInstalled: if no tab is newtab/newtab.html, open one in
    the foreground. Verified: quit with example.com open, relaunch ->
    both example.com (restored) AND the LMB search page are present.
  - *Leaked-pin cleanup.* cleanupLeakedTestPin() removes exactly
    "https://en.wikipedia.org/wiki/Cat" from webPanels once (guarded by
    leakedPinCleaned flag) -- the URL a v0.13 dev test leaked into the
    user's real profile. Verified: seeded the leaked state, relaunched,
    webPanels came back empty. Right-click -> Remove also exists but the
    user shouldn't have to clean up our mess.
  - *Expander discoverability.* The user couldn't find the feature. The
    Snippets panel now has a heading ("Snippets & text expander"), an
    explainer with the 12# -> phone number example, and concrete
    placeholders. List rows show "12# → Phone". Verified the user's exact
    flow end-to-end WITH the real UI: created the snippet by clicking and
    typing in the panel, then typed "Call me on 12# thanks" in a webpage
    textarea -> "Call me on 07700 900123 thanks".
  - NOTE: content scripts (expander included) only exist in pages loaded
    AFTER the extension version that ships them -- tabs left open across
    an update keep the old script until reloaded.

- **v0.18: Shield levels + per-site pause, reliable boot, zombie-tab
  rescue, minimise** (2026-08-19). All verified on the built AppImage,
  isolated env, across a real restart.
  - *Root cause of "blocked by LMB" search page + Wikipedia surviving
    v0.17:* two independent bugs. (1) chrome.runtime.onStartup does NOT
    reliably fire for --load-extension extensions -- on the user's real
    install the sidebar ran v0.17 and the update alarm ticked, but none
    of the onStartup work (cleanup, search-page guarantee, shield
    re-apply) had executed; leakedPinCleaned was absent from storage.
    Boot work now runs from the SW's TOP LEVEL guarded by a
    chrome.storage.session flag ("once per browser launch" exactly --
    session storage dies with the browser). (2) The "blocked by LMB"
    page was a ZOMBIE: testMatchOutcome proved neither v0.16's nor
    v0.17's shipped rules match the newtab URL -- the tab was blocked
    once by an earlier transient list snapshot and session restore kept
    resurrecting the error page, while ensureSearchPageTab counted the
    corpse as "present". It now RELOADS + focuses an existing search
    tab (stateless page, reload is free) instead of trusting it.
  - *Structural guarantees against self-blocking:* the converter now
    gives typeless filters excludedResourceTypes:["main_frame"] -- uBO's
    own semantics (typeless filters never block top-level navigations;
    that needs an explicit $document). Also fixed: the old code could
    emit resourceTypes AND excludedResourceTypes together (invalid rule)
    for filters like $~image,script. Plus protectOwnUi(): a
    priority-1000000 session allow rule for chrome-extension://<our-id>/
    re-added every boot.
  - *Shield levels* (user request): Off / Essential (EasyPrivacy) /
    Balanced (default; + EasyList) / Strict (+ Fanboy's Annoyances --
    cookie pop-ups; new third ruleset, 4,168 network rules, manifest
    enabled:false, ~110k total). shieldLevel persisted; legacy
    shieldEnabled:false migrates to "off". Verified all four map to the
    right getEnabledRulesets sets and the level survives restart.
  - *Per-site pause:* shieldSiteExceptions hostname list; each gets a
    priority-900000 allowAllRequests session rule (requestDomains:[host],
    main_frame+sub_frame) -- uBO's per-site power switch. Session rules
    die on restart so boot re-adds them from the list; verified paused
    example.com survives restart.
  - *Shield UI:* own rail icon + panel (level radios, "This site" pause
    checkbox for the active tab, exceptions list with un-pause). The old
    buried Settings toggle is gone -- the user literally couldn't find
    it ("we also need an interface that I can't find").
  - *Minimise:* chevron at rail top -> window.close() collapses the
    panel; Ctrl+Shift+L / toolbar icon / next launch reopens. TRUE
    rail-only collapse is impossible: Chromium fixes the side panel's
    minimum width and gives extensions no width control; the native
    header (pin icon, X) is browser chrome and can't be altered.
  - *Sidebar live-updates* webPanels via storage.onChanged (cleanup is
    visible immediately even if the sidebar loaded first).

## Not yet built / verified

- Zero-click toolbar pinning — still correct-but-unreliable pre-seeded
  state (`pinned_extensions` is right, confirmed by diffing a manual
  pin, but doesn't reliably paint on first render). One manual pin click
  may still be needed the first time.
- "Chromium" branding in native UI surfaces (profile menu, About page,
  etc.) and a forced/un-unpinnable toolbar icon — confirmed not
  achievable without a real source-level Chromium fork; see above.
- Extensions-list sync (only bookmarks/settings/snippets collections are
  wired into the UI so far; `extensions` collection exists server-side
  but nothing populates it yet).
- Passphrase change / account recovery UX (by design there is no
  recovery, but there's no "forget this device" or multi-device
  re-login flow built yet beyond the existing-account login path).
- Update system downloads the new AppImage for real but can't self-apply
  it (swap the file + relaunch) — no native-messaging helper built yet
  to bridge that gap.

## Chromium version tracking

`.github/workflows/build.yml` polls the Chrome versionhistory API daily.
When the latest linux stable version differs from
`appimage/last-built-version.txt`, it rebuilds and publishes a new
release. Confirmed working end-to-end in CI (both before and after the
ungoogled-chromium detour, same underlying mechanism).
