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

echo "==> Fetching Chromium ${CHROMIUM_VERSION} (linux64, position ${POSITION})"
curl -sL "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${POSITION}/chrome-linux.zip" \
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
cp "$ROOT/appimage/lightmorphic-browser.desktop" "$APPDIR/lightmorphic-browser.desktop"
mkdir -p "$APPDIR/usr/share/metainfo" "$APPDIR/usr/share/applications"
cp "$ROOT/appimage/co.lightmorphic.browser.appdata.xml" "$APPDIR/usr/share/metainfo/"
cp "$ROOT/appimage/lightmorphic-browser.desktop" "$APPDIR/usr/share/applications/"

echo "==> Packaging AppImage"
"$ROOT/appimage/appimagetool" "$APPDIR" \
  "$DIST/Lightmorphic-Browser-${CHROMIUM_VERSION}-x86_64.AppImage"

echo "$CHROMIUM_VERSION" > "$ROOT/appimage/last-built-version.txt"
echo "==> Done: dist/Lightmorphic-Browser-${CHROMIUM_VERSION}-x86_64.AppImage"
