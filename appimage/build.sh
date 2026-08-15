#!/usr/bin/env bash
# Builds the Lightmorphic Browser AppImage by wrapping an official prebuilt
# Chromium build with our extension pre-loaded via managed policy.
#
# Usage: build.sh <chromium-version>
set -euo pipefail

CHROMIUM_VERSION="${1:?usage: build.sh <chromium-version>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDIR="$ROOT/appimage/AppDir"
DIST="$ROOT/dist"

rm -rf "$APPDIR/usr"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/lightmorphic-browser/extension" "$DIST"

echo "==> Fetching Chromium ${CHROMIUM_VERSION} (linux64)"
# Snapshot builds come from the Chromium continuous archive; stable channel
# builds are pulled by version via the omahaproxy/versionhistory APIs in CI.
curl -sL "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/${CHROMIUM_VERSION}/chrome-linux.zip" \
  -o "$ROOT/appimage/chrome-linux.zip"
unzip -q -o "$ROOT/appimage/chrome-linux.zip" -d "$APPDIR/usr/bin"
mv "$APPDIR/usr/bin/chrome-linux" "$APPDIR/usr/bin/chromium"

echo "==> Bundling extension"
cp -r "$ROOT/extension/." "$APPDIR/usr/share/lightmorphic-browser/extension/"

echo "==> Writing managed policy to force-load the extension"
mkdir -p "$APPDIR/usr/bin/policies/managed"
cat > "$APPDIR/usr/bin/policies/managed/lightmorphic.json" <<EOF
{
  "ExtensionInstallForcelist": [],
  "BrowserSignin": 0
}
EOF

echo "==> Writing launcher"
cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "${0}")")"
exec "$HERE/usr/bin/chromium/chrome" \
  --load-extension="$HERE/usr/share/lightmorphic-browser/extension" \
  --user-data-dir="${HOME}/.config/lightmorphic-browser" \
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
