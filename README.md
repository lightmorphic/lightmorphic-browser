# Lightmorphic Browser

Privacy-first browser built on official open-source Chromium (not "Google Chrome" &mdash; the snapshot builds used here already lack Google's proprietary API keys/branding), hardened with our own privacy flags on top: background networking, sync, domain reliability, and phishing-detection pings all disabled by default. Deliberately not built on a third-party de-googling project &mdash; we own the hardening ourselves so it can't disappear if that project stops being maintained.

- **No Google by default** &mdash; background networking, sync, telemetry, and Safe Browsing pings all disabled at launch. See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the exact flags and the one known remaining gap (default search engine).
- **End-to-end encrypted sync** &mdash; data is encrypted on-device before it
  reaches the sync server; even a compromised server can't read it. Use the
  hosted sync service or self-host your own.
- **Sidebar** &mdash; notes, pinned web panels, bookmarks, and quick-paste
  snippets behind a Vivaldi-style icon rail.
- **Quick paste** &mdash; right-click to insert a saved snippet or a recent
  clipboard item.
- **Proxied extension installs** &mdash; Chrome Web Store installs are
  proxied rather than talking to Google directly.
- Automatically tracks new Chromium stable releases.

Linux first; more platforms planned.

## Repo layout

- `extension/` &mdash; the Manifest V3 extension that implements the sidebar,
  quick paste, and sync client. This is the core product.
- `appimage/` &mdash; packaging: wraps an official open-source Chromium
  build with our own privacy flags and the extension pre-loaded, produces
  the Linux AppImage.
- `site/` &mdash; the landing page, served at browser.lightmorphic.co.uk via
  GitHub Pages.
- `docs/` &mdash; developer docs.

## Building

```bash
./appimage/build.sh <chromium-version>   # e.g. 131.0.6778.85
```

CI (`.github/workflows/build.yml`) checks daily for new Chromium stable
releases and rebuilds automatically when one appears.

## Status

Early scaffold &mdash; see [docs/RUNBOOK.md](docs/RUNBOOK.md) for current
state and next steps.
