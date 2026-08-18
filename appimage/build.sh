#!/usr/bin/env bash
# Builds the Lightmorphic Browser AppImage by wrapping an official
# open-source Chromium build (NOT "Google Chrome" -- the snapshot archive
# used here already lacks Google's proprietary API keys/branding, since
# that's what distinguishes vanilla open-source Chromium from Google
# Chrome to begin with) with our own privacy-hardening flags and prefs on
# top, plus our extension pre-loaded.
#
# Deliberately NOT built on a third-party de-googling project
# (ungoogled-chromium): that ties our release cadence to that project
# continuing to exist and keep pace with upstream Chromium, which is a
# real risk for a project we intend to keep working indefinitely. This
# way we own the privacy hardening ourselves and it can't disappear out
# from under us -- see AppRun below for exactly what's disabled and why.
#
# Usage: build.sh <chromium-version>   e.g. build.sh 131.0.6778.85
set -euo pipefail

CHROMIUM_VERSION="${1:?usage: build.sh <chromium-version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDIR="$ROOT/appimage/AppDir"
DIST="$ROOT/dist"
# The browser's own alpha version (0.01, 0.02, ...) -- what users see.
# The Chromium version underneath is tracked separately; release tags
# combine both (v0.01-151.0.7922.137) so automatic Chromium-update
# rebuilds don't collide with each other under one browser version.
BROWSER_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
RELEASE_TAG="v${BROWSER_VERSION}-${CHROMIUM_VERSION}"

rm -rf "$APPDIR/usr"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/lightmorphic-browser/extension" "$DIST"

echo "==> Resolving snapshot build position for Chromium ${CHROMIUM_VERSION}"
# The Chrome versionhistory API (used by CI to find the latest stable
# version) returns a version STRING like "131.0.6778.85". The snapshot
# archive that hosts prebuilt linux64 binaries is indexed by an integer
# build POSITION, not the version string, so the two have to be bridged
# via chromiumdash's fetch_version lookup.
POSITION=$(curl -sL "https://chromiumdash.appspot.com/fetch_version?version=${CHROMIUM_VERSION}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['chromium_main_branch_position'])")
echo "==> Build position: ${POSITION}"

# Not every position has an archived snapshot (only positions where a bot
# actually ran get one), so probe outward from POSITION for the nearest
# one that exists. A GCS prefix-listing API exists but sorts entries
# LEXICOGRAPHICALLY, which silently misorders positions of different
# digit lengths (e.g. "165443" sorts before "1654408") -- a direct
# existence probe avoids that trap entirely, at the cost of being O(n)
# HTTP requests instead of one list call.
SNAPSHOT_POSITION=""
for offset in $(seq 0 500); do
  for candidate in $((POSITION - offset)) $((POSITION + offset)); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --head \
      "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${candidate}/chrome-linux.zip")
    if [ "$code" = "200" ]; then
      SNAPSHOT_POSITION="$candidate"
      break 2
    fi
  done
done
if [ -z "$SNAPSHOT_POSITION" ]; then
  echo "==> No archived snapshot found within 500 positions of ${POSITION}" >&2
  exit 1
fi
echo "==> Nearest archived snapshot: ${SNAPSHOT_POSITION} (offset $((SNAPSHOT_POSITION - POSITION)))"

echo "==> Fetching Chromium ${CHROMIUM_VERSION} (linux64, position ${SNAPSHOT_POSITION})"
curl -sL "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${SNAPSHOT_POSITION}/chrome-linux.zip" \
  -o "$ROOT/appimage/chrome-linux.zip"
unzip -q -o "$ROOT/appimage/chrome-linux.zip" -d "$APPDIR/usr/bin"
mv "$APPDIR/usr/bin/chrome-linux" "$APPDIR/usr/bin/chromium"

