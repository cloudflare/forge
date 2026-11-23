#!/usr/bin/env python3
"""Fetch the OAI Overlay-Specification schema test corpus into this directory.

Argument: upstream commit SHA to pin to (written into .commit-sha).
"""
import json
import os
import subprocess
import sys
import urllib.request

SHA = sys.argv[1]
ROOT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(ROOT, exist_ok=True)
with open(os.path.join(ROOT, ".commit-sha"), "w") as f:
    f.write(SHA + "\n")

for v in ("v1.0", "v1.1", "v1.2-dev"):
    for kind in ("pass", "fail"):
        dst = os.path.join(ROOT, v, kind)
        os.makedirs(dst, exist_ok=True)
        api = (
            "repos/OAI/Overlay-Specification/contents/"
            f"tests/{v}/{kind}?ref={SHA}"
        )
        listing = json.loads(subprocess.check_output(["gh", "api", api]))
        for entry in listing:
            name = entry["name"]
            url = (
                f"https://raw.githubusercontent.com/OAI/Overlay-Specification/"
                f"{SHA}/tests/{v}/{kind}/{name}"
            )
            with urllib.request.urlopen(url) as resp:
                data = resp.read()
            with open(os.path.join(dst, name), "wb") as f:
                f.write(data)
        n = len(os.listdir(dst))
        print(f"{v}/{kind}: {n} files")
