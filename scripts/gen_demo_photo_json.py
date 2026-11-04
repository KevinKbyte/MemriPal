"""Regenerate static/assets/demo_photo.json: the base64 JSON string of fixtures/demo/photo.jpg (MEM-087).

Memorize sends these bytes for photo-less demo stations; the photo keys the /split replay fixture, so the
JSON must stay byte-exact to the JPEG. Stdlib only.

Usage: python scripts/gen_demo_photo_json.py [--in PATH] [--out PATH]
"""

import argparse
import base64
import json
import sys
from pathlib import Path

# Defaults resolve from the script's location, never the cwd.
REPO = Path(__file__).resolve().parents[1]
DEFAULT_IN = REPO / "fixtures" / "demo" / "photo.jpg"
DEFAULT_OUT = REPO / "static" / "assets" / "demo_photo.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--in", dest="src", type=Path, default=DEFAULT_IN, help="JPEG to encode")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="JSON file to write")
    args = parser.parse_args(argv)
    try:
        data = args.src.read_bytes()
    except OSError as exc:
        print(f"gen_demo_photo_json: cannot read {args.src}: {exc.strerror}", file=sys.stderr)
        return 1
    text = json.dumps(base64.b64encode(data).decode("ascii")) + "\n"
    # Bytes, not text mode: a Windows newline translation would break byte-equality with the committed file.
    args.out.write_bytes(text.encode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