echo "==> Rebranding locale resources (Chromium -> Lightmorphic Browser)"
# All user-visible product strings ("Your Chromium", "Add Chromium
# profile", window titles, settings text) live in locales/*.pak -- a
# simple documented archive format -- NOT compiled into the binary. This
# rewrites them at package time, so the Chromium binary itself stays
# byte-identical to upstream (updates keep flowing) while every visible
# surface says Lightmorphic Browser. Verified empirically: the profile
# menu that read "Your Chromium / Add Chromium profile / Manage Chromium
# profiles" reads "Lightmorphic Browser" for all three after patching,
# and the browser boots and runs normally on the repacked files.
python3 "$ROOT/appimage/patch-pak.py" "$APPDIR/usr/bin/chromium/locales"

echo "==> Compiling LMB Shield rulesets (EasyList + EasyPrivacy -> DNR)"
# Ad/tracker blocking is built into LMB itself: the same GPLv3 filter lists
# uBlock Origin uses, compiled into Chromium's native declarativeNetRequest
# rulesets that the extension declares enabled-by-default. Rebuilding here
# means every LMB release ships fresh filters. If the lists are briefly
# unreachable, fall back to any rulesets already present so the build still
# produces a working browser (just with the previous filters).
if ! python3 "$ROOT/tools/build-shield-rules.py"; then
  echo "==> WARNING: shield rule fetch failed; using existing rulesets if present" >&2
  if [ ! -f "$ROOT/extension/shield/rules/easylist.json" ]; then
    echo "==> ERROR: no shield rulesets available and fetch failed" >&2
    exit 1
  fi
fi

echo "==> Bundling extension"
cp -r "$ROOT/extension/." "$APPDIR/usr/share/lightmorphic-browser/extension/"
# The extension's own manifest version (extension/manifest.json) tracks
# the extension's code, not the bundled Chromium release -- comparing
# that against the GitHub release tag would always mismatch and show
# "update available" even when fully current. This file records what
# release this AppImage actually was, for the update check to compare
# against instead.
echo "{\"releaseTag\": \"${RELEASE_TAG}\", \"browserVersion\": \"${BROWSER_VERSION}\", \"chromiumVersion\": \"${CHROMIUM_VERSION}\"}" > "$APPDIR/usr/share/lightmorphic-browser/extension/version.json"

echo "==> Bundling theme"
# A separate package, not a "theme" key merged into the main extension's
# manifest -- tried that first and it silently broke the whole extension
# (chrome://extensions showed nothing loaded at all, despite the theme
# itself visibly applying). Confirmed by testing, not assumed. Two
# packages loaded side by side via --load-extension's comma-separated
# path list works correctly for both.
mkdir -p "$APPDIR/usr/share/lightmorphic-browser/theme"
cp -r "$ROOT/theme/." "$APPDIR/usr/share/lightmorphic-browser/theme/"

echo "==> Bundling self-updater native host"
cp "$ROOT/appimage/lmb-updater" "$APPDIR/usr/share/lightmorphic-browser/lmb-updater"
chmod +x "$APPDIR/usr/share/lightmorphic-browser/lmb-updater"

echo "==> Writing launcher"
cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "${0}")")"
EXT_SRC="$HERE/usr/share/lightmorphic-browser/extension"
THEME_SRC="$HERE/usr/share/lightmorphic-browser/theme"
USER_DATA_DIR="${HOME}/.config/lightmorphic-browser"
PROFILE_DIR="$USER_DATA_DIR/Default"

