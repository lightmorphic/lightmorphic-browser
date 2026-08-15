# Lightmorphic Browser

Privacy-first browser built on Chromium.

- **End-to-end encrypted sync** &mdash; data is encrypted on-device before it
  reaches the sync server; even a compromised server can't read it. Use the
  hosted sync service or self-host your own.
- **Sidebar** &mdash; notes, pinned web panels, and bookmarks in a persistent
  side panel.
- **Quick paste** &mdash; right-click to insert a saved snippet or a recent
  clipboard item.
- **Proxied extension installs** &mdash; Chrome Web Store installs are
  proxied rather than talking to Google directly.
- Built on official Chromium releases, automatically tracking upstream
  updates.

Linux first; more platforms planned.

## Repo layout

- `extension/` &mdash; the Manifest V3 extension that implements the sidebar,
  quick paste, and sync client. This is the core product.
- `appimage/` &mdash; packaging: wraps an official Chromium build with the
  extension pre-loaded via managed policy, produces the Linux AppImage.
- `site/` &mdash; the landing page, served at browser.lightmorphic.co.uk via
  GitHub Pages.
- `docs/` &mdash; developer docs.

## Building

```bash
./appimage/build.sh <chromium-version>
```

CI (`.github/workflows/build.yml`) checks daily for new Chromium stable
releases and rebuilds automatically when one appears.

## Status

Early scaffold &mdash; see [docs/RUNBOOK.md](docs/RUNBOOK.md) for current
state and next steps.
