"""Check that every MEM id is defined exactly once across the memripal spec cache (MEM-101).

Usage: uv run python scripts/spec_ids.py [spec.md...]
With no arguments, checks .claude/spec-cache/memripal/references/spec*.md. A definition is a line
starting `## MEM-NNN` (3+ digits; only the heading's first id counts). Prints one line per id defined
more than once, listing every <file>:<line> defining it; exits 1 on any duplicate, else 0.
"""

import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".claude" / "spec-cache" / "memripal" / "references"
DEFINITION = re.compile(r"^## (MEM-(\d{3,}))\b")


def duplicate_mem_errors(paths) -> list[str]:
    """One error per MEM id defined more than once, in ascending numeric id order."""
    sites: dict[str, list[str]] = defaultdict(list)
    numbers: dict[str, int] = {}
    for path in map(Path, paths):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            match = DEFINITION.match(line)
            if match:
                mem_id = match.group(1)
                sites[mem_id].append(f"{path.name}:{lineno}")
                numbers[mem_id] = int(match.group(2))
    return [
        f"{mem_id} defined {len(sites[mem_id])} times: {', '.join(sites[mem_id])}"
        for mem_id in sorted(sites, key=numbers.__getitem__)
        if len(sites[mem_id]) > 1
    ]


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    paths = [Path(arg) for arg in args] if args else sorted(CACHE.glob("spec*.md"))
    errors = duplicate_mem_errors(paths)
    for error in errors:
        print(error)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