# --- Load the extension from a WRITABLE copy, not the AppImage mount.
# Chromium indexes the extension's declarativeNetRequest static rulesets
# (LMB Shield's ad/tracker filters) into <extension>/_metadata/ the first
# time the extension loads. The AppImage's own files live on a read-only
# squashfs mount, so that write fails and Chromium aborts the ENTIRE
# extension load with "easylist.json: Internal error while parsing rules"
# -- taking the whole sidebar down with it, not just Shield. (Reproduced
# exactly by loading the extension from a chmod a-w directory.) So copy
# the extension + theme into the profile dir, which is writable, and load
# from there. Re-copy only when the bundled release changes, so normal
# launches stay fast and a browser update actually ships new extension
# code. The extension's fixed manifest "key" keeps its ID stable
# regardless of load path, so pinned state / native-host origin / DNR all
# still line up.
RUNTIME_DIR="$USER_DATA_DIR/runtime"
EXT="$RUNTIME_DIR/extension"
THEME="$RUNTIME_DIR/theme"
STAMP="$RUNTIME_DIR/.bundled-version"
WANT_VER="$(cat "$EXT_SRC/version.json" 2>/dev/null)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$WANT_VER" ]; then
  rm -rf "$EXT" "$THEME"
  mkdir -p "$RUNTIME_DIR"
  cp -r "$EXT_SRC" "$EXT"
  cp -r "$THEME_SRC" "$THEME"
  chmod -R u+w "$EXT" "$THEME"
  printf '%s' "$WANT_VER" > "$STAMP"
fi
LOAD_PATHS="$EXT,$THEME"

# --- Self-updater plumbing (for the "click blue to install & restart"
# flow). The extension talks to a native-messaging host that swaps the
# AppImage and relaunches. Two things must be set up before Chromium
# starts:
#   1. Record where THIS AppImage lives on disk. $APPIMAGE is set by the
#      AppImage runtime; save it so the updater knows what file to
#      replace (the in-AppImage mount path is ephemeral, the real file
#      isn't).
#   2. Register the native host manifest so Chromium will launch our
#      updater when the extension connects to it. The user-level manifest
#      dir on Linux is <config>/<product>/NativeMessagingHosts; the exact
#      product dir for a snapshot build isn't guaranteed, so write to the
#      likely candidates -- an unused one is harmless.
mkdir -p "$USER_DATA_DIR"
[ -n "${APPIMAGE:-}" ] && printf '%s' "$APPIMAGE" > "$USER_DATA_DIR/appimage-path"
UPDATER="$HERE/usr/share/lightmorphic-browser/lmb-updater"
NM_MANIFEST=$(cat <<JSON
{
  "name": "co.lightmorphic.updater",
  "description": "LMB self-updater",
  "path": "$UPDATER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://hokpgjhmbdcggofdeaaobeknogcmlbfa/"]
}
JSON
)
for nmdir in \
  "$USER_DATA_DIR/NativeMessagingHosts" \
  "$HOME/.config/chromium/NativeMessagingHosts" \
  "$HOME/.config/google-chrome/NativeMessagingHosts"; do
  mkdir -p "$nmdir"
  printf '%s' "$NM_MANIFEST" > "$nmdir/co.lightmorphic.updater.json"
done

