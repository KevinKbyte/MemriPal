"""Generate the 2D UI assets (app icon, empty-state illustration) with one image_edit each (MEM-038).

Usage: scripts/run_live.ps1 uv run python scripts/gen_assets.py [--out <dir>] [--dry-run]
The key comes ONLY from META_API_KEY (set by scripts/run_live.ps1); it is never read from a file.
Writes files only: wiring them into manifest.webmanifest / index.html is a separate change.
"""

import argparse
import os
import sys
from collections.abc import Callable
from io import BytesIO
from pathlib import Path

from PIL import Image

from memripal.meta_client import MetaClient, image_bytes, to_data_url

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "static" / "assets"

# Restyle = edit these constants and re-run; colors match icon.svg / theme_color.
STYLE = "flat 2D vector illustration, navy #1f3a5f and gold #f2b134 on plain white, no text"
ICON_PROMPT = f"An app icon: a simple house outline with three gold dots inside it. {STYLE}"
EMPTY_STATE_PROMPT = (
    f"An open doorway leading into an empty room with small numbered spots on the floor. {STYLE}"
)
ICON_SIDES = (512, 192)

# List order = call order; each entry is (name, prompt, output file names).
ASSETS = (
    ("icon", ICON_PROMPT, tuple(f"icon-{side}.png" for side in ICON_SIDES)),
    ("empty-state", EMPTY_STATE_PROMPT, ("empty-state.webp",)),
)


def _base_data_url() -> str:
    # MetaClient has no text-to-image, so every asset is an edit of a blank white canvas.
    buf = BytesIO()
    Image.new("RGB", (1024, 1024), (255, 255, 255)).save(buf, format="JPEG")
    return to_data_url(buf.getvalue())


def _icon_pngs(image: Image.Image) -> list[bytes]:
    side = min(image.size)
    left, top = (image.width - side) // 2, (image.height - side) // 2
    square = image.crop((left, top, left + side, top + side))
    outputs = []
    for size in ICON_SIDES:
        buf = BytesIO()
        square.resize((size, size), Image.Resampling.LANCZOS).save(buf, format="PNG")
        outputs.append(buf.getvalue())
    return outputs


def _render(name: str, body: bytes) -> list[bytes] | None:
    """Output bytes per file for one asset, or None when the body is not a decodable image."""
    try:
        data = image_bytes(body)
        image = Image.open(BytesIO(data))
        image.load()
    except (ValueError, KeyError, IndexError, TypeError, OSError):
        return None
    return _icon_pngs(image) if name == "icon" else [data]


def main(argv: list[str] | None = None, make_client: Callable[..., MetaClient] = MetaClient) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--dry-run", action="store_true", help="print the plan; no key, no calls, no writes")
    args = parser.parse_args(argv)
    out: Path = args.out

    if args.dry_run:
        for name, _prompt, files in ASSETS:
            print(f"{name}: " + " ".join(str(out / f) for f in files))
        print(f"calls: {len(ASSETS)}")
        return 0

    api_key = os.environ.get("META_API_KEY", "")
    if not api_key.strip():
        print("META_API_KEY is not set; launch via scripts/run_live.ps1", file=sys.stderr)
        return 2

    # Budget is exactly one paid call per asset, so the client never retries.
    client = make_client(api_key, max_retries=0)
    base = _base_data_url()
    failed = False
    for name, prompt, files in ASSETS:
        result = client.image_edit(image_data_url=base, prompt=prompt)
        outputs = _render(name, result.body) if result.ok else None
        if outputs is None:
            # Nothing is written for a failed asset, so its previous files stay as they were.
            print(f"{name}: failed ({result.error or 'bad_image'})", file=sys.stderr)
            failed = True
            continue
        out.mkdir(parents=True, exist_ok=True)
        for file_name, data in zip(files, outputs, strict=True):
            (out / file_name).write_bytes(data)
            print(str(out / file_name))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
