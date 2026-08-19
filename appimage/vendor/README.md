# Vendored binaries

`xdotool` + `libxdo.so.3` (Debian amd64 build of xdotool 3.20160805.1,
BSD-3-Clause) are vendored because GitHub Actions' apt mirrors hung two
consecutive release builds. They are only ever COPIED into the AppImage
(never executed at build time) and used at runtime by AppRun to auto-open
the sidebar (see build.sh).