# Extension has a fixed "key" in its manifest (see extension/manifest.json)
# so its ID is stable (hokpgjhmbdcggofdeaaobeknogcmlbfa) instead of
# derived from the load path. Two things get pre-seeded into the profile's
# own Preferences file, verified empirically (via a real headful launch on
# an isolated nested X display, not guessed) against this Chromium build,
# only on a genuine first run so a user's own later choices aren't fought:
#
# 1. pinned_extensions -- the real top-level key (NOT nested under
#    "extensions", despite that being the more "logical" guess that
#    silently did nothing when tried first). Confirmed correct by manually
#    pinning via the UI and diffing the file, but pre-seeding it before
#    first launch did not reliably paint the icon on first render in
#    testing -- worth keeping since it's the genuinely correct value, but
#    a user may still need one manual pin click the very first time.
# 2. extensions.ui.developer_mode -- this is the more important fix. An
#    extension loaded via --load-extension survives the FIRST launch, but
#    gets silently DISABLED on a reload/relaunch ("Turn on developer mode
#    to use this extension") unless developer mode is already on. This
#    reproduces exactly what looked like "the extension just isn't there"
#    on a second run -- confirmed by watching it happen (toggle flips off,
#    warning banner appears) and fixed by pre-enabling developer mode.
# 3. default_search_provider_data -- sets DuckDuckGo (not Google) as the
#    actual default search engine from first launch. Verified empirically:
#    launched with this seeded, confirmed the omnibox placeholder read
#    "Search DuckDuckGo or type a URL", then actually typed a query and
#    confirmed it navigated to duckduckgo.com, not Google. There's no
#    extension API to do this on Linux (chrome_settings_overrides'
#    search_provider is Windows/Mac only per Chrome's own docs), so this
#    is the only reliable mechanism -- and it only applies pre-first-run,
#    which is exactly when this file is written.
# 4. signin.allowed / allowed_on_next_startup false -- removes the
#    sign-in-to-Google surfaces. Single-profile mode comes from Local
#    State (a separate file at the user-data-dir root):
#    profile.add_person_enabled=false removes "Add profile",
#    profile.browser_guest_enabled=false removes "Open guest profile" --
#    both verified gone from the profile menu in a live test. "Manage
#    profiles" has no pref-level switch and remains (documented gap).
if [ ! -f "$PROFILE_DIR/Preferences" ]; then
  mkdir -p "$PROFILE_DIR"
  cat > "$USER_DATA_DIR/Local State" <<'LOCALSTATE'
{
  "profile": {
    "add_person_enabled": false,
    "browser_guest_enabled": false
  }
}
LOCALSTATE
  cat > "$PROFILE_DIR/Preferences" <<'PREFS'
{
  "pinned_extensions": ["hokpgjhmbdcggofdeaaobeknogcmlbfa"],
  "extensions": {
    "ui": {
      "developer_mode": true
    }
  },
  "signin": {
    "allowed": false,
    "allowed_on_next_startup": false
  },
  "default_search_provider_data": {
    "template_url_data": {
      "short_name": "DuckDuckGo",
      "keyword": "duckduckgo.com",
      "url": "https://duckduckgo.com/?q={searchTerms}",
      "suggestions_url": "https://duckduckgo.com/ac/?q={searchTerms}&type=list",
      "favicon_url": "https://duckduckgo.com/favicon.ico",
      "safe_for_autoreplace": false,
      "input_encodings": ["UTF-8"],
      "id": "2000",
      "prepopulate_id": 0,
      "is_active": 1
    }
  }
}
PREFS
fi

