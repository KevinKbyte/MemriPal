"""Block commits of secret-shaped strings or EXIF-bearing images (MEM-004).

Usage: python scripts/precommit_scan.py <paths...>
Exit 1 with one stderr line per offending path; exit 0 when clean. Missing paths are ignored
(a staged deletion or rename source).
"""

import re
import sys
from pathlib import Path

SECRET_PATTERNS = [
    re.compile(rb"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"Bearer\s+[A-Za-z0-9._-]{20,}"),
    # Character class keeps this source file from matching its own pattern.
    re.compile(rb"Signatur[e]="),
    re.compile(rb"[?&]token="),
    re.compile(rb"META_API_KEY\s*=\s*['\"]?[^\s'\"]{8,}"),
]

# JPEG EXIF lives in an APP1 segment tagged Exif\0\0; PNG uses an eXIf chunk; WEBP an EXIF chunk
# whose payload usually starts with Exif.
EXIF_MARKERS = {
    ".jpg": (b"Exif\x00\x00",),
    ".jpeg": (b"Exif\x00\x00",),
    ".png": (b"Exif", b"eXIf"),
    ".webp": (b"Exif", b"EXIF"),
}


def find_problem(path: Path) -> str | None:
    data = path.read_bytes()
    for pattern in SECRET_PATTERNS:
        if pattern.search(data):
            return f"secret pattern {pattern.pattern.decode()!r}"
    for marker in EXIF_MARKERS.get(path.suffix.lower(), ()):
        if marker in data:
            return "image carries EXIF metadata"
    return None


def main(argv: list[str]) -> int:
    failed = False
    for arg in argv:
        path = Path(arg)
        if not path.is_file():
            continue
        problem = find_problem(path)
        if problem:
            print(f"precommit_scan: {path}: {problem}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
