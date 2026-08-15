# Lightmorphic Browser

Privacy-first browser built on [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium) &mdash; Chromium built from source with Google's integration patches (Safe Browsing pings, default Google search/sync, telemetry, API keys) stripped out, not stock Chromium with flags papering over what's still there.

- **No Google** &mdash; built on ungoogled-chromium, not stock Chromium.
- **End-to-end encrypted sync** &mdash; data is encrypted on-device before it
  reaches the sync server; even a compromised server can't read it. Use the
  hosted sync service or self-host your own.
- **Sidebar** &mdash; notes, pinned web panels, and bookmarks in a persistent
  side panel.
- **Quick paste** &mdash; right-click to insert a saved snippet or a recent
  clipboard item.
- **Proxied extension installs** &mdash; Chrome Web Store installs are
  proxied rather than talking to Google directly.
- Automatically tracks new ungoogled-chromium releases.

Linux first; more platforms planned.

## Repo layout

- `extension/` &mdash; the Manifest V3 extension that implements the sidebar,
  quick paste, and sync client. This is the core product.
- `appimage/` &mdash; packaging: wraps an
  [ungoogled-chromium-portablelinux](https://github.com/ungoogled-software/ungoogled-chromium-portablelinux)
  build with the extension pre-loaded, produces the Linux AppImage.
- `site/` &mdash; the landing page, served at browser.lightmorphic.co.uk via
  GitHub Pages.
- `docs/` &mdash; developer docs.

## Building

```bash
./appimage/build.sh <ungoogled-chromium-portablelinux release tag>   # e.g. 151.0.7922.137-1
```

CI (`.github/workflows/build.yml`) checks daily for new
ungoogled-chromium-portablelinux releases and rebuilds automatically when
one appears.

## Status

Early scaffold &mdash; see [docs/RUNBOOK.md](docs/RUNBOOK.md) for current
state and next steps.
