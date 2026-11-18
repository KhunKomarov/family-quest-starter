"""Generate the browser settings from the same file the journal uses."""

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sync'))
from configuration import validate_config, browser_config
SOURCE = ROOT / "config/family.json"
OUTPUT = ROOT / "web/family-config.js"


def read_config():
    return validate_config(json.loads(SOURCE.read_text(encoding="utf-8")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify generated browser settings")
    args = parser.parse_args()
    config = read_config()
    content = browser_config(config)
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != content:
            parser.exit(1, "Run python3 scripts/configure.py to regenerate browser settings.\n")
    else:
        OUTPUT.write_text(content, encoding="utf-8")
        for index in range(3, len(config['profiles'])):
            avatar = ROOT / 'web' / f'avatar-{index + 1}.png'
            if not avatar.exists():
                shutil.copyfile(ROOT / 'web' / f'avatar-{index % 3 + 1}.png', avatar)


if __name__ == "__main__":
    main()
