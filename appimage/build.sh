#!/usr/bin/env bash
# Builds the Lightmorphic Browser AppImage by wrapping an ungoogled-chromium
# portable Linux build (https://github.com/ungoogled-software/ungoogled-chromium-portablelinux)
# with our extension pre-loaded. ungoogled-chromium is Chromium built from
# source with every Google-integration patch stripped -- no Safe Browsing
# pings, no default Google search/sync/API keys, no telemetry -- rather
# than stock Chromium with flags papering over what's still baked in.
#
# Usage: build.sh <release-tag>   e.g. build.sh 151.0.7922.137-1
# The tag is ungoogled-chromium-portablelinux's own release tag (Chromium
# version + their patch-set revision, e.g. "-1"), not a bare Chromium
# version -- CI resolves this via that repo's own releases feed.
set -euo pipefail

RELEASE_TAG="${1:?usage: build.sh <ungoogled-chromium-portablelinux release tag, e.g. 151.0.7922.137-1>}"
CHROMIUM_VERSION="${RELEASE_TAG%-*}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDIR="$ROOT/appimage/AppDir"
DIST="$ROOT/dist"

rm -rf "$APPDIR/usr"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/lightmorphic-browser/extension" "$DIST"

echo "==> Fetching ungoogled-chromium ${RELEASE_TAG} (linux64)"
ASSET="ungoogled-chromium-${RELEASE_TAG}-x86_64_linux.tar.xz"
curl -sL "https://github.com/ungoogled-software/ungoogled-chromium-portablelinux/releases/download/${RELEASE_TAG}/${ASSET}" \
  -o "$ROOT/appimage/chromium.tar.xz"
tar -xJf "$ROOT/appimage/chromium.tar.xz" -C "$APPDIR/usr/bin"
mv "$APPDIR/usr/bin/ungoogled-chromium-${RELEASE_TAG}-x86_64_linux" "$APPDIR/usr/bin/chromium"

echo "==> Bundling extension"
cp -r "$ROOT/extension/." "$APPDIR/usr/share/lightmorphic-browser/extension/"

echo "==> Writing launcher"
cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "${0}")")"
EXT="$HERE/usr/share/lightmorphic-browser/extension"
USER_DATA_DIR="${HOME}/.config/lightmorphic-browser"
PROFILE_DIR="$USER_DATA_DIR/Default"

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
if [ ! -f "$PROFILE_DIR/Preferences" ]; then
  mkdir -p "$PROFILE_DIR"
  cat > "$PROFILE_DIR/Preferences" <<'PREFS'
{
  "pinned_extensions": ["hokpgjhmbdcggofdeaaobeknogcmlbfa"],
  "extensions": {
    "ui": {
      "developer_mode": true
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
exec "$HERE/usr/bin/chromium/chrome" \
  --load-extension="$EXT" \
  --disable-extensions-except="$EXT" \
  --user-data-dir="$USER_DATA_DIR" \
  --apps-gallery-url="https://webstore-proxy.lightmorphic.co.uk/webstore" \
  --apps-gallery-update-url="https://webstore-proxy.lightmorphic.co.uk/service/update2/crx" \
  --apps-gallery-download-url="https://webstore-proxy.lightmorphic.co.uk/crx/%s.crx" \
  "$@"
EOF
chmod +x "$APPDIR/AppRun"

cp "$ROOT/assets/icon-256.png" "$APPDIR/lightmorphic-browser.png"
cp "$ROOT/appimage/co.lightmorphic.browser.desktop" "$APPDIR/lightmorphic-browser.desktop"
mkdir -p "$APPDIR/usr/share/metainfo" "$APPDIR/usr/share/applications"
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
FINAL_NAME="Lightmorphic-Browser-${CHROMIUM_VERSION}-x86_64.AppImage"
BUILD_MARKER=$(mktemp)
(cd "$DIST" && ARCH=x86_64 VERSION="$CHROMIUM_VERSION" "$ROOT/appimage/appimagetool" "$APPDIR")
GENERATED=$(find "$DIST" -maxdepth 1 -name "*-${CHROMIUM_VERSION}-x86_64.AppImage" -newer "$BUILD_MARKER" | head -1)
rm -f "$BUILD_MARKER"
if [ -z "$GENERATED" ]; then
  echo "==> appimagetool did not produce an AppImage in $DIST" >&2
  exit 1
fi
mv "$GENERATED" "$DIST/$FINAL_NAME"
chmod +x "$DIST/$FINAL_NAME"

# Track the full release tag (not just the Chromium version), since
# ungoogled-chromium can ship a new patch-set revision (e.g. "-2") for
# the same underlying Chromium version -- that's a real update CI should
# still pick up.
echo "$RELEASE_TAG" > "$ROOT/appimage/last-built-version.txt"
echo "==> Done: dist/$FINAL_NAME"
