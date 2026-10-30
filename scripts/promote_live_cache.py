"""Promote one test room's recorded live responses into the committed replay fixtures (MEM-043 P1, ADR 0029).

Usage: uv run python scripts/promote_live_cache.py --room <room_id> [--dry-run]
Offline, no key. Copies from refs/private/live-cache/<method>/ into fixtures/replay/<method>/ only the
entries recorded for process_upload(fixtures/rooms/<room_id>.webp); never photos/, never another photo's
entry (private live runs share that cache, ADR 0017). Each copied file gets a fixtures/MANIFEST.md row;
existing rows are kept. A target with equal bytes is skipped; a target with different bytes -> stderr,
exit 1, nothing written. --dry-run prints the target paths and writes nothing.

Decision (Q23 default): an entry ties to the room through the backend, by the room photo's bytes. find_loci
replays the room's processed photo against the live cache and every entry it reads is the room's; cache file
names are key digests, so an entry this replay does not reach cannot be attributed and is not copied.
"""

import argparse
import datetime
import re
import sys
from pathlib import Path
from typing import Any

from memripal.backend import BackendCallFailed, FixtureBackend, ModelRequest
from memripal.imaging import process_upload
from memripal.loci import find_loci

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPO_ROOT / "fixtures"
LIVE_CACHE = REPO_ROOT / "refs" / "private" / "live-cache"
ROOM_ID = re.compile(r"[a-z0-9-]{1,32}")
LICENSE = "test fixture only (ADR 0029)"


class _Tracer(FixtureBackend):
    """Replays from the live cache, recording each entry read; a missing entry acts as a failed call."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.read: set[Path] = set()

    def call(self, req: ModelRequest) -> Any:
        path = self.cache.path_for(req.cache_key())
        if not path.is_file():
            raise BackendCallFailed(f"no recorded {req.method} response for room photo")
        self.read.add(path)
        return super().call(req)


def _room_entries(room: Path) -> list[Path]:
    """Sorted: SAM calls run on a thread pool, so read order is not deterministic.

    A room with no recorded first Spark entry raises BackendCallFailed out of find_loci (exit 1).
    """
    tracer = _Tracer(LIVE_CACHE)
    # A frozen clock keeps the deadline out of play, as in replay.
    find_loci(tracer, process_upload(room.read_bytes()), clock=lambda: 0.0)
    return sorted(tracer.read)


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

    plan = [(src, FIXTURES / "replay" / src.relative_to(LIVE_CACHE)) for src in _room_entries(room)]
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
