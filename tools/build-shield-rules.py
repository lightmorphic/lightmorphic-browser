#!/usr/bin/env python3
"""
LMB Shield rule compiler.

Converts Adblock-syntax filter lists (EasyList, EasyPrivacy, uBO's own
lists -- all GPLv3, the same lists uBlock Origin uses) into Chromium's
native declarativeNetRequest (DNR) static rulesets, which LMB's own
extension ships and enables by default.

Why this works: Chromium's DNR `urlFilter` grammar was deliberately
modelled on Adblock filter syntax -- it understands the `||` domain
anchor, the `^` separator, the `|` boundary anchor and `*` wildcards
directly. So the network-blocking half of these lists translates almost
one-to-one, giving genuinely uBO-grade network blocking without Manifest
V2 (which Chromium 151 refuses to load) and without any enterprise
policy or root install.

What is NOT translated here: cosmetic filters (`##selector`, element
hiding). Those don't map to DNR at all -- they're applied by a content
script (see contextmenu/element-hide.js) using the generic hide list.
This compiler only emits the *network* rules.

Output: extension/shield/rules/<name>.json, one file per source list,
each a JSON array of DNR rules with locally-unique integer ids. The
manifest's declarative_net_request.rule_resources block references them.

Run at build time (build.sh calls this) so shipped rulesets track the
upstream lists; a rebuilt/updated LMB carries refreshed lists.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "extension" / "shield" / "rules"

# Source lists. All GPLv3. Fetched from the lists' own homes, never Google.
SOURCES = [
    ("easylist",    "https://easylist.to/easylist/easylist.txt"),
    ("easyprivacy", "https://easylist.to/easylist/easyprivacy.txt"),
]

# Adblock resource-type option -> DNR resourceType.
TYPE_MAP = {
    "script": "script",
    "image": "image",
    "stylesheet": "stylesheet",
    "object": "object",
    "object-subrequest": "object",
    "xmlhttprequest": "xmlhttprequest",
    "xhr": "xmlhttprequest",
    "subdocument": "sub_frame",
    "ping": "ping",
    "beacon": "ping",
    "websocket": "websocket",
    "media": "media",
    "font": "font",
    "other": "other",
    "document": "main_frame",
    "webrtc": "webtransport",
}

# Options that mean "this rule does something DNR's block/allow can't
# express" -- we drop the whole rule rather than emit a wrong one.
UNSUPPORTED_OPTS = {
    "csp", "redirect", "redirect-rule", "removeparam", "removeheader",
    "popup", "popunder", "generichide", "elemhide", "genericblock",
    "specifichide", "inline-script", "inline-font", "empty", "mp4",
    "cname", "replace", "urltransform", "permissions", "webbundle",
    "badfilter", "header", "to", "method", "ipaddress", "referrerpolicy",
}

# urlFilter must be plain ASCII and use only characters DNR treats
# literally or as its known specials (|, ^, *). Regex-y punctuation here
# means it came from a pattern we can't faithfully render -> skip.
BAD_URLFILTER_CHARS = re.compile(r"[^\x21-\x7e]")


def parse_options(optstr):
    """Return (dnr_condition_bits, ok). ok=False -> drop this rule."""
    bits = {
        "resourceTypes": [],
        "excludedResourceTypes": [],
        "initiatorDomains": [],
        "excludedInitiatorDomains": [],
    }
    for opt in optstr.split(","):
        opt = opt.strip()
        if not opt:
            continue
        neg = opt.startswith("~")
        name = opt[1:] if neg else opt

        if name == "third-party":
            bits["domainType"] = "firstParty" if neg else "thirdParty"
        elif name == "match-case":
            bits["isUrlFilterCaseSensitive"] = True
        elif name in TYPE_MAP:
            key = "excludedResourceTypes" if neg else "resourceTypes"
            bits[key].append(TYPE_MAP[name])
        elif name.startswith("domain="):
            for d in name[len("domain="):].split("|"):
                d = d.strip().lower()
                if not d:
                    continue
                if d.startswith("~"):
                    bits["excludedInitiatorDomains"].append(d[1:])
                else:
                    bits["initiatorDomains"].append(d)
        elif name in ("important", "first-party", "1p", "3p", "strict1p",
                      "strict3p", "all", "popup=0"):
            # priority/scope hints DNR can't use precisely; ignore the
            # hint but keep the rule.
            continue
        elif name in UNSUPPORTED_OPTS:
            return None, False
        else:
            # Unknown option -> be conservative, drop the rule.
            return None, False
    return bits, True


def to_condition(pattern, bits):
    """Build a DNR condition dict, or None to skip."""
    if pattern.startswith("/") and pattern.endswith("/") and len(pattern) > 2:
        return None  # regex filter -- skipped for v1 (perf + validity risk)
    urlf = pattern
    if not urlf or urlf == "*":
        return None
    if BAD_URLFILTER_CHARS.search(urlf):
        return None
    cond = {"urlFilter": urlf}
    if bits.get("resourceTypes"):
        cond["resourceTypes"] = sorted(set(bits["resourceTypes"]))
    if bits.get("excludedResourceTypes"):
        cond["excludedResourceTypes"] = sorted(set(bits["excludedResourceTypes"]))
    if bits.get("domainType"):
        cond["domainType"] = bits["domainType"]
    if bits.get("initiatorDomains"):
        cond["initiatorDomains"] = sorted(set(bits["initiatorDomains"]))
    if bits.get("excludedInitiatorDomains"):
        cond["excludedInitiatorDomains"] = sorted(set(bits["excludedInitiatorDomains"]))
    if bits.get("isUrlFilterCaseSensitive"):
        cond["isUrlFilterCaseSensitive"] = True
    return cond


def convert(text):
    rules = []
    stats = {"block": 0, "allow": 0, "cosmetic": 0, "regex": 0, "unsup": 0,
             "bad": 0, "comment": 0}
    rid = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("!") or line.startswith("["):
            stats["comment"] += 1
            continue
        # Cosmetic filters -- not network rules, handled elsewhere.
        if ("##" in line or "#@#" in line or "#?#" in line
                or "#$#" in line or "#%#" in line):
            stats["cosmetic"] += 1
            continue

        is_exc = line.startswith("@@")
        if is_exc:
            line = line[2:]

        pattern, sep, optstr = line.partition("$")
        bits, ok = parse_options(optstr) if sep else ({}, True)
        if not ok:
            stats["unsup"] += 1
            continue
        cond = to_condition(pattern, bits or {})
        if cond is None:
            if pattern.startswith("/") and pattern.endswith("/"):
                stats["regex"] += 1
            else:
                stats["bad"] += 1
            continue

        rid += 1
        rules.append({
            "id": rid,
            # Exceptions must win, so give them the higher priority.
            "priority": 2 if is_exc else 1,
            "action": {"type": "allow" if is_exc else "block"},
            "condition": cond,
        })
        stats["allow" if is_exc else "block"] += 1
    return rules, stats


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "LMB-Shield-Builder"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_entries = []
    total = 0
    for name, url in SOURCES:
        print(f"==> {name}: fetching {url}")
        text = fetch(url)
        rules, stats = convert(text)
        out = OUT_DIR / f"{name}.json"
        out.write_text(json.dumps(rules, separators=(",", ":")))
        total += len(rules)
        print(f"    {name}: {len(rules)} DNR rules "
              f"(block={stats['block']} allow={stats['allow']} "
              f"| skipped: cosmetic={stats['cosmetic']} regex={stats['regex']} "
              f"unsupported={stats['unsup']} bad={stats['bad']})")
        manifest_entries.append({
            "id": name,
            "enabled": True,
            "path": f"shield/rules/{name}.json",
        })
    (OUT_DIR / "rulesets.index.json").write_text(
        json.dumps(manifest_entries, indent=2))
    print(f"==> total {total} rules across {len(SOURCES)} rulesets")
    print(f"==> manifest rule_resources written to {OUT_DIR/'rulesets.index.json'}")


if __name__ == "__main__":
    sys.exit(main())
