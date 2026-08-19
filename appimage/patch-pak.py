#!/usr/bin/env python3
"""Rebrand Chromium's compiled .pak string resources without a source build.

Chromium's user-visible product strings ("Your Chromium", "Add Chromium
profile", the window title, etc.) are NOT compiled into the binary -- they
live in locales/*.pak, a simple documented archive format (version 5):

    uint32  version (must be 5)
    uint8   encoding, 3 bytes padding
    uint16  resource_count
    uint16  alias_count
    (uint16 resource_id, uint32 offset) x (resource_count + 1)   # +1 sentinel
    (uint16 resource_id, uint16 entry_index) x alias_count
    ...resource data...

Parsing and rewriting this is trivial compared to a 100GB+ source rebuild,
which is the only *other* way to change these strings. Only locale paks are
patched -- resources.pak contains WebUI HTML/JS where blind text replacement
could break actual code.

Replacements are ordered longest-first so "Google Chromium" style overlaps
can't produce double-substitutions.
"""

import struct
import sys
from pathlib import Path

REPLACEMENTS = [
    # --- Protection pass: phrases that must SURVIVE rebranding. The
    # about-page credit must keep saying "the Chromium open source
    # project" -- rebranding it to "the LMB open source project" made the
    # attribution false (and the user called it out). NOTE the string in
    # the pak contains markup: `...by the <a ...>Chromium</a> open source
    # project...`, so the anchor-split form must be protected too. Swap
    # to sentinels first, restore at the end.
    (b"Chromium</a> open source project", b"@@KEEP_OSP_LINKED@@"),
    (b"Chromium open source project", b"@@KEEP_CHROMIUM_OSP@@"),
    # --- Targeted full-phrase Google replacements for visible menu
    # items. Deliberately NOT a blanket "Google" -> "Lightmorphic" pass:
    # that would manufacture nonsense/false statements ("sign in to
    # Lightmorphic sites such as Gmail") in strings that factually
    # describe Google services. Only whole phrases that name UI surfaces
    # are rewritten.
    (b"You and Google", b"You and sync"),
    (b"Google services settings", b"Account services settings"),
    (b"Google Password Manager", b"Password Manager"),
    (b"Google services", b"Account services"),
    # Short form "LMB" everywhere per Charlie's naming call -- these are
    # menu items and inline sentences, not explanatory surfaces.
    (b"Google Chrome", b"LMB"),
    (b"Chromium", b"LMB"),
    # Bare "Chrome" appears in some strings ("Chrome preloads pages...").
    # Replace after the longer forms so it only catches leftovers.
    (b"Chrome", b"LMB"),
    # --- Restore protected phrases.
    (b"@@KEEP_OSP_LINKED@@", b"Chromium</a> open source project"),
    (b"@@KEEP_CHROMIUM_OSP@@", b"Chromium open source project"),
]


def patch_pak(path: Path) -> int:
    data = path.read_bytes()
    version, encoding = struct.unpack_from("<IB", data, 0)
    if version != 5:
        raise SystemExit(f"{path}: unsupported pak version {version}")
    resource_count, alias_count = struct.unpack_from("<HH", data, 8)

    entries = []  # (resource_id, offset)
    pos = 12
    for _ in range(resource_count + 1):
        rid, off = struct.unpack_from("<HI", data, pos)
        entries.append((rid, off))
        pos += 6
    aliases_raw = data[pos : pos + alias_count * 4]

    # Slice out each resource, patch it, rebuild with recomputed offsets.
    blobs = []
    changed = 0
    for i in range(resource_count):
        blob = data[entries[i][1] : entries[i + 1][1]]
        original = blob
        for old, new in REPLACEMENTS:
            blob = blob.replace(old, new)
        if blob != original:
            changed += 1
        blobs.append(blob)

    header = struct.pack("<IB3xHH", version, encoding, resource_count, alias_count)
    table_size = (resource_count + 1) * 6
    data_start = 12 + table_size + len(aliases_raw)

    table = b""
    offset = data_start
    for i in range(resource_count):
        table += struct.pack("<HI", entries[i][0], offset)
        offset += len(blobs[i])
    table += struct.pack("<HI", entries[resource_count][0], offset)

    path.write_bytes(header + table + aliases_raw + b"".join(blobs))
    return changed


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-pak.py <locales-dir>")
    locales = Path(sys.argv[1])
    paks = sorted(locales.glob("*.pak"))
    if not paks:
        raise SystemExit(f"no .pak files in {locales}")
    total = 0
    for pak in paks:
        total += patch_pak(pak)
    print(f"patched {len(paks)} locale paks, {total} resources changed")


if __name__ == "__main__":
    main()