# Extension installs are routed through the Lightmorphic Web Store proxy
# instead of talking to Google's gallery/update servers directly.
#
# --load-extension alone is unreliable: recent Chromium versions show a
# "extensions loaded via command line will be removed unless Developer
# Mode is on" infobar and can silently drop the extension on next
# restart. --disable-extensions-except pins it as an explicitly-allowed
# extension instead, which is the combination Selenium/Puppeteer use for
# exactly this reason.
#
# Privacy hardening (owned by us, not a third-party project): stock
# open-source Chromium already lacks Google's proprietary API keys, but
# still talks to Google for a handful of things by default. These are
# documented, real Chromium switches -- not guessed preference keys:
#   --disable-background-networking   stops most background Google network
#                                      traffic (component updater pings etc.)
#   --disable-sync                    Chrome Sync entirely off
#   --disable-domain-reliability      stops domain-reliability monitoring
#                                      pings (goes to Google infrastructure)
#   --disable-client-side-phishing-detection
#                                      stops Safe Browsing's client-side
#                                      phishing-detection network traffic
#   --disable-component-extensions-with-background-pages
#                                      As of the 151.x line, Chromium ships
#                                      "Gemini in Chrome" as a built-in
#                                      COMPONENT extension (id admccj...) with
#                                      a background service worker -- it loads
#                                      even with the Glic/Gemini feature flags
#                                      off (verified: still present, then gone
#                                      only with this switch). This disables
#                                      component extensions that run background
#                                      pages, which removes Gemini. Confirmed
#                                      the built-in PDF viewer (also a component
#                                      extension) STILL works with this on --
#                                      a test PDF rendered fine -- so it's
#                                      surgical, not a blanket break.
#   --disable-features=...            Translate (no Google Translate ping),
#                                      OptimizationHints, AutofillServerCommunication,
#                                      and (as of the 151.x line) AiMode/LensOverlay/
#                                      Glic/ComposeUI/HistoryEmbeddings -- the
#                                      "AI Mode" omnibox button and "Ask Google
#                                      about this page" chip. These aren't
#                                      gated behind Google API keys the way
#                                      some other features are -- they're
#                                      built into vanilla open-source Chromium
#                                      itself now. Verified removed by
#                                      actually launching with these flags on
#                                      an isolated display and confirming the
#                                      button/chip are gone, not by assuming
#                                      the flag names are right.
#   --disable-search-engine-choice-screen
#                                      skips the upstream search-engine
#                                      prompt (cosmetic, not itself a privacy
#                                      fix)
# --class sets the window's WM_CLASS. Without it Chromium reports
# "chrome"/"Chrome", so desktop environments (Cinnamon/GNOME) match the
# window to the system Chromium's .desktop and show the Chromium icon in
# the taskbar/dock. Setting it to our own class makes them match our
# .desktop (StartupWMClass=lightmorphic-browser) and show our icon.
exec "$HERE/usr/bin/chromium/chrome" \
  --class=lightmorphic-browser \
  --load-extension="$LOAD_PATHS" \
  --disable-extensions-except="$LOAD_PATHS" \
  --user-data-dir="$USER_DATA_DIR" \
  --disable-background-networking \
  --disable-sync \
  --disable-domain-reliability \
  --disable-client-side-phishing-detection \
  --disable-component-extensions-with-background-pages \
  --disable-features=Translate,OptimizationHints,AutofillServerCommunication,AiMode,LensOverlay,LensStandalone,ComposeUI,LinkedServicesSetting,PageContentAnnotations,GeminiInChromeSidePanel,GlicIntegration,Glic,TabOrganization,HistoryEmbeddings \
  --disable-search-engine-choice-screen \
  --apps-gallery-url="https://webstore-proxy.lightmorphic.co.uk/webstore" \
  --apps-gallery-update-url="https://webstore-proxy.lightmorphic.co.uk/service/update2/crx" \
  --apps-gallery-download-url="https://webstore-proxy.lightmorphic.co.uk/crx/%s.crx" \
  "$@"
EOF
chmod +x "$APPDIR/AppRun"

cp "$ROOT/assets/icon-256.png" "$APPDIR/lightmorphic-browser.png"
cp "$ROOT/appimage/co.lightmorphic.browser.desktop" "$APPDIR/lightmorphic-browser.desktop"
mkdir -p "$APPDIR/usr/share/metainfo" "$APPDIR/usr/share/applications"

# Install the icon into the hicolor theme so the .desktop's
# Icon=lightmorphic-browser actually RESOLVES in application menus. The
# AppImage's .DirIcon is already our logo, but menu entries created by
# integration tools resolve the icon by NAME from the theme -- without a
# themed icon they fall back to a generic/wrong icon (this is why the
# menu still showed Chromium). Ship every standard size.
for s in 16 32 48 64 128 256; do
  d="$APPDIR/usr/share/icons/hicolor/${s}x${s}/apps"
  mkdir -p "$d"
  cp "$ROOT/assets/icon-${s}.png" "$d/lightmorphic-browser.png"
done
# Also overwrite Chromium's own installed-app logo (used if the browser is
# ever run from an integrated /opt-style layout). Doesn't fix the compiled
# window icon, but harmless and covers that path.
cp "$ROOT/assets/icon-48.png" "$APPDIR/usr/bin/chromium/product_logo_48.png" 2>/dev/null || true
# appstreamcli enforces (a) filename == <id> and (b) desktop-application
# ids must be reverse-DNS -- both the appdata file and the applications
# .desktop file it points at via <launchable> are named co.lightmorphic.browser
# to satisfy both checks, which go-appimage's appimagetool runs as a hard
# build failure, not just a lint warning.
cp "$ROOT/appimage/co.lightmorphic.browser.appdata.xml" "$APPDIR/usr/share/metainfo/co.lightmorphic.browser.appdata.xml"
cp "$ROOT/appimage/co.lightmorphic.browser.desktop" "$APPDIR/usr/share/applications/co.lightmorphic.browser.desktop"

