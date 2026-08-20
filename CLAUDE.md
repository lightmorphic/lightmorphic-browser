# Lightmorphic Browser — working notes for Claude

Chromium-based privacy browser shipped as a single AppImage. The product is
the **extension**; the AppImage is a thin wrapper around an official
open-source Chromium snapshot. Full history, rationale and per-version
verification notes live in `docs/RUNBOOK.md` — read it before changing
anything non-obvious, and append a new dated entry when you ship.

## Layout

| Path | What it is |
|---|---|
| `extension/` | The product: MV3 service worker, sidebar, newtab/search, shield, sync client |
| `theme/` | Separate theme package — must NOT be merged into the extension manifest |
| `appimage/` | `build.sh` wrapper + AppRun flags, updater, policies, vendored tools |
| `tools/build-shield-rules.py` | Compiles EasyList/EasyPrivacy into DNR rulesets (run by `build.sh`) |
| `site/` | GitHub Pages site (`.github/workflows/pages.yml`) |
| `VERSION` | Browser alpha version users see (e.g. `0.22`); Chromium version tracked separately |

## Build

```bash
appimage/build.sh <chromium-version>   # e.g. appimage/build.sh 151.0.7922.137
```

Release tags combine both versions: `v<VERSION>-<chromium-version>`.
`.github/workflows/build.yml` polls the Chrome versionhistory API daily and
rebuilds when it differs from `appimage/last-built-version.txt`.

## TESTING RULE — never QA against the real profile

AppRun derives the profile from `$HOME/.config/lightmorphic-browser`, so a
test launch with the real `$HOME` writes into the user's actual browser. This
has already happened once (a v0.13 test pinned Wikipedia into the real
profile). Every QA launch gets an isolated home:

```bash
DISPLAY=:99 HOME=/tmp/<qa-dir> ./dist/<AppImage> --no-sandbox --remote-debugging-port=94xx
```

Kill QA processes by matching `--user-data-dir=/tmp/<qa-dir>` **only** —
never a bare `pkill chromium`. Also in `docs/RUNBOOK.md`.

## Verify on the real build

Claims in the runbook are there because features were tested on the built
AppImage in an isolated env, across a real restart — not reasoned about. Keep
that bar: `chrome.runtime.onStartup` does not reliably fire for
`--load-extension` extensions, session restore resurrects error pages, and
content scripts only exist in tabs loaded after the version that ships them.
Several past bugs were invisible to inspection alone.

## Pushing

The `gh`-authenticated default token can read but 403s on any Contents:write
(`push: true` from `gh api .../permissions` is the account role, not the token
scope — it is misleading). Use the fine-grained token instead, without
exposing its value and without the broken credential helper:

```bash
cat > /tmp/askpass.sh <<'SH'
#!/bin/bash
case "$1" in
  *[Uu]sername*) echo "x-access-token";;
  *) cat /home/charlie/9-Claude/Tokens/lightmorphicbrowser-token;;
esac
SH
chmod +x /tmp/askpass.sh
GIT_ASKPASS=/tmp/askpass.sh GIT_TERMINAL_PROMPT=0 git -c credential.helper= push origin main
rm -f /tmp/askpass.sh
```
