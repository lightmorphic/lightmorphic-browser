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

## Not yet built

- Sidebar UI (notepad, web panels, bookmarks panel)
- Quick paste UI (context menu wiring, clipboard history storage)
- Sync client (encryption, protocol, conflict handling)
- Extension Web Store proxy
- Sync server (separate repo, via project-docker-kickoff)

## Chromium version tracking

`.github/workflows/build.yml` polls the Chrome versionhistory API daily.
When the latest linux stable version differs from
`appimage/last-built-version.txt`, it rebuilds and publishes a new release.

### Known issue: version string vs. snapshot build number

The versionhistory API returns a version string (e.g. `131.0.6778.85`),
but `build.sh` currently downloads from the Chromium continuous snapshot
archive, which is indexed by build number, not version string &mdash; so
the download URL in `build.sh` doesn't resolve as written. First build ran
2026-08-15 and failed here. Needs either: (a) resolving version string to
snapshot build number via the `position_from_release` lookup, or (b)
switching to a source that's indexed by version string directly.
