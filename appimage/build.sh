#!/usr/bin/env bash
# Builds the Lightmorphic Browser AppImage by wrapping an official prebuilt
# Chromium build with our extension pre-loaded via managed policy.
#
# Usage: build.sh <chromium-version>   e.g. build.sh 131.0.6778.85
set -euo pipefail

CHROMIUM_VERSION="${1:?usage: build.sh <chromium-version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDIR="$ROOT/appimage/AppDir"
DIST="$ROOT/dist"

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

echo "==> Bundling extension"
cp -r "$ROOT/extension/." "$APPDIR/usr/share/lightmorphic-browser/extension/"

echo "==> Writing managed policy to force-load the extension"
mkdir -p "$APPDIR/usr/bin/policies/managed"
cat > "$APPDIR/usr/bin/policies/managed/lightmorphic.json" <<'JSON'
{
  "ExtensionInstallForcelist": [],
  "BrowserSignin": 0,
  "SyncDisabled": true
}
JSON

echo "==> Writing launcher"
cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "${0}")")"
# Extension installs are routed through the Lightmorphic Web Store proxy
# instead of talking to Google's gallery/update servers directly.
exec "$HERE/usr/bin/chromium/chrome" \
  --load-extension="$HERE/usr/share/lightmorphic-browser/extension" \
  --user-data-dir="${HOME}/.config/lightmorphic-browser" \
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

echo "$CHROMIUM_VERSION" > "$ROOT/appimage/last-built-version.txt"
echo "==> Done: dist/$FINAL_NAME"
