"""Run the one-shot Meta Model API live probe on a photo and save the report (MEM-008).

Usage: uv run python scripts/probe_live.py --photo <path> [--out <dir>] [--audio <wav>]
The key comes ONLY from META_API_KEY (set by scripts/run_live.ps1); it is never read from a file.
"""

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--photo", required=True, type=Path)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--audio", type=Path, default=None, help="mono 16-bit WAV, 16 or 24 kHz")
    args = parser.parse_args(argv)

    api_key = os.environ.get("META_API_KEY", "")
    if not api_key:
        print("META_API_KEY is not set; launch via scripts/run_live.ps1", file=sys.stderr)
        return 2
    if not args.photo.is_file():
        print(f"photo not found: {args.photo}", file=sys.stderr)
        return 2
    if args.audio is not None and not args.audio.is_file():
        print(f"audio not found: {args.audio}", file=sys.stderr)
        return 2

    # Imported after the key check so a misconfigured run fails fast with no side effects.
    from memripal.meta_client import MetaClient
    from memripal.probe import run_probe

    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    out_dir = args.out or REPO_ROOT / "fixtures" / "raw" / "probe" / stamp
    images: dict[str, bytes] = {}
    audio_wav = args.audio.read_bytes() if args.audio is not None else None
    report = run_probe(
        MetaClient(api_key), args.photo.read_bytes(), on_image=images.__setitem__, audio_wav=audio_wav
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    for name, data in images.items():
        (out_dir / f"{name}.webp").write_bytes(data)

    print(f"kept_count: {report['kept_count']}")
    print(json.dumps(report["checks"], indent=2))
    print(f"report: {out_dir / 'report.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
