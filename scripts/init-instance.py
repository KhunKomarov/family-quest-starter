"""Create credentials for a new family journal."""

import argparse
import json
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(".local/instance"))
    parser.add_argument("--device", action="append", default=[], metavar="NAME:tv|touch|car")
    parser.add_argument("--origin", help="HTTPS origin; omit for local browser preview")
    args = parser.parse_args()
    origin = args.origin.rstrip("/") if args.origin else None
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or (
            parsed.path or parsed.query or parsed.fragment
        ):
            parser.error("--origin must be an HTTPS origin without a path")

    modes = {}
    for item in args.device or ["tv:tv"]:
        name, _, mode = item.partition(":")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", name) or name in modes or mode not in ("tv", "touch", "car"):
            parser.error("device names must be unique and use NAME:tv, NAME:touch or NAME:car")
        modes[name] = mode
    os.umask(0o077)
    args.directory.mkdir(parents=True, exist_ok=True)
    if any(args.directory.iterdir()):
        parser.error("choose an empty directory so existing credentials are preserved")
    devices = {name: secrets.token_hex(32) for name in modes}
    codes = []
    while len(codes) < 2:
        code = f"{secrets.randbelow(1_000_000):06d}"
        if code not in codes:
            codes.append(code)
    parents = dict(zip(("Родитель 1", "Родитель 2"), codes))
    for name, data in (("devices.json", devices), ("parents.json", parents)):
        with (args.directory / name).open("x", encoding="utf-8") as file:
            json.dump(data, file, indent=2, ensure_ascii=False)
            file.write("\n")
    if origin:
        for name, mode in modes.items():
            with (args.directory / f"{name}.properties").open("x", encoding="utf-8") as file:
                file.write(f"endpoint={origin}/v2/sync\ntoken={devices[name]}\nmode={mode}\n")
    print(f"Created private configuration in {args.directory}")


if __name__ == "__main__":
    main()
