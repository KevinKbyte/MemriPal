"""Promote one test room's recorded live responses into the committed replay fixtures (MEM-043 P1, ADR 0029).

Usage: uv run python scripts/promote_live_cache.py --room <room_id> [--dry-run]
Offline, no key. Copies from refs/private/live-cache/<method>/ into fixtures/replay/<method>/ only the
entries recorded for process_upload(fixtures/rooms/<room_id>.webp), plus their sidecars; never photos/,
never another photo's entry (private live runs share that cache, ADR 0017). Each copied file gets a
fixtures/MANIFEST.md row; existing rows are kept. A target with equal bytes is skipped; a target with
different bytes -> stderr, exit 1, nothing written. --dry-run prints the target paths and writes nothing.

Decision (Kev Q23(ii)): an entry ties to the room by the write-time sidecar (<entry>.sha) MetaBackend wrote
next to it, naming the photo sha of its run; this covers every method (loci, re-ask, segment, notes,
associate). Cache file names are key digests, so an entry without a sidecar cannot be attributed: it is
skipped and the skip count goes to stderr.
"""

import argparse
import datetime
import re
import sys
from pathlib import Path

from memripal.backend import SIDECAR_SUFFIX, sidecar_path
from memripal.imaging import process_upload

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPO_ROOT / "fixtures"
LIVE_CACHE = REPO_ROOT / "refs" / "private" / "live-cache"
ROOM_ID = re.compile(r"[a-z0-9-]{1,32}")
LICENSE = "test fixture only (ADR 0029)"


def _room_entries(room: Path) -> tuple[list[Path], int]:
    """The room's entries and their sidecars (sorted), and the count of sidecarless entries skipped."""
    sha = process_upload(room.read_bytes()).sha
    picked: list[Path] = []
    skipped = 0
    for path in sorted(LIVE_CACHE.rglob("*")):
        rel = path.relative_to(LIVE_CACHE)
        # Skip photos/, sidecars (copied with their entry) and in-flight temp files.
        if not path.is_file() or rel.parts[0] == "photos" or path.name.endswith((SIDECAR_SUFFIX, ".tmp")):
            continue
        sidecar = sidecar_path(path)
        if not sidecar.is_file():
            skipped += 1
        elif sidecar.read_text(encoding="ascii", errors="replace").strip() == sha:
            picked += [path, sidecar]
    return sorted(picked), skipped


def _manifest_rows(rels: list[str], room_id: str, existing: str) -> list[str]:
    source = (
        f"live Meta responses for room {room_id}, promoted by scripts/promote_live_cache.py, "
        f"{datetime.date.today().isoformat()}"
    )
    return [f"| `{rel}` | {source} | {LICENSE} |" for rel in rels if f"| `{rel}` |" not in existing]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--room", required=True)
    parser.add_argument("--dry-run", action="store_true", help="print the target paths; write nothing")
    args = parser.parse_args(argv)
    # The id is validated before it builds any path, so no traversal reaches the filesystem.
    if not ROOM_ID.fullmatch(args.room):
        parser.error("--room must match ^[a-z0-9-]{1,32}$")
    room = FIXTURES / "rooms" / f"{args.room}.webp"
    if not room.is_file():
        print(f"no room file {room}", file=sys.stderr)
        return 1

    entries, skipped = _room_entries(room)
    if skipped:
        print(f"skipped {skipped} live-cache entries without a sidecar (not attributable)", file=sys.stderr)
    plan = [(src, FIXTURES / "replay" / src.relative_to(LIVE_CACHE)) for src in entries]
    conflicts = [dst for src, dst in plan if dst.is_file() and dst.read_bytes() != src.read_bytes()]
    if conflicts:
        for dst in conflicts:
            print(f"conflict: {dst} exists with different bytes", file=sys.stderr)
        return 1
    if args.dry_run:
        for _src, dst in plan:
            print(dst.relative_to(REPO_ROOT).as_posix() + (" skip" if dst.is_file() else ""))
        return 0

    for src, dst in plan:
        if not dst.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
            print(dst.relative_to(REPO_ROOT).as_posix())
    manifest = FIXTURES / "MANIFEST.md"
    existing = manifest.read_text(encoding="utf-8")
    rows = _manifest_rows([dst.relative_to(FIXTURES).as_posix() for _src, dst in plan], args.room, existing)
    # Untouched when every row exists, so a re-run changes nothing, not even an mtime.
    if rows:
        manifest.write_text("\n".join([*existing.splitlines(), *rows]) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
