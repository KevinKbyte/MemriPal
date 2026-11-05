"""Regenerate static/fixtures/landmark_slots_kendall.json: the /loci reply for a landmark photo (MEM-141).

Runs /loci in-process and writes the reply as the slots page's bundled sample. Backend follows MEMRIPAL_MODE:
fixture mode (no live calls) by default; meta mode runs a live SAM segmentation and needs META_API_KEY.

Usage: uv run python scripts/gen_landmark_slots_fixture.py <photo> [--out PATH]
Live:  MEMRIPAL_MODE=meta META_API_KEY=<key> uv run python scripts/gen_landmark_slots_fixture.py \
         fixtures/demo/kendall_landmark.jpg
"""

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO / "static" / "fixtures" / "landmark_slots_kendall.json"
# Mirrors SLOT_COUNT in static/landmark_slots.js.
SLOT_COUNT = 3


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("photo", type=Path, help="JPEG/PNG/WebP photo to segment")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="JSON file to write")
    args = parser.parse_args(argv)
    try:
        data = args.photo.read_bytes()
    except OSError as exc:
        print(f"gen_landmark_slots_fixture: cannot read {args.photo}: {exc.strerror}", file=sys.stderr)
        return 1

    # Deferred: a missing photo fails fast without loading the app.
    from fastapi.testclient import TestClient

    from memripal.app import REPLAY_DIR, create_app
    from memripal.backend import MissingApiKey, select_backend

    try:
        backend = select_backend(None, REPLAY_DIR)
    except MissingApiKey as exc:
        print(f"gen_landmark_slots_fixture: {exc}", file=sys.stderr)
        return 1
    media = {".png": "image/png", ".webp": "image/webp"}.get(args.photo.suffix.lower(), "image/jpeg")
    client = TestClient(create_app(backend=backend), base_url="http://127.0.0.1")
    resp = client.post("/loci", content=data, headers={"Content-Type": media})
    if resp.status_code != 200:
        print(f"gen_landmark_slots_fixture: /loci returned {resp.status_code}", file=sys.stderr)
        return 1
    body = resp.json()
    count = len(body.get("loci", []))
    if count < SLOT_COUNT:
        print(f"gen_landmark_slots_fixture: only {count} loci", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
