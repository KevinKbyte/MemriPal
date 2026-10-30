"""Generate 3-5 hard test rooms with one Muse Image text-to-image call each (MEM-043, ADR 0029).

Usage: scripts/run_live.ps1 uv run python scripts/gen_room_fixtures.py [--out <dir>] [--dry-run]
The key comes ONLY from META_API_KEY (set by scripts/run_live.ps1); it is never read from a file.
Rooms are TEST FIXTURES ONLY: never demo content, README art, video footage or marketing.
An existing room file is skipped with no call, so committed bytes are never regenerated (the API has no seed).

Decision (Q23 default): this script writes each new room's row in <out>/../MANIFEST.md (path relative to the
manifest, e.g. `rooms/<room_id>.webp`), keeping every existing row; a skipped or failed room gets no new row.

make_variants(base) derives the offline intake variants (V1); they carry EXIF, so they are never committed.
"""

import argparse
import datetime
import os
import sys
from collections.abc import Callable
from io import BytesIO
from pathlib import Path

from PIL import Image

from memripal.meta_client import CallResult, MetaClient, image_bytes

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "fixtures" / "rooms"
MODEL = "muse-image-1.0"

# Shared suffix: a clean render would make the rooms too easy for the loci pipeline.
REALISM = (
    "Casual smartphone snapshot, not a clean render: slightly tilted framing, wide-angle lens distortion, "
    "mixed warm and cool light, blown-out windows, visible sensor grain, everyday clutter."
)

# List order = call order; each entry is (room_id, subject). room_id matches ^[a-z0-9-]{1,32}$.
ROOMS = (
    ("kitchen-dim", "A dim galley kitchen at dusk, dishes piled by the sink, one weak under-cabinet light"),
    ("living-cluttered", "A cluttered living room, toys, laundry and cables across the sofa, rug and floor"),
    ("bedroom-tilted", "A small bedroom shot with the phone tilted, an unmade bed, clothes piled on a chair"),
    ("hallway-window", "A narrow hallway ending in a bright window, shoes, bags and coats along the walls"),
)

LICENSE = "generated output, test fixture only (ADR 0029)"
# precommit_scan.py blocks a .webp carrying either marker, so such a body fails its room here.
EXIF_MARKERS = (b"Exif", b"EXIF")
_DECODE_ERRORS = (ValueError, KeyError, IndexError, TypeError, OSError)


def _prompt(subject: str) -> str:
    return f"{subject}. {REALISM}"


def _room_bytes(result: CallResult) -> bytes | None:
    """The returned image bytes unchanged, or None when the body is not a decodable EXIF-free image."""
    if not result.ok:
        return None
    try:
        data = image_bytes(result.body)
        with Image.open(BytesIO(data)) as image:
            image.load()
    except _DECODE_ERRORS:
        return None
    if any(marker in data for marker in EXIF_MARKERS):
        return None
    return data


def _add_manifest_row(out: Path, room_id: str) -> None:
    manifest = out.parent / "MANIFEST.md"
    rel = f"{out.name}/{room_id}.webp"
    source = (
        f"generated with Muse Image ({MODEL}) by scripts/gen_room_fixtures.py, room {room_id}, "
        f"{datetime.date.today().isoformat()}; test fixture only (ADR 0029)"
    )
    row = f"| `{rel}` | {source} | {LICENSE} |"
    # A row left behind by a deleted room file is replaced, so a path never gets two rows.
    lines = [line for line in manifest.read_text(encoding="utf-8").splitlines() if f"| `{rel}` |" not in line]
    manifest.write_text("\n".join([*lines, row]) + "\n", encoding="utf-8", newline="\n")


def _jpeg(image: Image.Image, *, quality: int = 90, exif: Image.Exif | None = None) -> bytes:
    buf = BytesIO()
    kwargs = {"exif": exif.tobytes()} if exif is not None else {}
    image.save(buf, format="JPEG", quality=quality, **kwargs)
    return buf.getvalue()


def _heic_header() -> bytes:
    # A bare ISO-BMFF ftyp box (size, "ftyp", major brand, minor version, compatible brands): enough for
    # intake to see a HEIC upload; real HEVC data is not needed to pin the bad_magic rejection.
    body = b"ftyp" + b"heic" + (0).to_bytes(4, "big") + b"mif1" + b"heic"
    return (len(body) + 4).to_bytes(4, "big") + body


def make_variants(base: bytes) -> dict[str, bytes]:
    """Six deterministic offline intake variants of one photo (V1); same input, same bytes."""
    with Image.open(BytesIO(base)) as opened:
        image = opened.convert("RGB")
    w, h = image.size

    # Orientation 6 tells readers to rotate 270 degrees, which undoes this 90-degree rotation.
    orientation = Image.Exif()
    orientation[0x0112] = 6
    gps = Image.Exif()
    gps[0x8825] = {1: "N", 2: (51.0, 30.0, 0.0), 3: "W", 4: (0.0, 7.0, 0.0)}

    scale = 6000 / max(w, h)
    oversize = image.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)
    crop_w, crop_h = min(w, h * 9 // 16), min(h, w * 16 // 9)
    left, top = (w - crop_w) // 2, (h - crop_h) // 2
    return {
        "orientation": _jpeg(image.transpose(Image.Transpose.ROTATE_90), exif=orientation),
        "gps": _jpeg(image, exif=gps),
        "heic": _heic_header(),
        "oversize": _jpeg(oversize, quality=85),
        "heavy-jpeg": _jpeg(image, quality=10),
        "aspect": _jpeg(image.crop((left, top, left + crop_w, top + crop_h))),
    }


def main(argv: list[str] | None = None, make_client: Callable[..., MetaClient] = MetaClient) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--dry-run", action="store_true", help="print the plan; no key, no calls, no writes")
    args = parser.parse_args(argv)
    out: Path = args.out

    if args.dry_run:
        missing = 0
        for room_id, _subject in ROOMS:
            path = out / f"{room_id}.webp"
            present = path.exists()
            missing += not present
            print(f"{room_id}: {path}" + (" skip" if present else ""))
        print(f"calls: {missing}")
        return 0

    api_key = os.environ.get("META_API_KEY", "")
    if not api_key.strip():
        print("META_API_KEY is not set; launch via scripts/run_live.ps1", file=sys.stderr)
        return 2

    # Budget is exactly one paid call per missing room, so the client never retries.
    client = make_client(api_key, max_retries=0)
    failed = False
    for room_id, subject in ROOMS:
        path = out / f"{room_id}.webp"
        if path.exists():
            print(f"{room_id}: skip {path}")
            continue
        result = client.image_generate(prompt=_prompt(subject), model=MODEL, output_format="webp")
        data = _room_bytes(result)
        if data is None:
            print(f"{room_id}: failed ({result.error or 'bad_image'})", file=sys.stderr)
            failed = True
            continue
        out.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        _add_manifest_row(out, room_id)
        print(str(path))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