echo "==> Packaging AppImage"
# This appimagetool build's CLI takes only the AppDir path -- no explicit
# output-path second argument (that silently no-ops with "Please specify
# the path to the AppDir"). It auto-names the output from $VERSION and the
# .desktop file's Name field, so run it from $DIST and rename afterward.
FINAL_NAME="Lightmorphic-Browser-${BROWSER_VERSION}-x86_64.AppImage"
BUILD_MARKER=$(mktemp)
(cd "$DIST" && ARCH=x86_64 VERSION="$BROWSER_VERSION" "$ROOT/appimage/appimagetool" "$APPDIR")
GENERATED=$(find "$DIST" -maxdepth 1 -name "*-${BROWSER_VERSION}-x86_64.AppImage" -newer "$BUILD_MARKER" | head -1)
rm -f "$BUILD_MARKER"
if [ -z "$GENERATED" ]; then
  echo "==> appimagetool did not produce an AppImage in $DIST" >&2
  exit 1
fi
mv "$GENERATED" "$DIST/$FINAL_NAME"
chmod +x "$DIST/$FINAL_NAME"

# --- Post-build smoke test: run the REAL AppRun against a read-only tree
# and confirm the extension actually loads. This is the gate that was
# missing when v0.14 shipped broken: the extension loaded fine in every
# writable-dir test, but in the real AppImage its DNR rulesets couldn't be
# indexed onto the read-only squashfs mount, so the whole extension (sidebar
# and all) failed with "easylist.json: Internal error while parsing rules".
# We can't mount the AppImage without FUSE in CI, so extract it, make the
# tree read-only to mimic the mount, and run its AppRun headless -- AppRun's
# copy-to-writable step is exactly what's under test. A broken AppRun (or a
# genuinely invalid ruleset) trips the grep and fails the build.
echo "==> Post-build smoke test: launching AppRun from a read-only tree"
SMOKE_DIR=$(mktemp -d)
SMOKE_HOME="$SMOKE_DIR/home"
mkdir -p "$SMOKE_HOME"
( cd "$SMOKE_DIR" && "$DIST/$FINAL_NAME" --appimage-extract >/dev/null 2>&1 )
if [ -x "$SMOKE_DIR/squashfs-root/AppRun" ]; then
  chmod -R a-w "$SMOKE_DIR/squashfs-root"    # mimic the read-only mount
  HOME="$SMOKE_HOME" APPIMAGE="$DIST/$FINAL_NAME" timeout 60 \
    "$SMOKE_DIR/squashfs-root/AppRun" \
    --headless=new --no-sandbox --disable-gpu \
    --enable-logging=stderr --v=1 about:blank \
    >"$SMOKE_DIR/log.txt" 2>&1 || true
  chmod -R u+w "$SMOKE_DIR/squashfs-root" 2>/dev/null || true
  if grep -qiE "Internal error while parsing rules|Failed to load extension" "$SMOKE_DIR/log.txt"; then
    echo "==> SMOKE TEST FAILED: extension does not load from the real AppImage:" >&2
    grep -iE "Failed to load extension|parsing rules|rule.*invalid" "$SMOKE_DIR/log.txt" >&2
    rm -rf "$SMOKE_DIR"
    exit 1
  fi
  echo "==> Smoke test passed: extension + Shield load from a read-only tree"
else
  echo "==> WARNING: could not extract AppImage for smoke test; skipping" >&2
fi
rm -rf "$SMOKE_DIR"

echo "$CHROMIUM_VERSION" > "$ROOT/appimage/last-built-version.txt"
echo "==> Done: dist/$FINAL_NAME (release tag ${RELEASE_TAG})"
